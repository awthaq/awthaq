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

import { Defects, Encryption, Sealed, Tenant } from "@awthaq/ports";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlModel from "effect/unstable/sql/SqlModel";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as CoreSealedColumns from "./CoreSealedColumns.ts";
import { sealCell, sealedCell, type ColumnCodec } from "./internal/Cells.ts";
import { traced } from "./internal/traced.ts";
import * as ReadRouting from "./ReadRouting.ts";
import * as SealedColumn from "./SealedColumn.ts";
import { SessionId, UserId, makeModels, resolveDialect } from "./Models.ts";
import type { Session, SessionInsert, SqlModels, User, UserInsert } from "./Models.ts";

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

/** SAM-004: a plugin-declared user-field column and how its scalar is stored (`text`, `real` = double precision, `boolean`). */
export interface UserFieldColumn {
  readonly name: string;
  readonly kind: "text" | "real" | "boolean";
}

/** SAM-004: what a user-field column holds. */
export type UserFieldScalar = string | number | boolean;

export interface UsersRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with — callers build insert/update inputs from these. */
  readonly models: SqlModels;
  /** CSG-006: the stored `metadata` cell of a row this repository returned, as a `Sealed` (never opened here). */
  readonly metadataOf: (row: User) => Option.Option<Sealed.Sealed<string>>;
  /**
   * SAM-004 (BEH-EA-040): reads the named declared-field columns of one user — `None` when there is
   * no such user, else the columns that hold a value (an unset column is absent). Column names come
   * from the composition's own registry, never from a request, and are always quoted identifiers.
   * Booleans come back as booleans on both dialects (SQLite stores 0/1).
   */
  readonly readFields: (
    id: UserId,
    columns: ReadonlyArray<UserFieldColumn>,
  ) => Effect.Effect<Option.Option<Readonly<Record<string, UserFieldScalar>>>, RepositoryError>;
  readonly insert: (input: UserInsert) => Effect.Effect<User, RepositoryError>;
  /**
   * GC-004: one `UPDATE ... RETURNING *` on `name`, and on `metadata`/`image` when given (`null`
   * clears, `undefined` leaves the column), so a row deleted since the caller last read it is
   * `None` — not the defect the generic `update` reports it as — and no other column is rewritten
   * from a stale read.
   */
  readonly updateProfile: (input: {
    readonly id: UserId;
    readonly name: string;
    readonly metadata: string | null | undefined;
    readonly image: string | null | undefined;
    /** The instant `updatedAt` takes; the caller's clock reading (default: now). */
    readonly updatedAt?: DateTime.Utc;
  }) => Effect.Effect<Option.Option<User>, RepositoryError>;
  readonly findById: (
    id: UserId,
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly findByEmail: (email: string) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /** FAMS-002: `phone` is compared as stored (callers normalize to E.164 first). */
  readonly findByPhone: (phone: string) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /**
   * SCP-003: `INSERT ... ON CONFLICT DO NOTHING RETURNING *` — `None` when any
   * unique index (email, phone) already holds the value. Unlike `insert` +
   * catching `UniqueViolation`, this does not abort an enclosing Postgres
   * transaction, so an idempotent import can keep going after a duplicate.
   */
  readonly insertIfAbsent: (
    input: UserInsert,
  ) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /** SCP-001: `status`, its reason and expiry have no other writer. */
  readonly setStatus: (
    id: UserId,
    state: {
      readonly status: "active" | "suspended";
      readonly reason: string | null;
      readonly until: DateTime.Utc | null;
      /** The instant `updatedAt` takes; the caller's clock reading (default: now). */
      readonly updatedAt?: DateTime.Utc;
    },
  ) => Effect.Effect<User, Cause.NoSuchElementError | RepositoryError>;
  readonly delete: (id: UserId) => Effect.Effect<void, RepositoryError>;
  /**
   * Plan 02 (`UserStoreSql`): `DELETE ... RETURNING id`, so the caller learns whether a row was
   * removed (the declared fields are columns of the same row, so they go with it).
   */
  readonly deleteReturning: (id: UserId) => Effect.Effect<boolean, RepositoryError>;
  /**
   * Plan 02 (`UserStoreSql`): the compare-and-swap behind every identity transition. One
   * `UPDATE ... WHERE id = ? AND <the four identity columns still equal what the caller read>
   * RETURNING *`: `None` when the row is absent or one of them moved (the caller re-reads to tell
   * which). A unique violation on the new email or phone surfaces as `SqlError`; the adapter wraps the
   * statement in its own savepoint.
   */
  readonly casIdentity: (input: {
    readonly id: UserId;
    readonly expected: {
      readonly email: string | null;
      readonly emailVerified: boolean;
      readonly phone: string | null;
      readonly phoneVerified: boolean;
    };
    readonly next: {
      readonly email: string | null;
      readonly emailVerified: boolean;
      readonly phone: string | null;
      readonly phoneVerified: boolean;
    };
    readonly updatedAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<User>, RepositoryError>;
  /**
   * Plan 02: the same write as `writeFields`, plus `updatedAt`, answering the `returning` columns
   * as they are after the write from the one `UPDATE ... RETURNING` (`None` when there is no such
   * user, and then nothing was written).
   */
  readonly writeFieldsReturning: (input: {
    readonly id: UserId;
    readonly values: Readonly<Record<string, UserFieldScalar | null>>;
    readonly returning: ReadonlyArray<UserFieldColumn>;
    readonly updatedAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<Readonly<Record<string, UserFieldScalar>>>, RepositoryError>;
  /**
   * BAM-005/BEH-EA-036: keyset page over every user, oldest first —
   * `cursor` is opaque and derived from `(createdAt, id)`; at most `limit`
   * rows are returned (`nextCursor` present iff a full page came back and
   * more may follow).
   */
  readonly listPage: (
    cursor?: Cursor,
    limit?: number,
  ) => Effect.Effect<Page<User>, RepositoryError>;
}

export class UsersRepository extends Context.Service<UsersRepository, UsersRepositoryShape>()(
  "awthaq/sql/UsersRepository",
) {}

/**
 * SAM-004: a declared-field cell as its column kind says it should look: `null` is unset, a boolean
 * is a boolean on both dialects (SQLite hands back 0/1), and anything else that does not match the
 * declared kind is a corrupt column, a defect a retry cannot fix.
 */
const userFieldScalar = (
  column: UserFieldColumn,
  raw: unknown,
): Effect.Effect<UserFieldScalar | null> => {
  if (raw === null || raw === undefined) return Effect.succeed(null);
  switch (column.kind) {
    case "text":
      if (typeof raw === "string") return Effect.succeed(raw);
      break;
    case "real":
      if (typeof raw === "number") return Effect.succeed(raw);
      break;
    case "boolean":
      if (typeof raw === "boolean") return Effect.succeed(raw);
      if (raw === 0 || raw === 1) return Effect.succeed(raw === 1);
      break;
  }
  return Defects.invariantViolation(
    "UserFieldColumnMismatch",
    `awthaq: users column "${column.name}" holds a ${typeof raw}, not a ${column.kind}`,
  );
};

const makeUsersRepository = (codec: Option.Option<ColumnCodec>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const models = makeModels(dialect);
    const repo = yield* SqlModel.makeRepository(models.User, {
      tableName: "users",
      spanPrefix: "Users",
      idColumn: "id",
    });

    // SAM-004: the plugin-declared columns are outside the model (they exist only when a
    // composition declares them), so they are read and written with plain statements over
    // identifiers the registry supplied.
    const readFields: UsersRepositoryShape["readFields"] = (id, columns) =>
      columns.length === 0
        ? repo.findById(id).pipe(
            Effect.map(() => Option.some({})),
            Effect.catchTag("NoSuchElementError", () => Effect.succeedNone),
          )
        : sql`SELECT ${sql.csv(columns.map((column) => sql`${sql(column.name)}`))} FROM users WHERE id = ${id}`.pipe(
            Effect.flatMap((rows) => {
              const [row] = rows;
              if (row === undefined) return Effect.succeedNone;
              return Effect.forEach(columns, (column) =>
                userFieldScalar(column, row[column.name]).pipe(
                  Effect.map((value) => [column.name, value] as const),
                ),
              ).pipe(
                Effect.map((entries) =>
                  Option.some(
                    Object.fromEntries(
                      entries.flatMap(([name, value]) => (value === null ? [] : [[name, value]])),
                    ),
                  ),
                ),
              );
            }),
            traced("Users.readFields", { id }),
          );

    // CSG-006: `users.metadata` is the one free-form personal-data column. With the default
    // repository these are no-ops; the encrypted variant seals it on write and hands the stored cell
    // out as a `Sealed` (opened, and lazily re-sealed, where the domain needs the value).
    const concealMetadata = (id: string, metadata: string | null) => sealCell(codec, id, metadata);

    const metadataOf = (row: User) => sealedCell(codec, row.id, row.metadata);

    const insert: UsersRepositoryShape["insert"] = (input) =>
      concealMetadata(input.id, input.metadata).pipe(
        Effect.flatMap((metadata) =>
          Effect.flatMap(Tenant.stamp(input), (stamped) => repo.insert({ ...stamped, metadata })),
        ),
      );

    const findById: UsersRepositoryShape["findById"] = (id) => repo.findById(id);

    // ESR-003: JS `toLowerCase()` is the only fold — the bound parameter is
    // normalized here (and stored values already are, by `Users.ts`), while
    // the column side keeps `lower(email)` so `users_email_unique`'s
    // expression index still serves the lookup. SQLite's own `lower()` folds
    // ASCII only, so folding the *parameter* in SQL would miss non-ASCII.
    const findByEmailQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.User,
      execute: (email) => sql`SELECT * FROM users WHERE lower(email) = ${email.toLowerCase()}`,
    });

    const findByEmail: UsersRepositoryShape["findByEmail"] = (email) =>
      findByEmailQuery(email).pipe(traced("Users.findByEmail"));

    const findByPhoneQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: models.User,
      execute: (phone) => sql`SELECT * FROM users WHERE phone = ${phone}`,
    });

    const findByPhone: UsersRepositoryShape["findByPhone"] = (phone) =>
      findByPhoneQuery(phone).pipe(traced("Users.findByPhone"));

    const insertIfAbsentQuery = SqlSchema.findAll({
      Request: models.User.insert,
      Result: models.User,
      execute: (request) =>
        sql`INSERT INTO users ${sql.insert(request)} ON CONFLICT DO NOTHING RETURNING *`,
    });

    const insertIfAbsent: UsersRepositoryShape["insertIfAbsent"] = (input) =>
      concealMetadata(input.id, input.metadata).pipe(
        Effect.flatMap((metadata) =>
          Effect.flatMap(Tenant.stamp(input), (stamped) =>
            insertIfAbsentQuery({ ...stamped, metadata }),
          ),
        ),
        Effect.map(([row]) => Option.fromNullishOr(row)),
        traced("Users.insertIfAbsent"),
      );

    const usersPage = SqlSchema.findAll({
      Request: Schema.Struct({
        cursorCreatedAt: models.wire.nullableDateTime,
        cursorId: Schema.NullOr(Schema.String),
        limit: Schema.Int,
      }),
      Result: models.User,
      execute: (request) =>
        request.cursorCreatedAt === null || request.cursorId === null
          ? sql`SELECT * FROM users ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`
          : sql`SELECT * FROM users
                  WHERE "createdAt" > ${request.cursorCreatedAt}
                     OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit + 1}`,
    });

    // Reads `limit + 1` rows: the extra one only proves a next page exists, so an
    // exactly-full final page never invents a cursor.
    const listPage: UsersRepositoryShape["listPage"] = (cursor, limit) => {
      const effectiveLimit = limit ?? DEFAULT_PAGE_SIZE;
      return usersPage({
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? null,
        limit: effectiveLimit,
      }).pipe(
        Effect.map((rows) => ({
          items: rows.slice(0, effectiveLimit),
          more: rows.length > effectiveLimit,
        })),
        Effect.map(({ items, more }): Page<User> => {
          const last = items.at(-1);
          return {
            items,
            nextCursor:
              more && last !== undefined
                ? Option.some({ createdAt: last.createdAt, id: last.id })
                : Option.none(),
          };
        }),
        traced("Users.listPage"),
      );
    };

    // GC-004: `metadata`/`image` are each rewritten only when the caller supplied them; the flags
    // bind through the dialect's boolean codec like `verified` below, and `metadata` is sealed
    // (encrypted variant) only when it is set.
    const updateProfileQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: UserId,
        name: Schema.String,
        setMetadata: models.wire.boolean,
        metadata: Schema.NullOr(Schema.String),
        setImage: models.wire.boolean,
        image: Schema.NullOr(Schema.String),
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      execute: (r) =>
        sql`UPDATE users SET name = ${r.name}, metadata = CASE WHEN ${r.setMetadata} THEN ${r.metadata} ELSE metadata END, image = CASE WHEN ${r.setImage} THEN ${r.image} ELSE image END, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *`,
    });

    const updateProfile: UsersRepositoryShape["updateProfile"] = (input) =>
      Effect.gen(function* () {
        const updatedAt = input.updatedAt ?? (yield* DateTime.now);
        const metadata =
          input.metadata === undefined ? null : yield* concealMetadata(input.id, input.metadata);
        return yield* updateProfileQuery({
          id: input.id,
          name: input.name,
          setMetadata: input.metadata !== undefined,
          metadata,
          setImage: input.image !== undefined,
          image: input.image ?? null,
          updatedAt,
        });
      }).pipe(traced("Users.updateProfile", { id: input.id }));

    const setStatusQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: UserId,
        status: Schema.Literals(["active", "suspended"]),
        reason: Schema.NullOr(Schema.String),
        until: models.wire.nullableDateTime,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      execute: (r) =>
        sql`UPDATE users SET status = ${r.status}, "statusReason" = ${r.reason}, "suspendedUntil" = ${r.until}, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *`,
    });

    const setStatus: UsersRepositoryShape["setStatus"] = (id, state) =>
      (state.updatedAt === undefined ? DateTime.now : Effect.succeed(state.updatedAt)).pipe(
        Effect.flatMap((updatedAt) =>
          setStatusQuery({
            id,
            status: state.status,
            reason: state.reason,
            until: state.until,
            updatedAt,
          }),
        ),
        traced("Users.setStatus", { id }),
      );

    // ---- plan 02: what `UserStoreSql` is built on ----------------------------------------------
    const deleteReturningQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (id) => sql`DELETE FROM users WHERE id = ${id} RETURNING id`,
    });
    const deleteReturning: UsersRepositoryShape["deleteReturning"] = (id) =>
      deleteReturningQuery(id).pipe(
        Effect.map((rows) => rows.length > 0),
        traced("Users.deleteReturning", { id }),
      );

    const casIdentityQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: UserId,
        expectedEmail: Schema.NullOr(Schema.String),
        expectedEmailVerified: models.wire.boolean,
        expectedPhone: Schema.NullOr(Schema.String),
        expectedPhoneVerified: models.wire.boolean,
        email: Schema.NullOr(Schema.String),
        emailVerified: models.wire.boolean,
        phone: Schema.NullOr(Schema.String),
        phoneVerified: models.wire.boolean,
        updatedAt: models.wire.dateTime,
      }),
      Result: models.User,
      // `IS NOT DISTINCT FROM` is Postgres' null-safe equality; SQLite spells it `IS`.
      execute: (r) =>
        dialect === "pg"
          ? sql`UPDATE users SET email = ${r.email}, "emailVerified" = ${r.emailVerified}, phone = ${r.phone}, "phoneVerified" = ${r.phoneVerified}, "updatedAt" = ${r.updatedAt}
                WHERE id = ${r.id} AND email IS NOT DISTINCT FROM ${r.expectedEmail} AND "emailVerified" = ${r.expectedEmailVerified}
                  AND phone IS NOT DISTINCT FROM ${r.expectedPhone} AND "phoneVerified" = ${r.expectedPhoneVerified} RETURNING *`
          : sql`UPDATE users SET email = ${r.email}, "emailVerified" = ${r.emailVerified}, phone = ${r.phone}, "phoneVerified" = ${r.phoneVerified}, "updatedAt" = ${r.updatedAt}
                WHERE id = ${r.id} AND email IS ${r.expectedEmail} AND "emailVerified" = ${r.expectedEmailVerified}
                  AND phone IS ${r.expectedPhone} AND "phoneVerified" = ${r.expectedPhoneVerified} RETURNING *`,
    });
    const casIdentity: UsersRepositoryShape["casIdentity"] = (input) =>
      casIdentityQuery({
        id: input.id,
        expectedEmail: input.expected.email,
        expectedEmailVerified: input.expected.emailVerified,
        expectedPhone: input.expected.phone,
        expectedPhoneVerified: input.expected.phoneVerified,
        email: input.next.email,
        emailVerified: input.next.emailVerified,
        phone: input.next.phone,
        phoneVerified: input.next.phoneVerified,
        updatedAt: input.updatedAt,
      }).pipe(traced("Users.casIdentity", { id: input.id }));

    const encodeDateTime = Schema.encodeSync(models.wire.dateTime);
    const writeFieldsReturning: UsersRepositoryShape["writeFieldsReturning"] = (input) => {
      const stored = Object.fromEntries([
        ...Object.entries(input.values).map(([name, value]) => [
          name,
          dialect === "sqlite" && typeof value === "boolean" ? (value ? 1 : 0) : value,
        ]),
        ["updatedAt", encodeDateTime(input.updatedAt)],
      ]);
      const returning =
        input.returning.length === 0
          ? sql`id`
          : sql.csv(input.returning.map((column) => sql`${sql(column.name)}`));
      return sql`UPDATE users SET ${sql.update(stored)} WHERE id = ${input.id} RETURNING ${returning}`.pipe(
        Effect.flatMap((rows) => {
          const [row] = rows;
          if (row === undefined) return Effect.succeedNone;
          return Effect.forEach(input.returning, (column) =>
            userFieldScalar(column, row[column.name]).pipe(
              Effect.map((value): readonly [string, UserFieldScalar | null] => [
                column.name,
                value,
              ]),
            ),
          ).pipe(
            Effect.map((entries) =>
              Option.some(
                Object.fromEntries(
                  entries.flatMap(([name, value]) => (value === null ? [] : [[name, value]])),
                ),
              ),
            ),
          );
        }),
        traced("Users.writeFieldsReturning", { id: input.id }),
      );
    };

    return {
      models,
      metadataOf,
      readFields,
      insert,
      findById,
      delete: repo.delete,
      findByEmail,
      findByPhone,
      insertIfAbsent,
      updateProfile,
      setStatus,
      deleteReturning,
      casIdentity,
      writeFieldsReturning,
      listPage,
    };
  });

