// @awthaq/sql — Repositories
//
// spec/behaviors/05-persistence-stratum.md, BEH-EA-035/036.
//
// Each repository is a `Context.Service` built with `SqlModel.makeRepository`
// over the ambient `SqlClient` (BEH-EA-035) — none opens its own
// transaction; the calling domain service (in `@awthaq/core`'s
// eventual SQL-backed `Layer`) holds that boundary, the same way
// `Verification.consume` and its caller's own state change are meant to
// commit together (BEH-EA-058). Every paginated query takes an opaque
// `(createdAt, id)` cursor, never an offset (BEH-EA-036).

import { Encryption } from "@awthaq/ports";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Account,
  AccountId,
  Session,
  SessionId,
  User,
  UserId,
  VerificationReservation,
  VerificationToken,
  VerificationTokenId,
} from "./Models.ts";

/** BEH-EA-036: the one cursor shape every paginated repository query accepts. */
export interface Cursor {
  readonly createdAt: DateTime.Utc;
  readonly id: string;
}

/** A page of rows plus the cursor to pass back in to fetch the next one, if any. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: Option.Option<Cursor>;
}

type RepositoryError = Schema.SchemaError | SqlError;

// ---- Users ------------------------------------------------------------

export interface UsersRepositoryShape {
  readonly insert: (input: typeof User.insert.Type) => Effect.Effect<User, RepositoryError>;
  readonly update: (input: typeof User.update.Type) => Effect.Effect<User, RepositoryError>;
  readonly findById: (
    id: UserId,
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /**
   * BEH-EA-042: `emailVerified` is excluded from `update`/`jsonUpdate` (see
   * `Models.ts`), so flipping it needs its own repository operation rather
   * than the generic `update`.
   */
  readonly verifyEmail: (
    id: UserId,
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly delete: (id: UserId) => Effect.Effect<void, RepositoryError>;
}

export class UsersRepository extends Context.Service<UsersRepository, UsersRepositoryShape>()(
  "awthaq/sql/UsersRepository",
) {}

export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    UsersRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* SqlModel.makeRepository(User, {
        tableName: "users",
        spanPrefix: "Users",
        idColumn: "id",
      });

      const findByEmail = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: User,
        execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
      });

      const verifyEmail: UsersRepositoryShape["verifyEmail"] = Effect.fnUntraced(function* (id) {
        const encodedNow = yield* Schema.encodeEffect(Schema.DateTimeUtcFromString)(
          yield* DateTime.now,
        );
        yield* sql`UPDATE users SET emailVerified = 1, updatedAt = ${encodedNow} WHERE id = ${id}`;
        return yield* repo.findById(id);
      });

      return {
        insert: repo.insert,
        update: repo.update,
        findById: repo.findById,
        delete: repo.delete,
        findByEmail,
        verifyEmail,
      };
    }),
  );

// ---- Accounts -----------------------------------------------------------

export interface AccountsRepositoryShape {
  readonly insert: (input: typeof Account.insert.Type) => Effect.Effect<Account, RepositoryError>;
  /** BEH-EA-116 (`@awthaq/password`'s rehash-on-login): the generic write path — `passwordHash`/`accessToken`/`refreshToken` are all `Model.Sensitive` (included in `update`, not excluded), so a caller updating one must pass the other two through unchanged. */
  readonly update: (input: typeof Account.update.Type) => Effect.Effect<Account, RepositoryError>;
  readonly findById: (
    id: AccountId,
  ) => Effect.Effect<Account, Cause.NoSuchElementError | RepositoryError>;
  readonly findByProviderSubject: (
    providerId: string,
    subject: string,
    issuer: string,
  ) => Effect.Effect<Option.Option<Account>, RepositoryError>;
  readonly listByUser: (userId: UserId) => Effect.Effect<ReadonlyArray<Account>, RepositoryError>;
  readonly delete: (id: AccountId) => Effect.Effect<void, RepositoryError>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 09/10: whole-user
   * deletion's own cascade — deliberately bypasses `unlink`'s last-account
   * refusal (BEH-EA-045), which exists to stop a user locking themselves
   * out of an *otherwise-still-existing* account, not to block deleting
   * the account entirely. Mirrors `SessionsRepositoryShape`'s own
   * `deleteAllForUserExcept` — a raw bulk statement, not `delete` called
   * once per row.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>;
}

export class AccountsRepository extends Context.Service<
  AccountsRepository,
  AccountsRepositoryShape
