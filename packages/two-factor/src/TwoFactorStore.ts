// @awthaq/two-factor — TwoFactorStore
//
// THS-001 step 3, BCR-002, THS-005 (BEH-EA-264/265): this plugin's own persistence — two records
// services, each with a `layerMemory` and a `layerSql`, and the migrations for the two tables.
// Built directly against `effect/unstable/sql`'s `SqlSchema` (the table belongs to the plugin, not
// the shared stratum), with row codecs from the ambient client's dialect (`SqlModels.dialectFields`).
//
// - `two_factor_secret`: one row per user. `secret` is a `SealedColumn` (plan 05, ADR-EA-019 decision
//   6, ADR-EA-020): an `Encryption` envelope under `two_factor_secret:<userId>:secret`, never the
//   base32 secret, handed out as a `Sealed` value that opens where a code is checked (a secret
//   sealed under the older `two_factor_secret:<userId>` AAD, or under a retired encryption key,
//   re-seals on read by compare-and-swap); `confirmedAt` is NULL until the first valid code (an abandoned
//   `enable` never becomes an active factor); `lastUsedStep` is the replay guard — the last TOTP
//   step accepted, advanced by a compare-and-set (`advanceLastUsedStep`) so two concurrent
//   verifications of one code cannot both succeed (RFC 6238 §5.2, THS-005).
// - `two_factor_recovery_code`: one row per code, hashed (`codeHash` is a PHC string from the
//   `PasswordHasher` port), `usedAt` NULL until spent. `replaceAll` swaps the whole set in one
//   transaction and `markUsed` is a single compare-and-set, so regenerating never leaves a window
//   with no valid set and a code cannot be spent twice (BCR-002).
//
// No foreign keys (the schema has none — every table keyed by a user id has an erasure
// contribution instead), so `deleteAllByUser` is what account erasure calls.

