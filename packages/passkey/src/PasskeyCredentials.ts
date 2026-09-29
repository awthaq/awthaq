// @awthaq/passkey — PasskeyCredentials
//
// spec/behaviors/17-passkey.md, BEH-EA-130/134. This plugin's own
// persistence for the `passkey_credential` table (ticket 06) — a real
// `Model.Class` built directly against `effect/unstable/schema`'s `Model`
// and `effect/unstable/sql`'s `SqlSchema`, the same primitives
// `@awthaq/sql`'s own `Models.ts`/`Repositories.ts` are built from, not
// imported from that package: this table belongs to the plugin, not the
// shared persistence stratum.
//
// A credential's own WebAuthn credential id (base64url, globally unique by
// construction — WebAuthn ceremony ids are already random) is this table's
// primary key directly; no separate internal row id exists to keep in sync
// with it.
//
// Two `Layer`s over the same `PasskeyCredentialsShape` — `layerMemory` and
// `layerSql` — the same pattern every other domain concept in this
// codebase (`Users`, `Accounts`, `Sessions`, `Verification`) already
// follows, so this plugin's own `AuthComposition.test.ts`/`Passkey.test.ts`
// can compose entirely in memory the same way `@awthaq/password`'s do.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Users } from "@awthaq/core";

type UserId = Users.UserId;

export interface PasskeyCredentialRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly webauthnUserId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly deviceType: "singleDevice" | "multiDevice";
  readonly backedUp: boolean;
  readonly transports: ReadonlyArray<string>;
  readonly aaguid: string;
  readonly name: string;
  readonly createdAt: DateTime.Utc;
  readonly lastUsedAt: DateTime.Utc;
  /** WPS-006: when a signature-counter regression (a possibly cloned authenticator) was last observed on this credential; `None` if never. */
  readonly counterAnomalyAt: Option.Option<DateTime.Utc>;
  readonly counterAnomalyCount: number;
}

export class PasskeyCredentialNotFound extends Data.TaggedError("PasskeyCredentialNotFound")<{
  readonly message: string;
}> {}

/** WPS-010: a credential id is globally unique (it is the table's primary key) — both layers refuse a second `create` for it identically instead of one overwriting and the other dying. */
export class PasskeyCredentialAlreadyExists extends Data.TaggedError(
  "PasskeyCredentialAlreadyExists",
)<{
  readonly message: string;
}> {}

export interface PasskeyCredentialsShape {
  readonly create: (input: {
    readonly id: string;
    readonly userId: UserId;
    readonly webauthnUserId: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly deviceType: "singleDevice" | "multiDevice";
    readonly backedUp: boolean;
    readonly transports: ReadonlyArray<string>;
    readonly aaguid: string;
    readonly name: string;
  }) => Effect.Effect<PasskeyCredentialRecord, PasskeyCredentialAlreadyExists>;
  readonly findById: (id: string) => Effect.Effect<Option.Option<PasskeyCredentialRecord>>;
  readonly listByUser: (userId: UserId) => Effect.Effect<ReadonlyArray<PasskeyCredentialRecord>>;
  /**
   * BEH-EA-131: updates the counter/backup-state/last-used timestamp after a
   * successful authentication. The stored counter only ever moves forward
   * (CB-004): a regressed assertion counter never lowers it, so a clone
   * replaying old values keeps tripping the anomaly check.
   */
  readonly recordUsage: (
    id: string,
    counter: number,
    backedUp: boolean,
  ) => Effect.Effect<void, PasskeyCredentialNotFound>;
  /** Enumeration-safe by construction: fails identically for an unknown id and for one belonging to another user. */
  readonly rename: (
    id: string,
    userId: UserId,
    name: string,
  ) => Effect.Effect<PasskeyCredentialRecord, PasskeyCredentialNotFound>;
  /** Enumeration-safe by construction: fails identically for an unknown id and for one belonging to another user. */
  readonly delete: (id: string, userId: UserId) => Effect.Effect<void, PasskeyCredentialNotFound>;
  /** WPS-006: records a counter regression on the credential — stamps `counterAnomalyAt` and bumps `counterAnomalyCount`. */
  readonly flagCounterAnomaly: (id: string) => Effect.Effect<void, PasskeyCredentialNotFound>;
  /** CSG-001/DRS-002 (.issues/high): sweeps every credential owned by `userId` in one bulk statement — the erasure cascade's own `Hooks.BeforeUserDelete` tap needs (`Passkey.ts`'s own `layer`), unlike `delete`'s single-id, enumeration-safe shape. */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void>;
}