export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  Layer.effect(UsersRepository, makeUsersRepository(Option.none()));

/**
 * CSG-006 (option B, opt-in): `users.metadata` is encrypted at rest through
 * `Encryption` (AAD `users:<id>:metadata`, the declared `CoreSealedColumns.usersMetadata`).
 * `Persistence.sql({ encryptPii: true })` chooses this layer. Existing plaintext rows stay readable and
 * are sealed on their next read (`SealedColumnConfig.resealOnRead`), write, or `SealedColumn.sweepDeployed`.
 * `email` and `name` stay plaintext: email is the lookup and uniqueness key.
 */
export const UsersRepositoryEncryptedLive: Layer.Layer<
  UsersRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  UsersRepository,
  Effect.flatMap(SealedColumn.sqlCodec(CoreSealedColumns.usersMetadata), (codec) =>
    makeUsersRepository(Option.some(codec)),
  ),
);

// ---- Sessions -----------------------------------------------------------

export interface SessionsRepositoryShape {
  /** TS-001: the dialect-resolved models this repository decodes with. */
  readonly models: SqlModels;
  /** CSG-006: the stored `ipAddress`/`userAgent` cells of a row this repository returned, as `Sealed`s (never opened here). */
  readonly piiOf: (row: Session) => {
    readonly ipAddress: Option.Option<Sealed.Sealed<string>>;
    readonly userAgent: Option.Option<Sealed.Sealed<string>>;
  };
  readonly insert: (input: SessionInsert) => Effect.Effect<Session, RepositoryError>;
  readonly findById: (
    id: SessionId,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /**
   * BEH-EA-036: `cursor` is opaque and derived from `(createdAt, id)`.
   * SMS-002/BEH-EA-054: lists only *live* rows — not tombstoned and past
   * neither `absoluteExpiresAt` nor `idleExpiresAt` at `now`. ESR-010:
   * `limit` is clamped to `[1, MAX_PAGE_SIZE]`.
   *
   * RRC-001: reads the primary unless `options.consistency` is `"eventual"`,
   * which a display-only caller (a device list) passes to allow a configured
   * read replica. Never pass it for a liveness or authorization decision.
   */
  readonly listByUser: (
    userId: UserId,
    now: DateTime.Utc,
    cursor?: Cursor,
    limit?: number,
    options?: ReadRouting.ReadOptions,
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
   * clobbering the winner's write. Plan 02: a tombstoned row is never rotated
   * (`"supersededAt" IS NULL`): it is the evidence of reuse.
   */
  readonly touch: (input: {
    readonly id: SessionId;
    readonly expectedSecretHash: string;
    readonly secretHash: string;
    /** RRS-005: the replaced hash, kept until `previousSecretExpiresAt`; absent/`null` clears any earlier grace. */
    readonly previousSecretHash?: string | null | undefined;
    readonly previousSecretExpiresAt?: DateTime.Utc | null | undefined;
    readonly lastActiveAt: DateTime.Utc;
    readonly idleExpiresAt: DateTime.Utc;
  }) => Effect.Effect<Option.Option<Session>, RepositoryError>;
  readonly delete: (id: SessionId) => Effect.Effect<void, RepositoryError>;
  /** BEH-EA-054: bulk-revokes every session for `userId` except `keep`. Resolves to how many went. */
  readonly deleteAllForUserExcept: (
    userId: UserId,
    keep: SessionId,
  ) => Effect.Effect<number, RepositoryError>;
  /**
   * Upstream-hardening map, ticket 02: bulk-revokes every session for
   * `userId`, no exceptions — `revokeAll`'s own primitive, distinct from
   * `deleteAllForUserExcept`'s "all but one" shape. Resolves to how many went.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<number, RepositoryError>;
  /**
   * SMS-003: the user's live (not tombstoned, past neither expiry at `now`),
   * non-impersonation sessions' ids and last activity — what a concurrent-
   * session cap counts and evicts from. Impersonation (`actingAs`) rows are
   * excluded: an admin's support session never counts against the target.
   */
  readonly listLiveIds: (
    userId: UserId,
    now: DateTime.Utc,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: SessionId; readonly lastActiveAt: DateTime.Utc }>,
    RepositoryError
  >;
  /**
   * TIR-008/GC-005: deletes session `id` in ONE statement (`DELETE ... RETURNING`) and answers
   * the user it belonged to, so exactly one of two concurrent revokes sees the row and
   * publishes the event. When `owner` is given the row is deleted only if it belongs to that
   * user: ownership is enforced by the statement, not by a preceding lookup. `None` for an
   * unknown id and a foreign id alike, so a caller cannot tell them apart.
   */
  readonly deleteReturning: (
    id: SessionId,
    owner?: UserId,
  ) => Effect.Effect<Option.Option<UserId>, RepositoryError>;
  /**
   * RRS-003: tombstones the superseded row in a rotation — sets
   * `supersededBy`/`supersededAt`, never deletes it. Returns the
   * now-tombstoned row (its own `familyId` is what the new row inherits).
   * ESR-002: applies only to a still-live row (`supersededAt IS NULL`), so two
   * concurrent supersedes of one row cannot both tombstone it and fork its
   * family — the loser gets `NoSuchElementError`. INV-EA-018: and only a row
   * owned by `userId`; an id alone never acts on another user's session, so a
   * foreign row is `NoSuchElementError` too.
   */
  readonly tombstone: (input: {
    readonly id: SessionId;
    readonly userId: UserId;
    readonly supersededBy: SessionId;
    readonly supersededAt: DateTime.Utc;
  }) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
  /**
   * RRS-003: marks a tombstoned row's own `reusedAt`, ONCE: the statement applies only to a
   * tombstoned row whose `reusedAt` is still NULL, so of any number of concurrent presentations
   * exactly one gets `Some` (the row's family and owner) and publishes the reuse.
   */
  readonly markReusedOnce: (
    id: SessionId,
    reusedAt: DateTime.Utc,
  ) => Effect.Effect<
    Option.Option<{ readonly familyId: SessionId; readonly userId: UserId }>,
    RepositoryError
  >;
  /** RRS-003: bulk hard-deletes every still-live (non-tombstoned) row sharing `familyId` — a confirmed-compromised family has no further lineage worth preserving. */
  readonly revokeFamily: (familyId: SessionId) => Effect.Effect<void, SqlError>;
  /**
   * CSG-003: retention. Deletes up to `limit` rows whose absolute or idle expiry
   * is before `cutoff` — tombstoned rows included (they keep their original
   * expiry) — and resolves to how many went. One bounded statement, so a sweep
   * over a large backlog is a loop of short transactions, not one long lock.
   */
  readonly deleteExpiredBefore: (
    cutoff: DateTime.Utc,
    limit: number,
  ) => Effect.Effect<number, RepositoryError>;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): the one column `Sessions.reauthenticate` writes —
   * a targeted `UPDATE`, mirroring `tombstone`'s own shape, not the
   * generic `update` (which would also require supplying every other
   * `update`-variant field this call has no business touching).
   */
  readonly reauthenticate: (
    id: SessionId,
    /** BEH-EA-319: the row must belong to this user. */
    userId: UserId,
    /** The new `authenticatedAt`, and the instant liveness is judged at: a tombstoned or expired row is `NoSuchElementError`. */
    now: DateTime.Utc,
    /** THS-003: the already-unioned `amr` JSON to store; `undefined` leaves it untouched. */
    amr?: string,
    /** THS-003: with `amr`, the stored JSON the union was computed from: the write applies only if it is still that (compare-and-swap), so concurrent step-ups cannot lose a method. */
    expectedAmr?: string,
  ) => Effect.Effect<Session, Cause.NoSuchElementError | RepositoryError>;
}

export class SessionsRepository extends Context.Service<
  SessionsRepository,
  SessionsRepositoryShape
>()("awthaq/sql/SessionsRepository") {}

const DEFAULT_PAGE_SIZE = 50;

/**
 * ESR-010: the hard upper bound on any one session page. `listByUser` clamps
 * to it, and the request schema below enforces it as defense in depth, so no
 * caller-supplied limit can yield a `SqlError` (0, negative) or an unbounded
 * page.
 */
export const MAX_PAGE_SIZE = 200;

interface SessionPiiCodecs {
  readonly ipAddress: ColumnCodec;
  readonly userAgent: ColumnCodec;
}

const makeSessionsRepository = (pii: Option.Option<SessionPiiCodecs>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = makeModels(yield* resolveDialect(sql));
    const repo = yield* SqlModel.makeRepository(models.Session, {
      tableName: "sessions",
      spanPrefix: "Sessions",
      idColumn: "id",
    });

    // CSG-006: `ipAddress`/`userAgent` are the personal-data columns. With the default repository
    // these are no-ops; the encrypted variant seals them at insert (they are immutable afterwards)
    // and hands the stored cells out as `Sealed`s, from `SqlModel` or from a hand-written query alike.
    const concealPii = (
      id: string,
      columns: { readonly ipAddress: string | null; readonly userAgent: string | null },
    ) =>
      Effect.all({
        ipAddress: sealCell(
          Option.map(pii, (codecs) => codecs.ipAddress),
          id,
          columns.ipAddress,
        ),
        userAgent: sealCell(
          Option.map(pii, (codecs) => codecs.userAgent),
          id,
          columns.userAgent,
        ),
      });

    const piiOf: SessionsRepositoryShape["piiOf"] = (row) => ({
      ipAddress: sealedCell(
        Option.map(pii, (codecs) => codecs.ipAddress),
        row.id,
        row.ipAddress,
      ),
      userAgent: sealedCell(
        Option.map(pii, (codecs) => codecs.userAgent),
        row.id,
        row.userAgent,
      ),
    });

    const insert: SessionsRepositoryShape["insert"] = (input) =>
      concealPii(input.id, input).pipe(
        Effect.flatMap((columns) =>
          Effect.flatMap(Tenant.stamp(input), (stamped) =>
            repo.insert({
              ...stamped,
              ipAddress: columns.ipAddress,
              userAgent: columns.userAgent,
            }),
          ),
        ),
      );

    const findById: SessionsRepositoryShape["findById"] = (id) => repo.findById(id);

    // RRS-003: `"supersededAt" IS NULL` — load-bearing, not cosmetic. A
    // tombstoned row must never appear in a user's device list, and this
    // is also what makes `Sessions.verifyLive`/`Jwt.introspectLive`
    // correctly reject a reused/family-revoked session's JWT for free —
    // both call this same `list`.
    //
    // RRC-001: the one replica-eligible session read. Built once per client
    // (primary, and the replica when `ReadRouting.replica` is provided); the
    // default `consistency` is `"authoritative"`, i.e. the primary.
    const router = yield* ReadRouting.makeRouter;
    const pageOn = router.route((client) =>
      SqlSchema.findAll({
        Request: Schema.Struct({
          userId: UserId,
          /** SMS-002: the caller's clock (so `TestClock` controls it) — rows past either expiry are not listed. */
          now: models.wire.dateTime,
          cursorCreatedAt: models.wire.nullableDateTime,
          cursorId: Schema.NullOr(Schema.String),
          limit: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
          ),
        }),
        Result: models.Session,
        // SMS-002: the two expiry predicates make the list exactly the rows
        // `verify` would still accept (modulo the secret). PPS-002: the cursor
        // is a row-value comparison over `(createdAt, id)` so the partial
        // composite index `sessions_user_created_live` (migration 19) serves
        // both the filter and the order with no sort node.
        execute: (request) =>
          request.cursorCreatedAt === null || request.cursorId === null
            ? client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
            : client`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  AND "absoluteExpiresAt" > ${request.now}
                  AND "idleExpiresAt" > ${request.now}
                  AND ("createdAt", id) > (${request.cursorCreatedAt}, ${request.cursorId})
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`,
      }),
    );