import { Migrations, Users } from "@awthaq/core";
import { Defects, type Encryption, PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { Models as SqlModels, SealedColumn, StoreFailure } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

type UserId = Users.UserId;

// ---- the secret ----------------------------------------------------------------------

export interface SecretRecord {
  readonly userId: UserId;
  /** The sealed base32 secret (AES-256-GCM, AAD bound to the user and the column) — open it where a code is checked. */
  readonly secret: SealedColumn.Sealed<string>;
  /** `None` until the first valid code: an unconfirmed secret is never an active factor. */
  readonly confirmedAt: Option.Option<DateTime.Utc>;
  /** The last TOTP step accepted; that step and every earlier one are refused (THS-005). */
  readonly lastUsedStep: Option.Option<bigint>;
  readonly createdAt: DateTime.Utc;
}

/** The sealed `secret` column. The legacy AAD (`two_factor_secret:<userId>`) still opens, then re-seals canonically. */
export const secretColumn = SealedColumn.column({
  table: "two_factor_secret",
  column: "secret",
  key: "userId",
  legacyAad: [(userId) => `two_factor_secret:${userId}`],
});

export interface TwoFactorSecretsShape {
  readonly find: (
    userId: UserId,
  ) => Effect.Effect<Option.Option<SecretRecord>, StoreFailure.StoreUnavailable>;
  /**
   * Stores a *pending* secret, replacing an earlier unconfirmed one. `false` (nothing written)
   * when the user already has a confirmed secret — disable it first. One atomic statement.
   */
  readonly upsertPending: (
    userId: UserId,
    secret: Redacted.Redacted<string>,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /**
   * Marks the pending secret confirmed and records the step of the code that proved it (so that
   * very code cannot be replayed at sign-in). `false` when there is no unconfirmed row — a
   * concurrent confirm won.
   */
  readonly confirm: (
    userId: UserId,
    step: bigint,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /**
   * THS-005: compare-and-set of `lastUsedStep` — succeeds only if `step` is later than the stored
   * one (or none is stored). `false` means the step was already spent: a replay, or a concurrent
   * verification of the same code that lost the race.
   */
  readonly advanceLastUsedStep: (
    userId: UserId,
    step: bigint,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /** `true` when a row existed. */
  readonly delete: (userId: UserId) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
}

export class TwoFactorSecrets extends Context.Service<TwoFactorSecrets, TwoFactorSecretsShape>()(
  "awthaq/two-factor/TwoFactorSecrets",
) {}

// ---- the recovery codes ----------------------------------------------------------------

export interface RecoveryCodeRecord {
  readonly id: string;
  readonly codeHash: Redacted.Redacted<PasswordHasher.PhcHash>;
}

export interface TwoFactorRecoveryCodesShape {
  /** BCR-002: replaces the user's whole set in one transaction — a failure leaves the old set intact. */
  readonly replaceAll: (
    userId: UserId,
    hashes: ReadonlyArray<PasswordHasher.PhcHash>,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  readonly listUnused: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<RecoveryCodeRecord>, StoreFailure.StoreUnavailable>;
  /** Single-use: `true` only for the caller that spends an unused code (compare-and-set on `usedAt IS NULL`). */
  readonly markUsed: (
    userId: UserId,
    id: string,
  ) => Effect.Effect<boolean, StoreFailure.StoreUnavailable>;
  /** BCR-002: what a client shows as "n recovery codes left". */
  readonly countUnused: (userId: UserId) => Effect.Effect<number, StoreFailure.StoreUnavailable>;
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
}

export class TwoFactorRecoveryCodes extends Context.Service<
  TwoFactorRecoveryCodes,
  TwoFactorRecoveryCodesShape
>()("awthaq/two-factor/TwoFactorRecoveryCodes") {}

// ---- layerMemory -----------------------------------------------------------------------

/** A secret as the memory adapter keeps it: the sealed column is the envelope string, like a SQL row. */
interface StoredSecret extends Omit<SecretRecord, "secret"> {
  readonly secret: string;
}

/**
 * A test seam of `layerSecretsMemory`: the stored envelope of the sealed column, and a way to overwrite it
 * (`TestAuth.runSealedColumnTests` needs to look at, and plant, what is at rest; over SQL that is a statement).
 */
export class MemoryEnvelopes extends Context.Service<
  MemoryEnvelopes,
  {
    readonly stored: (userId: UserId) => Effect.Effect<string>;
    readonly plant: (userId: UserId, stored: string) => Effect.Effect<void>;
  }
>()("awthaq/two-factor/TwoFactorStore/MemoryEnvelopes") {}

// The explicit types on the secrets layers are the narrow exception the plugins document (TS2883):
// declaration emit cannot name `Encryption` through the sealed-column codec's requirement.
export const layerSecretsMemory: Layer.Layer<
  TwoFactorSecrets | MemoryEnvelopes,
  never,
  Encryption.Encryption
> = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* Ref.make(HashMap.empty<UserId, StoredSecret>());

    /** Persists a re-seal only while the row still holds the envelope that was read. */
    const swap: SealedColumn.Swap = (rowKey, stored, fresh) =>
      Ref.modify(state, (rows) => {
        const existing = HashMap.get(rows, Users.UserId(rowKey));
        if (Option.isNone(existing) || existing.value.secret !== stored) {
          return [false, rows] as const;
        }
        return [
          true,
          HashMap.set(rows, existing.value.userId, { ...existing.value, secret: fresh }),
        ] as const;
      });
    const secretCodec = yield* SealedColumn.codec(secretColumn, swap);
    const toRecord = (row: StoredSecret): SecretRecord => ({
      ...row,
      secret: secretCodec.sealed(row.userId, row.secret),
    });

    const find: TwoFactorSecretsShape["find"] = (userId) =>
      Ref.get(state).pipe(Effect.map((rows) => Option.map(HashMap.get(rows, userId), toRecord)));

    const upsertPending: TwoFactorSecretsShape["upsertPending"] = (userId, secret) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const envelope = yield* secretCodec.seal(userId, secret);
        return yield* Ref.modify(state, (rows) => {
          const existing = HashMap.get(rows, userId);
          if (Option.isSome(existing) && Option.isSome(existing.value.confirmedAt)) {
            return [false, rows] as const;
          }
          const record: StoredSecret = {
            userId,
            secret: envelope,
            confirmedAt: Option.none(),
            lastUsedStep: Option.none(),
            createdAt: now,
          };
          return [true, HashMap.set(rows, userId, record)] as const;
        });
      });

    const confirm: TwoFactorSecretsShape["confirm"] = (userId, step) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(state, (rows) => {
          const existing = HashMap.get(rows, userId);
          if (Option.isNone(existing) || Option.isSome(existing.value.confirmedAt)) {
            return [false, rows] as const;
          }
          return [
            true,
            HashMap.set(rows, userId, {
              ...existing.value,
              confirmedAt: Option.some(now),
              lastUsedStep: Option.some(step),
            }),
          ] as const;
        });
      });

    const advanceLastUsedStep: TwoFactorSecretsShape["advanceLastUsedStep"] = (userId, step) =>
      Ref.modify(state, (rows) => {
        const existing = HashMap.get(rows, userId);
        if (Option.isNone(existing) || Option.isNone(existing.value.confirmedAt)) {
          return [false, rows] as const;
        }
        const last = existing.value.lastUsedStep;
        if (Option.isSome(last) && last.value >= step) return [false, rows] as const;
        return [
          true,
          HashMap.set(rows, userId, { ...existing.value, lastUsedStep: Option.some(step) }),
        ] as const;
      });

    const del: TwoFactorSecretsShape["delete"] = (userId) =>
      Ref.modify(state, (rows) =>
        HashMap.has(rows, userId)
          ? ([true, HashMap.remove(rows, userId)] as const)
          : ([false, rows] as const),
      );

    const secrets = { find, upsertPending, confirm, advanceLastUsedStep, delete: del };
    const envelopes = MemoryEnvelopes.of({
      stored: (userId) =>
        Effect.map(Ref.get(state), (rows) =>
          Option.match(HashMap.get(rows, userId), {
            onNone: () => "",
            onSome: (row) => row.secret,
          }),
        ),
      plant: (userId, stored) =>
        Ref.update(state, (rows) =>
          Option.match(HashMap.get(rows, userId), {
            onNone: () => rows,
            onSome: (row) => HashMap.set(rows, userId, { ...row, secret: stored }),
          }),
        ),
    });
    return Context.make(TwoFactorSecrets, secrets).pipe(Context.add(MemoryEnvelopes, envelopes));
  }),
);