export class PasskeyCredentials extends Context.Service<
  PasskeyCredentials,
  PasskeyCredentialsShape
>()("awthaq/passkey/PasskeyCredentials") {}

// ---- layerMemory ----------------------------------------------------------

type CredentialsState = HashMap.HashMap<string, PasskeyCredentialRecord>;

export const layerMemory: Layer.Layer<PasskeyCredentials> = Layer.effect(
  PasskeyCredentials,
  Effect.gen(function* () {
    const state = yield* Ref.make<CredentialsState>(HashMap.empty());

    const alreadyExists = (): PasskeyCredentialAlreadyExists =>
      new PasskeyCredentialAlreadyExists({ message: "awthaq: passkey credential already exists" });

    const create: PasskeyCredentialsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const record: PasskeyCredentialRecord = {
        ...input,
        createdAt: now,
        lastUsedAt: now,
        counterAnomalyAt: Option.none(),
        counterAnomalyCount: 0,
      };
      const outcome = yield* Ref.modify(
        state,
        (
          s,
        ): readonly [
          Result.Result<PasskeyCredentialRecord, PasskeyCredentialAlreadyExists>,
          CredentialsState,
        ] =>
          HashMap.has(s, record.id)
            ? ([Result.fail(alreadyExists()), s] as const)
            : ([Result.succeed(record), HashMap.set(s, record.id, record)] as const),
      );
      return yield* Effect.fromResult(outcome);
    });

    const findById: PasskeyCredentialsShape["findById"] = (id) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));

    const listByUser: PasskeyCredentialsShape["listByUser"] = (userId) =>
      Ref.get(state).pipe(
        Effect.map((s) => Array.from(HashMap.values(s)).filter((row) => row.userId === userId)),
      );

    const notFound = (): PasskeyCredentialNotFound =>
      new PasskeyCredentialNotFound({ message: "awthaq: no such passkey credential" });

    const recordUsage: PasskeyCredentialsShape["recordUsage"] = (id, counter, backedUp) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<void, PasskeyCredentialNotFound>, CredentialsState] => {
            const existing = HashMap.get(s, id);
            if (Option.isNone(existing)) return [Result.fail(notFound()), s] as const;
            const updated: PasskeyCredentialRecord = {
              ...existing.value,
              counter: Math.max(existing.value.counter, counter),
              backedUp,
              lastUsedAt: now,
            };
            return [Result.succeed(undefined), HashMap.set(s, id, updated)] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const flagCounterAnomaly: PasskeyCredentialsShape["flagCounterAnomaly"] = (id) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<void, PasskeyCredentialNotFound>, CredentialsState] => {
            const existing = HashMap.get(s, id);
            if (Option.isNone(existing)) return [Result.fail(notFound()), s] as const;
            const updated: PasskeyCredentialRecord = {
              ...existing.value,
              counterAnomalyAt: Option.some(now),
              counterAnomalyCount: existing.value.counterAnomalyCount + 1,
            };
            return [Result.succeed(undefined), HashMap.set(s, id, updated)] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const rename: PasskeyCredentialsShape["rename"] = (id, userId, name) =>
      Ref.modify(
        state,
        (
          s,
        ): readonly [
          Result.Result<PasskeyCredentialRecord, PasskeyCredentialNotFound>,
          CredentialsState,
        ] => {
          const existing = HashMap.get(s, id);
          if (Option.isNone(existing) || existing.value.userId !== userId) {
            return [Result.fail(notFound()), s] as const;
          }
          const updated: PasskeyCredentialRecord = { ...existing.value, name };
          return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const del: PasskeyCredentialsShape["delete"] = (id, userId) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<void, PasskeyCredentialNotFound>, CredentialsState] => {
          const existing = HashMap.get(s, id);
          if (Option.isNone(existing) || existing.value.userId !== userId) {
            return [Result.fail(notFound()), s] as const;
          }
          return [Result.succeed(undefined), HashMap.remove(s, id)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const deleteAllByUser: PasskeyCredentialsShape["deleteAllByUser"] = (userId) =>
      Ref.update(state, (s) =>
        Array.from(HashMap.entries(s)).reduce(
          (acc, [id, row]) => (row.userId === userId ? HashMap.remove(acc, id) : acc),
          s,
        ),
      );

    return {
      create,
      findById,
      listByUser,
      recordUsage,
      flagCounterAnomaly,
      rename,
      delete: del,
      deleteAllByUser,
    };
  }),
);

// ---- layerSql ---------------------------------------------------------------

const PasskeyCredentialRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  webauthnUserId: Schema.String,
  publicKey: Schema.String,
  counter: Schema.Int,
  deviceType: Schema.Literals(["singleDevice", "multiDevice"]),
  backedUp: Schema.BooleanFromBit,
  transports: Schema.fromJsonString(Schema.Array(Schema.String)),
  aaguid: Schema.String,
  name: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  lastUsedAt: Schema.DateTimeUtcFromString,
  counterAnomalyAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  counterAnomalyCount: Schema.Int,
});

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
};