>()("awthaq/sql/AccountsRepository") {}

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 18: `accessToken`/
 * `refreshToken` are encrypted at rest via `@awthaq/ports`'
 * `Encryption`, transparently to every caller of this repository —
 * `AccountsRepositoryShape` itself is unchanged, still taking/returning
 * the same plain nullable strings `Model.Sensitive` already types them
 * as; only the bytes actually written to `accounts.accessToken`/
 * `accounts.refreshToken` differ. AAD binds each ciphertext to the
 * specific row *and* column it belongs to (`providerId:userId:field`),
 * per ticket 18's own requirement that ciphertext can't be silently
 * swapped between rows (or between the access- and refresh-token columns
 * of the very same row) undetected.
 */
const tokenAad = (
  providerId: string,
  userId: string,
  field: "accessToken" | "refreshToken",
): string => `${providerId}:${userId}:${field}`;

export const AccountsRepositoryLive: Layer.Layer<
  AccountsRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  AccountsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encryption = yield* Encryption.Encryption;
    const repo = yield* SqlModel.makeRepository(Account, {
      tableName: "accounts",
      spanPrefix: "Accounts",
      idColumn: "id",
    });

    const encryptToken = (
      providerId: string,
      userId: string,
      field: "accessToken" | "refreshToken",
      value: string | null,
    ): Effect.Effect<string | null> =>
      value === null
        ? Effect.succeed(null)
        : encryption.encrypt(Redacted.make(value), tokenAad(providerId, userId, field));

    const decryptToken = (
      providerId: string,
      userId: string,
      field: "accessToken" | "refreshToken",
      value: string | null,
    ): Effect.Effect<string | null> =>
      value === null
        ? Effect.succeed(null)
        : encryption
            .decrypt(value, tokenAad(providerId, userId, field))
            .pipe(Effect.map(Redacted.value), Effect.orDie);

    const decryptRow = (row: Account): Effect.Effect<Account> =>
      Effect.gen(function* () {
        const accessToken = yield* decryptToken(
          row.providerId,
          row.userId,
          "accessToken",
          row.accessToken,
        );
        const refreshToken = yield* decryptToken(
          row.providerId,
          row.userId,
          "refreshToken",
          row.refreshToken,
        );
        return Account.make({ ...row, accessToken, refreshToken });
      });

    const insert: AccountsRepositoryShape["insert"] = (input) =>
      Effect.gen(function* () {
        const accessToken = yield* encryptToken(
          input.providerId,
          input.userId,
          "accessToken",
          input.accessToken,
        );
        const refreshToken = yield* encryptToken(
          input.providerId,
          input.userId,
          "refreshToken",
          input.refreshToken,
        );
        const row = yield* repo.insert({ ...input, accessToken, refreshToken });
        return yield* decryptRow(row);
      });

    const update: AccountsRepositoryShape["update"] = (input) =>
      Effect.gen(function* () {
        // A vanished row between the caller's own existence check and this
        // call is an unexpected condition — `update`'s own contract has
        // always presupposed the row still exists (see
        // `AccountsShape.updateCredentialHash`'s own `repo.findById` call
        // in `@awthaq/core`) — not a new recoverable outcome this
        // repository method's signature needs to grow a case for.
        const existing = yield* repo
          .findById(input.id)
          .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
        const accessToken = yield* encryptToken(
          existing.providerId,
          existing.userId,
          "accessToken",
          input.accessToken,
        );
        const refreshToken = yield* encryptToken(
          existing.providerId,
          existing.userId,
          "refreshToken",
          input.refreshToken,
        );
        const row = yield* repo.update({ ...input, accessToken, refreshToken });
        return yield* decryptRow(row);
      });

    const findById: AccountsRepositoryShape["findById"] = (id) =>
      repo.findById(id).pipe(Effect.flatMap(decryptRow));

    const findByProviderSubject = SqlSchema.findOneOption({
      Request: Schema.Struct({
        providerId: Schema.String,
        subject: Schema.String,
        issuer: Schema.String,
      }),
      Result: Account,
      execute: (request) =>
        sql`SELECT * FROM accounts WHERE providerId = ${request.providerId} AND subject = ${request.subject} AND issuer = ${request.issuer}`,
    });

    const listByUser = SqlSchema.findAll({
      Request: UserId,
      Result: Account,
      execute: (userId) => sql`SELECT * FROM accounts WHERE userId = ${userId}`,
    });

    const deleteAllByUser: AccountsRepositoryShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM accounts WHERE userId = ${userId}`.pipe(Effect.asVoid);

    return {
      insert,
      update,
      findById,
      delete: repo.delete,
      findByProviderSubject: (providerId, subject, issuer) =>
        findByProviderSubject({ providerId, subject, issuer }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => decryptRow(row).pipe(Effect.map(Option.some)),
            }),
          ),
        ),
      listByUser: (userId) =>
        listByUser(userId).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decryptRow))),
      deleteAllByUser,
    };
  }),
);

// ---- Sessions -----------------------------------------------------------

const SessionCursorRequest = Schema.Struct({
  userId: UserId,
  cursorCreatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  cursorId: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});

export interface SessionsRepositoryShape {
  readonly insert: (input: typeof Session.insert.Type) => Effect.Effect<Session, RepositoryError>;
  readonly update: (input: typeof Session.update.Type) => Effect.Effect<Session, RepositoryError>;
  readonly findById: (
    id: SessionId,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /** BEH-EA-036: `cursor` is opaque and derived from `(createdAt, id)`. */
  readonly listByUser: (
    userId: UserId,
    cursor?: Cursor,
    limit?: number,
  ) => Effect.Effect<Page<Session>, RepositoryError>;
  /**
   * Upstream-hardening map, ticket 01: the throttled touch/rotation
   * write's own compare-and-swap — `expectedSecretHash` must still match
   * the row's *current* `secretHash` for the update to apply. Two
   * concurrent requests racing the same throttled window would otherwise
   * both blindly overwrite `secretHash` via a plain `update`, leaving
   * whichever response lost the race holding a token that no longer
   * verifies. `None` means another request already won that race — not a
   * failure — so the caller reports no rotation of its own rather than
   * clobbering the winner's write.
   */
  readonly touch: (input: {
    readonly id: SessionId;
    readonly expectedSecretHash: string;
    readonly secretHash: string;
    readonly lastActiveAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<Session>, RepositoryError>;
  readonly delete: (id: SessionId) => Effect.Effect<void, RepositoryError>;
  /** BEH-EA-054: bulk-revokes every session for `userId` except `keep`. */
  readonly deleteAllForUserExcept: (
    userId: UserId,
    keep: SessionId,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Upstream-hardening map, ticket 02: bulk-revokes every session for
   * `userId`, no exceptions — `revokeAll`'s own primitive, distinct from
   * `deleteAllForUserExcept`'s "all but one" shape.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>;
}

export class SessionsRepository extends Context.Service<
  SessionsRepository,
  SessionsRepositoryShape
>()("awthaq/sql/SessionsRepository") {}

const DEFAULT_PAGE_SIZE = 50;

export const SessionsRepositoryLive: Layer.Layer<SessionsRepository, never, SqlClient.SqlClient> =
  Layer.effect(
    SessionsRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* SqlModel.makeRepository(Session, {
        tableName: "sessions",
        spanPrefix: "Sessions",
        idColumn: "id",
      });

      const page = SqlSchema.findAll({
        Request: SessionCursorRequest,
        Result: Session,
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? sql`SELECT * FROM sessions WHERE userId = ${request.userId}
                  ORDER BY createdAt ASC, id ASC LIMIT ${request.limit}`
            : sql`SELECT * FROM sessions WHERE userId = ${request.userId}
                  AND (createdAt > ${request.cursorCreatedAt}
                       OR (createdAt = ${request.cursorCreatedAt} AND id > ${request.cursorId}))
                  ORDER BY createdAt ASC, id ASC LIMIT ${request.limit}`,
      });

      const listByUser: SessionsRepositoryShape["listByUser"] = (userId, cursor, limit) =>
        page({
          userId,
          cursorCreatedAt: cursor?.createdAt ?? null,
          cursorId: cursor?.id ?? null,
          limit: limit ?? DEFAULT_PAGE_SIZE,
        }).pipe(
          Effect.map((items): Page<Session> => {
            const effectiveLimit = limit ?? DEFAULT_PAGE_SIZE;
            const last = items.at(-1);
            const nextCursor =
              items.length === effectiveLimit && last !== undefined
                ? Option.some({ createdAt: last.createdAt, id: last.id })
                : Option.none();
            return { items, nextCursor };
          }),
        );

      const touch = SqlSchema.findOneOption({
        Request: Schema.Struct({
          id: SessionId,
          expectedSecretHash: Schema.String,
          secretHash: Schema.String,
          lastActiveAt: Schema.DateTimeUtcFromString,
          idleExpiresAt: Schema.DateTimeUtcFromString,
        }),
        Result: Session,
        // Quoted column names: this table's Postgres DDL (`CoreMigrations.ts`)
        // declares `"secretHash"`/`"lastActiveAt"`/`"idleExpiresAt"` with
        // preserved mixed case, which only an equally-quoted reference
        // matches (Postgres folds an unquoted identifier to lowercase).
        // SQLite's own identifier resolution is case-insensitive regardless
        // of quoting, so the same quoted form is safe on both dialects.
        execute: (request) => sql`
          UPDATE sessions
          SET "secretHash" = ${request.secretHash},
              "lastActiveAt" = ${request.lastActiveAt},
              "idleExpiresAt" = ${request.idleExpiresAt}
          WHERE "id" = ${request.id}
            AND "secretHash" = ${request.expectedSecretHash}
          RETURNING *
        `,
      });

      const deleteAllForUserExcept: SessionsRepositoryShape["deleteAllForUserExcept"] = (
        userId,
        keep,
      ) => sql`DELETE FROM sessions WHERE userId = ${userId} AND id != ${keep}`.pipe(Effect.asVoid);

      // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`)
      // declares the column with preserved mixed case, which only an
      // equally-quoted reference matches there (Postgres folds an
      // unquoted identifier to lowercase); SQLite's own identifier
      // resolution is case-insensitive regardless of quoting, so the same
      // quoted form is correct on both dialects.
      const deleteAllByUser: SessionsRepositoryShape["deleteAllByUser"] = (userId) =>
        sql`DELETE FROM sessions WHERE "userId" = ${userId}`.pipe(Effect.asVoid);

      return {
        insert: repo.insert,
        update: repo.update,
        findById: repo.findById,
        delete: repo.delete,
        listByUser,
        touch,
        deleteAllForUserExcept,
        deleteAllByUser,
      };
    }),
  );