    const listByUser: SessionsRepositoryShape["listByUser"] = (
      userId,
      now,
      cursor,
      limit,
      options,
    ) => {
      const effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      return pageOn(options?.consistency ?? "authoritative").pipe(
        Effect.flatMap((page) =>
          page({
            userId,
            now,
            cursorCreatedAt: cursor?.createdAt ?? null,
            cursorId: cursor?.id ?? null,
            limit: effectiveLimit,
          }),
        ),
        Effect.map((items): Page<Session> => {
          const last = items.at(-1);
          const nextCursor =
            items.length === effectiveLimit && last !== undefined
              ? Option.some({ createdAt: last.createdAt, id: last.id })
              : Option.none();
          return { items, nextCursor };
        }),
        traced("Sessions.listByUser", { userId }),
      );
    };

    const touchQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: SessionId,
        expectedSecretHash: Schema.String,
        secretHash: Schema.String,
        previousSecretHash: Schema.NullOr(Schema.String),
        previousSecretExpiresAt: models.wire.nullableDateTime,
        lastActiveAt: models.wire.dateTime,
        idleExpiresAt: models.wire.dateTime,
      }),
      Result: models.Session,
      // Quoted column names: this table's Postgres DDL (`CoreMigrations.ts`)
      // declares `"secretHash"`/`"lastActiveAt"`/`"idleExpiresAt"` with
      // preserved mixed case, which only an equally-quoted reference
      // matches (Postgres folds an unquoted identifier to lowercase).
      // SQLite's own identifier resolution is case-insensitive regardless
      // of quoting, so the same quoted form is safe on both dialects.
      execute: (request) => sql`
          UPDATE sessions
          SET "secretHash" = ${request.secretHash},
              "previousSecretHash" = ${request.previousSecretHash},
              "previousSecretExpiresAt" = ${request.previousSecretExpiresAt},
              "lastActiveAt" = ${request.lastActiveAt},
              "idleExpiresAt" = ${request.idleExpiresAt}
          WHERE "id" = ${request.id}
            AND "secretHash" = ${request.expectedSecretHash}
            AND "supersededAt" IS NULL
          RETURNING *
        `,
    });

    const touch: SessionsRepositoryShape["touch"] = (input) =>
      touchQuery({
        ...input,
        previousSecretHash: input.previousSecretHash ?? null,
        previousSecretExpiresAt: input.previousSecretExpiresAt ?? null,
      }).pipe(traced("Sessions.touch", { id: input.id }));

    const deleteAllForUserExceptQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, keep: SessionId }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) =>
        sql`DELETE FROM sessions WHERE "userId" = ${r.userId} AND id != ${r.keep} RETURNING id`,
    });
    const deleteAllForUserExcept: SessionsRepositoryShape["deleteAllForUserExcept"] = (
      userId,
      keep,
    ) =>
      deleteAllForUserExceptQuery({ userId, keep }).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteAllForUserExcept", { userId }),
      );

    // Quoted `"userId"`: this table's Postgres DDL (`CoreMigrations.ts`)
    // declares the column with preserved mixed case, which only an
    // equally-quoted reference matches there (Postgres folds an
    // unquoted identifier to lowercase); SQLite's own identifier
    // resolution is case-insensitive regardless of quoting, so the same
    // quoted form is correct on both dialects.
    const deleteAllByUserQuery = SqlSchema.findAll({
      Request: UserId,
      Result: Schema.Struct({ id: Schema.String }),
      execute: (userId) => sql`DELETE FROM sessions WHERE "userId" = ${userId} RETURNING id`,
    });
    const deleteAllByUser: SessionsRepositoryShape["deleteAllByUser"] = (userId) =>
      deleteAllByUserQuery(userId).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteAllByUser", { userId }),
      );

    const deleteExpiredQuery = SqlSchema.findAll({
      Request: Schema.Struct({ cutoff: models.wire.dateTime, limit: Schema.Number }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
          DELETE FROM sessions
          WHERE id IN (
            SELECT id FROM sessions
            WHERE "absoluteExpiresAt" < ${r.cutoff} OR "idleExpiresAt" < ${r.cutoff}
            LIMIT ${r.limit}
          )
          RETURNING id
        `,
    });

    const deleteExpiredBefore: SessionsRepositoryShape["deleteExpiredBefore"] = (cutoff, limit) =>
      deleteExpiredQuery({ cutoff, limit }).pipe(
        Effect.map((rows) => rows.length),
        traced("Sessions.deleteExpiredBefore"),
      );

    const liveIdsQuery = SqlSchema.findAll({
      Request: Schema.Struct({ userId: UserId, now: models.wire.dateTime }),
      Result: Schema.Struct({ id: SessionId, lastActiveAt: models.wire.dateTime }),
      execute: (request) => sql`
          SELECT id, "lastActiveAt" FROM sessions
          WHERE "userId" = ${request.userId}
            AND "supersededAt" IS NULL
            AND "actingAsId" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          ORDER BY "lastActiveAt" ASC, id ASC
        `,
    });

    const listLiveIds: SessionsRepositoryShape["listLiveIds"] = (userId, now) =>
      liveIdsQuery({ userId, now }).pipe(traced("Sessions.listLiveIds", { userId }));

    const deleteReturningQuery = SqlSchema.findAll({
      Request: Schema.Struct({ id: SessionId, owner: Schema.NullOr(UserId) }),
      Result: Schema.Struct({ userId: UserId }),
      execute: (request) =>
        request.owner === null
          ? sql`DELETE FROM sessions WHERE id = ${request.id} RETURNING "userId"`
          : sql`DELETE FROM sessions WHERE id = ${request.id} AND "userId" = ${request.owner} RETURNING "userId"`,
    });

    const deleteReturning: SessionsRepositoryShape["deleteReturning"] = (id, owner) =>
      deleteReturningQuery({ id, owner: owner ?? null }).pipe(
        Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.userId)),
        traced("Sessions.deleteReturning", { id }),
      );

    const tombstoneQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        userId: UserId,
        supersededBy: SessionId,
        supersededAt: models.wire.dateTime,
      }),
      Result: models.Session,
      execute: (request) => sql`
          UPDATE sessions
          SET "supersededBy" = ${request.supersededBy}, "supersededAt" = ${request.supersededAt}
          WHERE "id" = ${request.id} AND "userId" = ${request.userId} AND "supersededAt" IS NULL
          RETURNING *
        `,
    });

    const tombstone: SessionsRepositoryShape["tombstone"] = (input) =>
      tombstoneQuery(input).pipe(traced("Sessions.tombstone", { id: input.id }));

    // SEA-005: like every other timestamp write here, `reusedAt` goes
    // through a `Request` schema, so the dialect's own wire codec is the
    // one and only encoder (interpolating a raw `DateTime.Utc` would bind
    // its internal fields instead of a timestamp).
    const markReusedQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: SessionId, reusedAt: models.wire.dateTime }),
      Result: Schema.Struct({ familyId: SessionId, userId: UserId }),
      execute: (request) =>
        sql`UPDATE sessions SET "reusedAt" = ${request.reusedAt}
            WHERE "id" = ${request.id} AND "supersededAt" IS NOT NULL AND "reusedAt" IS NULL
            RETURNING "familyId", "userId"`,
    });

    const markReusedOnce: SessionsRepositoryShape["markReusedOnce"] = (id, reusedAt) =>
      markReusedQuery({ id, reusedAt }).pipe(traced("Sessions.markReusedOnce", { id }));

    const revokeFamily: SessionsRepositoryShape["revokeFamily"] = (familyId) =>
      sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
        Effect.asVoid,
        traced("Sessions.revokeFamily", { familyId }),
      );

    const reauthenticateQuery = SqlSchema.findOne({
      Request: Schema.Struct({
        id: SessionId,
        userId: UserId,
        now: models.wire.dateTime,
        amr: Schema.NullOr(Schema.String),
        expectedAmr: Schema.NullOr(Schema.String),
      }),
      Result: models.Session,
      execute: (request) =>
        request.expectedAmr === null
          ? sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.now},
              "amr" = COALESCE(${request.amr}, "amr")
          WHERE "id" = ${request.id}
            AND "userId" = ${request.userId}
            AND "supersededAt" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          RETURNING *
        `
          : sql`
          UPDATE sessions
          SET "authenticatedAt" = ${request.now},
              "amr" = COALESCE(${request.amr}, "amr")
          WHERE "id" = ${request.id}
            AND "userId" = ${request.userId}
            AND "amr" = ${request.expectedAmr}
            AND "supersededAt" IS NULL
            AND "absoluteExpiresAt" > ${request.now}
            AND "idleExpiresAt" > ${request.now}
          RETURNING *
        `,
    });

    const reauthenticate: SessionsRepositoryShape["reauthenticate"] = (
      id,
      userId,
      now,
      amr,
      expectedAmr,
    ) =>
      reauthenticateQuery({
        id,
        userId,
        now,
        amr: amr ?? null,
        expectedAmr: expectedAmr ?? null,
      }).pipe(traced("Sessions.reauthenticate", { id }));

    return {
      models,
      piiOf,
      insert,
      findById,
      delete: repo.delete,
      listByUser,
      touch,
      deleteAllForUserExcept,
      deleteAllByUser,
      deleteReturning,
      listLiveIds,
      tombstone,
      markReusedOnce,
      revokeFamily,
      reauthenticate,
      deleteExpiredBefore,
    };
  });