const toRecord = (row: typeof PasskeyCredentialRow.Type): PasskeyCredentialRecord => ({
  id: row.id,
  userId: Users.UserId(row.userId),
  webauthnUserId: row.webauthnUserId,
  publicKey: base64UrlToBytes(row.publicKey),
  counter: row.counter,
  deviceType: row.deviceType,
  backedUp: row.backedUp,
  transports: row.transports,
  aaguid: row.aaguid,
  name: row.name,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  counterAnomalyAt: row.counterAnomalyAt,
  counterAnomalyCount: row.counterAnomalyCount,
});

export const layerSql: Layer.Layer<PasskeyCredentials, never, SqlClient.SqlClient> = Layer.effect(
  PasskeyCredentials,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const insert = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        userId: Schema.String,
        webauthnUserId: Schema.String,
        publicKey: Schema.String,
        counter: Schema.Int,
        deviceType: Schema.Literals(["singleDevice", "multiDevice"]),
        backedUp: Schema.BooleanFromBit,
        transports: Schema.fromJsonString(Schema.Array(Schema.String)),
        aaguid: Schema.String,
        name: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        lastUsedAt: Schema.DateTimeUtcFromString,
      }),
      Result: PasskeyCredentialRow,
      execute: (r) => sql`
        INSERT INTO passkey_credential
          (id, userId, webauthnUserId, publicKey, counter, deviceType, backedUp, transports, aaguid, name, createdAt, lastUsedAt)
        VALUES
          (${r.id}, ${r.userId}, ${r.webauthnUserId}, ${r.publicKey}, ${r.counter}, ${r.deviceType}, ${r.backedUp}, ${r.transports}, ${r.aaguid}, ${r.name}, ${r.createdAt}, ${r.lastUsedAt})
        ON CONFLICT(id) DO NOTHING
        RETURNING *
      `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PasskeyCredentialRow,
      execute: (id) => sql`SELECT * FROM passkey_credential WHERE id = ${id}`,
    });

    const listByUserQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: PasskeyCredentialRow,
      execute: (userId) => sql`SELECT * FROM passkey_credential WHERE userId = ${userId}`,
    });

    const recordUsageQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        counter: Schema.Int,
        backedUp: Schema.BooleanFromBit,
        lastUsedAt: Schema.DateTimeUtcFromString,
      }),
      Result: PasskeyCredentialRow,
      execute: (r) => sql`
        UPDATE passkey_credential
        SET counter = CASE WHEN ${r.counter} > counter THEN ${r.counter} ELSE counter END,
            backedUp = ${r.backedUp}, lastUsedAt = ${r.lastUsedAt}
        WHERE id = ${r.id}
        RETURNING *
      `,
    });

    const flagCounterAnomalyQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtcFromString }),
      Result: PasskeyCredentialRow,
      execute: (r) => sql`
        UPDATE passkey_credential
        SET counterAnomalyAt = ${r.at}, counterAnomalyCount = counterAnomalyCount + 1
        WHERE id = ${r.id}
        RETURNING *
      `,
    });

    const renameQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, userId: Schema.String, name: Schema.String }),
      Result: PasskeyCredentialRow,
      execute: (r) => sql`
        UPDATE passkey_credential SET name = ${r.name}
        WHERE id = ${r.id} AND userId = ${r.userId}
        RETURNING *
      `,
    });

    const deleteQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, userId: Schema.String }),
      Result: PasskeyCredentialRow,
      execute: (r) => sql`
        DELETE FROM passkey_credential WHERE id = ${r.id} AND userId = ${r.userId}
        RETURNING *
      `,
    });

    const notFound = (): PasskeyCredentialNotFound =>
      new PasskeyCredentialNotFound({ message: "awthaq: no such passkey credential" });

    const create: PasskeyCredentialsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const inserted = yield* insert({
        id: input.id,
        userId: input.userId,
        webauthnUserId: input.webauthnUserId,
        publicKey: bytesToBase64Url(input.publicKey),
        counter: input.counter,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        transports: [...input.transports],
        aaguid: input.aaguid,
        name: input.name,
        createdAt: now,
        lastUsedAt: now,
      }).pipe(Effect.orDie);
      if (Option.isNone(inserted)) {
        return yield* Effect.fail(
          new PasskeyCredentialAlreadyExists({
            message: "awthaq: passkey credential already exists",
          }),
        );
      }
      return toRecord(inserted.value);
    });

    const findById: PasskeyCredentialsShape["findById"] = (id) =>
      findByIdQuery(id).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const listByUser: PasskeyCredentialsShape["listByUser"] = (userId) =>
      listByUserQuery(userId).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const recordUsage: PasskeyCredentialsShape["recordUsage"] = (id, counter, backedUp) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* recordUsageQuery({ id, counter, backedUp, lastUsedAt: now }).pipe(
          Effect.orDie,
        );
        if (Option.isNone(updated)) return yield* Effect.fail(notFound());
      });

    const flagCounterAnomaly: PasskeyCredentialsShape["flagCounterAnomaly"] = (id) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* flagCounterAnomalyQuery({ id, at: now }).pipe(Effect.orDie);
        if (Option.isNone(updated)) return yield* Effect.fail(notFound());
      });

    const rename: PasskeyCredentialsShape["rename"] = (id, userId, name) =>
      renameQuery({ id, userId, name }).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound()),
            onSome: (row) => Effect.succeed(toRecord(row)),
          }),
        ),
      );

    const del: PasskeyCredentialsShape["delete"] = (id, userId) =>
      deleteQuery({ id, userId }).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(notFound()), onSome: () => Effect.void }),
        ),
      );

    const deleteAllByUser: PasskeyCredentialsShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM passkey_credential WHERE userId = ${userId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      create,
      findById,
      listByUser,
      recordUsage,
      flagCounterAnomaly,
      rename,
      delete: del,
      deleteAllByUser,
    };
  }),
);