// ---- Verification ---------------------------------------------------------

export interface VerificationRepositoryShape {
  readonly insert: (
    input: typeof VerificationToken.insert.Type,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly update: (
    input: typeof VerificationToken.update.Type,
  ) => Effect.Effect<VerificationToken, RepositoryError>;
  readonly findById: (
    id: VerificationTokenId,
  ) => Effect.Effect<VerificationToken, Cause.NoSuchElementError | RepositoryError>;
  readonly findByIdentifier: (
    identifier: string,
  ) => Effect.Effect<Option.Option<VerificationToken>, RepositoryError>;
  readonly delete: (id: VerificationTokenId) => Effect.Effect<void, RepositoryError>;
  /**
   * ADR-EA-016: one atomic `INSERT ... ON CONFLICT(identifier) WHERE
   * consumedAt IS NULL DO UPDATE ... RETURNING`, targeting a partial unique
   * index on `(identifier) WHERE consumedAt IS NULL` — the DB engine itself
   * decides "fresh insert" vs. "replace the current live row" in one
   * statement, so two concurrent `issue`s for the same `identifier` can
   * never both leave a live row behind the way a separate delete-then-insert
   * could. Every already-consumed historical row is untouched either way —
   * the partial index (and this statement's own conflict target) only ever
   * sees the single *unconsumed* row for `identifier`, if one exists.
   */
  readonly upsertLive: (input: {
    readonly id: VerificationTokenId;
    readonly identifier: string;
    readonly valueHash: string;
    readonly expiresAt: DateTime.Utc;
    readonly createdAt: DateTime.Utc;
    readonly payload: unknown;
  }) => Effect.Effect<VerificationToken, Cause.NoSuchElementError | RepositoryError>;
  /**
   * ADR-EA-016/BEH-EA-058/062: the one atomic statement `consume` is built
   * on — `identifier`/`valueHash`/`expiresAt > now`/`consumedAt IS NULL` are
   * all checked and written in a single `UPDATE ... RETURNING`, so unknown,
   * expired, wrong-secret, and already-consumed all collapse into the same
   * "no row back" result without a separate read racing the write.
   */
  readonly tryConsume: (input: {
    readonly identifier: string;
    readonly valueHash: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<Option.Option<VerificationToken>, RepositoryError>;
}

export class VerificationRepository extends Context.Service<
  VerificationRepository,
  VerificationRepositoryShape
>()("awthaq/sql/VerificationRepository") {}

export const VerificationRepositoryLive: Layer.Layer<
  VerificationRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  VerificationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* SqlModel.makeRepository(VerificationToken, {
      tableName: "verification_tokens",
      spanPrefix: "VerificationTokens",
      idColumn: "id",
    });

    const findByIdentifier = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: VerificationToken,
      execute: (identifier) =>
        sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY createdAt DESC LIMIT 1`,
    });

    const upsertLive = SqlSchema.findOne({
      Request: Schema.Struct({
        id: VerificationTokenId,
        identifier: Schema.String,
        valueHash: Schema.String,
        expiresAt: Schema.DateTimeUtcFromString,
        createdAt: Schema.DateTimeUtcFromString,
        payload: Schema.fromJsonString(Schema.Unknown),
      }),
      Result: VerificationToken,
      execute: (request) => sql`
        INSERT INTO verification_tokens (id, identifier, valueHash, expiresAt, consumedAt, createdAt, payload)
        VALUES (${request.id}, ${request.identifier}, ${request.valueHash}, ${request.expiresAt}, NULL, ${request.createdAt}, ${request.payload})
        ON CONFLICT(identifier) WHERE consumedAt IS NULL
        DO UPDATE SET
          id = excluded.id,
          valueHash = excluded.valueHash,
          expiresAt = excluded.expiresAt,
          createdAt = excluded.createdAt,
          payload = excluded.payload,
          consumedAt = NULL
        RETURNING *
      `,
    });

    const tryConsume = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        valueHash: Schema.String,
        now: Schema.DateTimeUtcFromString,
      }),
      Result: VerificationToken,
      execute: (request) => sql`
        UPDATE verification_tokens
        SET consumedAt = ${request.now}
        WHERE identifier = ${request.identifier}
          AND valueHash = ${request.valueHash}
          AND expiresAt > ${request.now}
          AND consumedAt IS NULL
        RETURNING *
      `,
    });

    return {
      insert: repo.insert,
      update: repo.update,
      findById: repo.findById,
      delete: repo.delete,
      findByIdentifier,
      upsertLive,
      tryConsume,
    };
  }),
);

// ---- VerificationReservations -------------------------------------------

/**
 * BEH-EA-063/ADR-EA-016: `reserve`'s one race-safe primitive — a plugin
 * calling this never sees a separate read followed by a separate write, so
 * two concurrent claims of the same `identifier` cannot both win.
 */
export interface VerificationReservationsRepositoryShape {
  /**
   * `true` only when this call's write actually took effect — a fresh
   * reservation, or one placed on an identifier whose prior reservation has
   * expired; `false` when an unexpired reservation already belongs to
   * someone else. `now` is the caller's own clock reading (the same
   * `DateTime.now` `Verification.layerSql` already reads), never the
   * database's own clock, so `TestClock` controls this the same way it
   * already controls every other time-sensitive behavior in this stratum.
   */
  readonly claim: (input: {
    readonly identifier: string;
    readonly expiresAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<boolean, RepositoryError>;
}

export class VerificationReservationsRepository extends Context.Service<
  VerificationReservationsRepository,
  VerificationReservationsRepositoryShape
>()("awthaq/sql/VerificationReservationsRepository") {}

export const VerificationReservationsRepositoryLive = Layer.effect(
  VerificationReservationsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    /**
     * ADR-EA-016: one atomic statement — the `WHERE` clause on the `DO
     * UPDATE` is what makes "unexpired reservations block a new claim" a
     * property of this single write, not a separate check racing against
     * it. `RETURNING *` produces a row only when the insert happened or the
     * conditional update actually fired — SQLite's own UPSERT semantics
     * skip `RETURNING` entirely when the `DO UPDATE`'s `WHERE` is false, so
     * "no row back" and "claim failed" are the same fact, not two things
     * this code has to keep in sync by hand.
     */
    const attempt = SqlSchema.findOneOption({
      Request: Schema.Struct({
        identifier: Schema.String,
        expiresAt: Schema.DateTimeUtcFromString,
        now: Schema.DateTimeUtcFromString,
      }),
      Result: VerificationReservation,
      execute: (request) => sql`
        INSERT INTO verification_reservations (identifier, expiresAt)
        VALUES (${request.identifier}, ${request.expiresAt})
        ON CONFLICT(identifier) DO UPDATE SET expiresAt = excluded.expiresAt
        WHERE verification_reservations.expiresAt < ${request.now}
        RETURNING *
      `,
    });

    const claim: VerificationReservationsRepositoryShape["claim"] = (input) =>
      attempt(input).pipe(Effect.map(Option.isSome));

    return { claim };
  }),
);