export const SessionsRepositoryLive: Layer.Layer<SessionsRepository, never, SqlClient.SqlClient> =
  Layer.effect(SessionsRepository, makeSessionsRepository(Option.none()));

/**
 * CSG-006 (option B, opt-in): `sessions.ipAddress` and `sessions.userAgent` are
 * encrypted at rest through `Encryption` (AAD `sessions:<id>:<field>`, the declared
 * `CoreSealedColumns.sessionsIpAddress`/`sessionsUserAgent`). `Persistence.sql({ encryptPii: true })`
 * chooses this layer. Rows written earlier as plaintext stay readable and are sealed on their next
 * read (`SealedColumnConfig.resealOnRead`) or `SealedColumn.sweepDeployed`. The secret hash is
 * unaffected (it is already hash-only), and lookups never filter on these columns.
 */
export const SessionsRepositoryEncryptedLive: Layer.Layer<
  SessionsRepository,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  SessionsRepository,
  Effect.all({
    ipAddress: SealedColumn.sqlCodec(CoreSealedColumns.sessionsIpAddress),
    userAgent: SealedColumn.sqlCodec(CoreSealedColumns.sessionsUserAgent),
  }).pipe(Effect.flatMap((codecs) => makeSessionsRepository(Option.some(codecs)))),
);