interface MemoryCode {
  readonly id: string;
  readonly userId: UserId;
  readonly codeHash: PasswordHasher.PhcHash;
  readonly usedAt: Option.Option<DateTime.Utc>;
}

export const layerRecoveryCodesMemory: Layer.Layer<TwoFactorRecoveryCodes, never, Crypto.Crypto> =
  Layer.effect(
    TwoFactorRecoveryCodes,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const state = yield* Ref.make<ReadonlyArray<MemoryCode>>([]);

      const replaceAll: TwoFactorRecoveryCodesShape["replaceAll"] = (userId, hashes) =>
        Effect.gen(function* () {
          const fresh: Array<MemoryCode> = [];
          for (const codeHash of hashes) {
            fresh.push({
              id: yield* crypto.randomUUIDv7.pipe(
                Effect.catch(StoreFailure.storeUnavailable("TwoFactorRecoveryCodes.replaceAll")),
              ),
              userId,
              codeHash,
              usedAt: Option.none(),
            });
          }
          // One `Ref.update`: the swap is atomic, so a reader sees the old set or the new one.
          yield* Ref.update(state, (rows) => [
            ...rows.filter((row) => row.userId !== userId),
            ...fresh,
          ]);
        });

      const listUnused: TwoFactorRecoveryCodesShape["listUnused"] = (userId) =>
        Ref.get(state).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.userId === userId && Option.isNone(row.usedAt))
              .map((row) => ({ id: row.id, codeHash: Redacted.make(row.codeHash) })),
          ),
        );

      const markUsed: TwoFactorRecoveryCodesShape["markUsed"] = (userId, id) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* Ref.modify(state, (rows) => {
            const target = rows.find(
              (row) => row.id === id && row.userId === userId && Option.isNone(row.usedAt),
            );
            if (target === undefined) return [false, rows] as const;
            return [
              true,
              rows.map((row) => (row.id === id ? { ...row, usedAt: Option.some(now) } : row)),
            ] as const;
          });
        });

      const countUnused: TwoFactorRecoveryCodesShape["countUnused"] = (userId) =>
        Ref.get(state).pipe(
          Effect.map(
            (rows) =>
              rows.filter((row) => row.userId === userId && Option.isNone(row.usedAt)).length,
          ),
        );

      const deleteAllByUser: TwoFactorRecoveryCodesShape["deleteAllByUser"] = (userId) =>
        Ref.update(state, (rows) => rows.filter((row) => row.userId !== userId));

      return { replaceAll, listUnused, markUsed, countUnused, deleteAllByUser };
    }),
  );

// ---- layerSql --------------------------------------------------------------------------

const makeSecretRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    userId: Schema.String,
    secret: Schema.String,
    confirmedAt: Schema.OptionFromNullOr(wire.dateTime),
    lastUsedStep: Schema.OptionFromNullOr(Schema.Int),
    createdAt: wire.dateTime,
  });

const makeCodeRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    userId: Schema.String,
    codeHash: Schema.String,
    usedAt: Schema.OptionFromNullOr(wire.dateTime),
    createdAt: wire.dateTime,
  });

export const layerSecretsSql: Layer.Layer<
  TwoFactorSecrets,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  TwoFactorSecrets,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const SecretRow = makeSecretRow(wire);
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`TwoFactorSecrets.${operation}`);
    const secretCodec = yield* SealedColumn.codec(
      secretColumn,
      yield* SealedColumn.sqlSwap(secretColumn),
    );

    const toRecord = (row: typeof SecretRow.Type): SecretRecord => ({
      userId: Users.UserId(row.userId),
      secret: secretCodec.sealed(row.userId, row.secret),
      confirmedAt: row.confirmedAt,
      lastUsedStep: Option.map(row.lastUsedStep, (step) => BigInt(step)),
      createdAt: row.createdAt,
    });

    const findQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SecretRow,
      execute: (userId) => sql`SELECT * FROM two_factor_secret WHERE "userId" = ${userId}`,
    });

    // One atomic statement: insert, or replace the row only while it is still unconfirmed.
    const upsertPendingQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: Schema.String,
        secret: Schema.String,
        createdAt: wire.dateTime,
      }),
      Result: SecretRow,
      execute: (r) => sql`
          INSERT INTO two_factor_secret ("userId", secret, "confirmedAt", "lastUsedStep", "createdAt")
          VALUES (${r.userId}, ${r.secret}, NULL, NULL, ${r.createdAt})
          ON CONFLICT("userId") DO UPDATE SET
            secret = excluded.secret,
            "lastUsedStep" = NULL,
            "createdAt" = excluded."createdAt"
          WHERE two_factor_secret."confirmedAt" IS NULL
          RETURNING *
        `,
    });

    const confirmQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: Schema.String,
        step: Schema.Int,
        now: wire.dateTime,
      }),
      Result: SecretRow,
      execute: (r) => sql`
          UPDATE two_factor_secret
          SET "confirmedAt" = ${r.now}, "lastUsedStep" = ${r.step}
          WHERE "userId" = ${r.userId} AND "confirmedAt" IS NULL
          RETURNING *
        `,
    });

    // THS-005: the compare-and-set — only a strictly later step advances it.
    const advanceQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: Schema.String, step: Schema.Int }),
      Result: SecretRow,
      execute: (r) => sql`
          UPDATE two_factor_secret
          SET "lastUsedStep" = ${r.step}
          WHERE "userId" = ${r.userId}
            AND "confirmedAt" IS NOT NULL
            AND ("lastUsedStep" IS NULL OR "lastUsedStep" < ${r.step})
          RETURNING *
        `,
    });

    const deleteQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: SecretRow,
      execute: (userId) =>
        sql`DELETE FROM two_factor_secret WHERE "userId" = ${userId} RETURNING *`,
    });

    const find: TwoFactorSecretsShape["find"] = (userId) =>
      findQuery(userId).pipe(Effect.map(Option.map(toRecord)), unavailable("find"));

    const upsertPending: TwoFactorSecretsShape["upsertPending"] = (userId, secret) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const envelope = yield* secretCodec.seal(userId, secret);
        const written = yield* upsertPendingQuery({
          userId,
          secret: envelope,
          createdAt: now,
        });
        return Option.isSome(written);
      }).pipe(unavailable("upsertPending"));

    const confirm: TwoFactorSecretsShape["confirm"] = (userId, step) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* confirmQuery({ userId, step: Number(step), now });
        return Option.isSome(updated);
      }).pipe(unavailable("confirm"));

    const advanceLastUsedStep: TwoFactorSecretsShape["advanceLastUsedStep"] = (userId, step) =>
      advanceQuery({ userId, step: Number(step) }).pipe(
        Effect.map(Option.isSome),
        unavailable("advanceLastUsedStep"),
      );

    const del: TwoFactorSecretsShape["delete"] = (userId) =>
      deleteQuery(userId).pipe(Effect.map(Option.isSome), unavailable("delete"));

    return { find, upsertPending, confirm, advanceLastUsedStep, delete: del };
  }),
);

export const layerRecoveryCodesSql: Layer.Layer<
  TwoFactorRecoveryCodes,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(
  TwoFactorRecoveryCodes,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const CodeRow = makeCodeRow(wire);
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`TwoFactorRecoveryCodes.${operation}`);

    const insertQuery = SqlSchema.void({
      Request: Schema.Struct({
        id: Schema.String,
        userId: Schema.String,
        codeHash: Schema.String,
        createdAt: wire.dateTime,
      }),
      execute: (r) => sql`
        INSERT INTO two_factor_recovery_code (id, "userId", "codeHash", "usedAt", "createdAt")
        VALUES (${r.id}, ${r.userId}, ${r.codeHash}, NULL, ${r.createdAt})
      `,
    });

    const listUnusedQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: CodeRow,
      execute: (userId) => sql`
        SELECT * FROM two_factor_recovery_code
        WHERE "userId" = ${userId} AND "usedAt" IS NULL
        ORDER BY id
      `,
    });

    const markUsedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, userId: Schema.String, now: wire.dateTime }),
      Result: CodeRow,
      execute: (r) => sql`
        UPDATE two_factor_recovery_code SET "usedAt" = ${r.now}
        WHERE id = ${r.id} AND "userId" = ${r.userId} AND "usedAt" IS NULL
        RETURNING *
      `,
    });

    const countQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ remaining: Schema.Int }),
      execute: (userId) => sql`
        SELECT CAST(COUNT(*) AS INTEGER) AS remaining FROM two_factor_recovery_code
        WHERE "userId" = ${userId} AND "usedAt" IS NULL
      `,
    });

    const replaceAll: TwoFactorRecoveryCodesShape["replaceAll"] = (userId, hashes) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const rows: Array<{ id: string; codeHash: string }> = [];
        for (const codeHash of hashes) {
          rows.push({
            id: yield* crypto.randomUUIDv7.pipe(
              Effect.catch(StoreFailure.storeUnavailable("TwoFactorRecoveryCodes.replaceAll")),
            ),
            codeHash,
          });
        }
        // BCR-002: delete-then-insert as one transaction, so a failure part-way keeps the old set.
        yield* SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            yield* sql`DELETE FROM two_factor_recovery_code WHERE "userId" = ${userId}`;
            for (const row of rows) {
              yield* insertQuery({ id: row.id, userId, codeHash: row.codeHash, createdAt: now });
            }
          }),
        ).pipe(unavailable("replaceAll"));
      });

    const listUnused: TwoFactorRecoveryCodesShape["listUnused"] = (userId) =>
      listUnusedQuery(userId).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            // The trust boundary: a stored column is a `PhcHash` by construction (only `replaceAll` writes it).
            codeHash: Redacted.make(PasswordHasher.PhcHash(row.codeHash)),
          })),
        ),
        unavailable("listUnused"),
      );

    const markUsed: TwoFactorRecoveryCodesShape["markUsed"] = (userId, id) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* markUsedQuery({ id, userId, now }).pipe(
          Effect.map(Option.isSome),
          unavailable("markUsed"),
        );
      });

    const countUnused: TwoFactorRecoveryCodesShape["countUnused"] = (userId) =>
      countQuery(userId).pipe(
        Effect.map((row) => row.remaining),
        unavailable("countUnused"),
      );

    const deleteAllByUser: TwoFactorRecoveryCodesShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM two_factor_recovery_code WHERE "userId" = ${userId}`.pipe(
        unavailable("deleteAllByUser"),
        Effect.asVoid,
      );

    return { replaceAll, listUnused, markUsed, countUnused, deleteAllByUser };
  }),
);

// ---- migrations ------------------------------------------------------------------------

/**
 * Append-only (never reorder or edit a shipped entry). `"lastUsedStep"` is an INTEGER: a TOTP
 * step is `floor(epochSeconds / 30)`, ~6e7 today and under 2^31 for another two thousand years,
 * so it decodes as a plain number on both dialects (a Postgres BIGINT would arrive as a string).
 * Every camelCase column is quoted in every statement, so Postgres's case folding cannot split
 * a migration from the queries above.
 */
export const migrations: Migrations.Migrations = [
  {
    name: "create_two_factor_secret",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE two_factor_secret (
            "userId" TEXT PRIMARY KEY,
            secret TEXT NOT NULL,
            "confirmedAt" TIMESTAMPTZ,
            "lastUsedStep" INTEGER,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE two_factor_secret (
            "userId" TEXT PRIMARY KEY,
            secret TEXT NOT NULL,
            "confirmedAt" TEXT,
            "lastUsedStep" INTEGER,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_two_factor_recovery_code",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE two_factor_recovery_code (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "codeHash" TEXT NOT NULL,
            "usedAt" TIMESTAMPTZ,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE two_factor_recovery_code (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "codeHash" TEXT NOT NULL,
            "usedAt" TEXT,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_two_factor_recovery_code_user_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX two_factor_recovery_code_user_id ON two_factor_recovery_code("userId")`,
        sqlite: () =>
          sql`CREATE INDEX two_factor_recovery_code_user_id ON two_factor_recovery_code("userId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];
