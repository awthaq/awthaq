// @awthaq/sql — CoreMigrations
//
// Shipping-gap map (.scratch/shipping-gaps), ticket 15. Real, file-free
// migrations for the core tables `Models.ts` declares (users/accounts/
// sessions/verification_tokens/verification_reservations), built directly
// against `effect/unstable/sql`'s own `Migrator` (confirmed real by
// ticket 00's survey — a forward-only runner, `effect_sql_migrations`
// tracking table by default, whole batch in one transaction). Branches
// per dialect via `sql.onDialectOrElse` — one definition, not two
// duplicated schema files — matching the same pattern the framework's own
// `Migrator.ts` uses internally for its tracking table.
//
// Not routed through `@awthaq/core`'s `AuthPlugin`-declared
// `Migration`/`Migrations` mechanism: core's domain services (`Users`,
// `Accounts`, `Sessions`, `Verification`) are not themselves a plugin, so
// there is no `AuthPlugin.Any` to aggregate this list under. A plugin
// author following the same pattern for their own tables would instead
// declare `migrations` on their own `AuthPlugin.Service` options; `Auth.ts`
// already aggregates and dependency-orders those (`renumberMigrations`).

// N11: these ids (1-23) live in the migrator's default `effect_sql_migrations`
// ledger. The plugin list (`@awthaq/core`'s `Migrations.run`) numbers from 1
// too and therefore uses its own tracking table (`awthaq_plugin_migrations`);
// the migrator skips any id at or below the newest one recorded, so two id
// spaces must never share a ledger.
//
// SSMS-006: the migrator runs the whole pending batch in one transaction and
// has no per-migration non-transactional flag, so `CREATE INDEX CONCURRENTLY`
// cannot be a migration. Convention: every index migration is
// `CREATE [UNIQUE] INDEX IF NOT EXISTS <name>`, so an operator on a large
// populated table can build the index out of band with CONCURRENTLY first
// (same name, same definition) and the recorded migration becomes a no-op.
// New index migrations MUST follow it (see `packages/sql/README.md`,
// "Migrating a populated database").

import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * `load`'s own *resolved value* must itself be an `Effect` (or a
 * module-shaped `{ default: Effect }`, the dynamic-`import()` case a
 * file-based loader produces) — `Migrator`'s internal `loadMigration`
 * reads `.default`/`Effect.isEffect` off whatever `load` resolves to, not
 * off `load` itself. `Effect.succeed(body)` is what makes that true here.
 */
const migration = (
  id: number,
  name: string,
  sql: (client: SqlClient.SqlClient) => Effect.Effect<unknown, SqlError>,
): Migrator.ResolvedMigration => [
  id,
  name,
  Effect.succeed(
    Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient;
      yield* sql(client);
    }),
  ),
];

/**
 * Ready to pass straight to `Migrator.make({})({loader: coreMigrations, ...})`.
 * `pg`/`sqlite` are the only two branches populated — `orElse` dies rather
 * than silently no-op on a dialect this ticket never targeted (mysql is a
 * documented `v1.x` target per `research/10-schema-migrations.md`, not
 * this one).
 */
export const coreMigrations: Migrator.Loader<never> = Effect.succeed([
  migration(1, "create_users", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          "emailVerified" BOOLEAN NOT NULL,
          name TEXT NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        )`,
      sqlite: () => sql`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          emailVerified INTEGER NOT NULL,
          name TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  migration(2, "create_accounts", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          "userId" TEXT NOT NULL,
          "providerId" TEXT NOT NULL,
          subject TEXT NOT NULL,
          issuer TEXT NOT NULL DEFAULT '',
          "passwordHash" TEXT,
          "accessToken" TEXT,
          "refreshToken" TEXT,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL,
          UNIQUE ("providerId", subject, issuer)
        )`,
      sqlite: () => sql`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          providerId TEXT NOT NULL,
          subject TEXT NOT NULL,
          issuer TEXT NOT NULL DEFAULT '',
          passwordHash TEXT,
          accessToken TEXT,
          refreshToken TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          UNIQUE (providerId, subject, issuer)
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  migration(3, "create_sessions", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          "userId" TEXT NOT NULL,
          "secretHash" TEXT NOT NULL,
          "ipAddress" TEXT,
          "userAgent" TEXT,
          "absoluteExpiresAt" TIMESTAMPTZ NOT NULL,
          "idleExpiresAt" TIMESTAMPTZ NOT NULL,
          "createdAt" TIMESTAMPTZ NOT NULL,
          "lastActiveAt" TIMESTAMPTZ NOT NULL,
          "actingAsType" TEXT,
          "actingAsId" TEXT
        )`,
      sqlite: () => sql`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          secretHash TEXT NOT NULL,
          ipAddress TEXT,
          userAgent TEXT,
          absoluteExpiresAt TEXT NOT NULL,
          idleExpiresAt TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          lastActiveAt TEXT NOT NULL,
          actingAsType TEXT,
          actingAsId TEXT
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  migration(4, "create_verification_tokens", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE TABLE verification_tokens (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL,
          "valueHash" TEXT NOT NULL,
          "expiresAt" TIMESTAMPTZ NOT NULL,
          "consumedAt" TIMESTAMPTZ,
          "createdAt" TIMESTAMPTZ NOT NULL,
          payload TEXT NOT NULL
        )`,
      sqlite: () => sql`
        CREATE TABLE verification_tokens (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL,
          valueHash TEXT NOT NULL,
          expiresAt TEXT NOT NULL,
          consumedAt TEXT,
          createdAt TEXT NOT NULL,
          payload TEXT NOT NULL
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  migration(5, "create_verification_tokens_live_identifier_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS verification_tokens_live_identifier
        ON verification_tokens(identifier) WHERE "consumedAt" IS NULL`,
      sqlite: () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS verification_tokens_live_identifier
        ON verification_tokens(identifier) WHERE consumedAt IS NULL`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  migration(6, "create_verification_reservations", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE TABLE verification_reservations (
          identifier TEXT PRIMARY KEY,
          "expiresAt" TIMESTAMPTZ NOT NULL
        )`,
      sqlite: () => sql`
        CREATE TABLE verification_reservations (
          identifier TEXT PRIMARY KEY,
          expiresAt TEXT NOT NULL
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // Upstream-hardening map, ticket 03: `Users.ts`'s own header comment and
  // `layerSql.create`'s `UniqueViolation` handling both already assumed
  // this constraint existed — it never did, so a real database silently
  // accepted duplicate emails until this migration. A functional index
  // over `lower(email)`, matching the app-level `.toLowerCase()`
  // normalization `Users.ts` already does before every insert.
  //
  // This migrator is forward-only and whole-batch (no per-migration data
  // fixup step) — on a real, already-deployed database that has
  // accumulated case-insensitive duplicate emails (the exact condition
  // this migration closes off, previously unenforced), this `CREATE
  // UNIQUE INDEX` fails and blocks migrations 8/9 behind it. No such
  // database exists yet (`"private": true`, no package published), so
  // this doesn't fire today; a real deployment inheriting dirty data
  // would need a one-time out-of-band de-duplication pass before this
  // migration can run, the ordinary operational cost of adding any
  // uniqueness constraint after the fact.
  migration(7, "create_users_email_unique_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`,
      sqlite: () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // Ticket 03: `accounts.userId` is a real filter key (`Repositories.ts`'s
  // `listByUser`/`deleteAllByUser`), unindexed until now.
  migration(8, "create_accounts_user_id_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE INDEX IF NOT EXISTS accounts_user_id ON accounts("userId")`,
      sqlite: () => sql`CREATE INDEX IF NOT EXISTS accounts_user_id ON accounts(userId)`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // Ticket 03: `sessions.userId` is a real filter key (`Repositories.ts`'s
  // `listByUser`/`deleteAllForUserExcept`), unindexed until now.
  migration(9, "create_sessions_user_id_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions("userId")`,
      sqlite: () => sql`CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(userId)`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // RRS-003 — .scratch/resolve-ready-for-human-findings/issues/
  // 11-token-lifecycle-store.md: refresh-token reuse detection and token
  // families for the `supersedes` rotation path. `familyId` has no
  // `NOT NULL`/backfill concern (this repo has no real deployment yet —
  // `Models.ts`'s own header comment — so there are no pre-existing rows
  // to migrate); every new row always supplies it explicitly.
  migration(10, "add_sessions_reuse_detection_columns", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        ALTER TABLE sessions
          ADD COLUMN "familyId" TEXT,
          ADD COLUMN "supersededBy" TEXT,
          ADD COLUMN "supersededAt" TIMESTAMPTZ,
          ADD COLUMN "reusedAt" TIMESTAMPTZ`,
      sqlite: () =>
        sql`
        ALTER TABLE sessions ADD COLUMN familyId TEXT`.pipe(
          Effect.andThen(sql`ALTER TABLE sessions ADD COLUMN supersededBy TEXT`),
          Effect.andThen(sql`ALTER TABLE sessions ADD COLUMN supersededAt TEXT`),
          Effect.andThen(sql`ALTER TABLE sessions ADD COLUMN reusedAt TEXT`),
        ),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // RRS-003: `familyId` is the walk key `revokeFamily` bulk-deletes on;
  // `supersededAt` is the filter every `listByUser`/reuse-check query
  // applies on nearly every read.
  migration(11, "create_sessions_reuse_detection_indexes", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE INDEX IF NOT EXISTS sessions_family_id ON sessions("familyId")`,
      sqlite: () => sql`CREATE INDEX IF NOT EXISTS sessions_family_id ON sessions(familyId)`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
  // (AAPS-001/BPAS-001): "when this session last proved a credential" — a
  // real column, not a computed value, since `reauthenticate` writes it
  // independently of `createdAt`. Backfilled from `createdAt` for every
  // pre-existing row (no session is retroactively treated as stale) —
  // this repo has no real deployment yet (`Models.ts`'s own header
  // comment), so this backfill is a no-op today, same posture as
  // migration 10's own `familyId` comment.
  migration(12, "add_sessions_authenticated_at_column", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`ALTER TABLE sessions ADD COLUMN "authenticatedAt" TIMESTAMPTZ`.pipe(
          Effect.andThen(
            sql`UPDATE sessions SET "authenticatedAt" = "createdAt" WHERE "authenticatedAt" IS NULL`,
          ),
        ),
      sqlite: () =>
        sql`ALTER TABLE sessions ADD COLUMN authenticatedAt TEXT`.pipe(
          Effect.andThen(
            sql`UPDATE sessions SET authenticatedAt = createdAt WHERE authenticatedAt IS NULL`,
          ),
        ),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 01
  // (ALF-001/ESA-001/ESS-002/CSG-004/EP-002): BEH-EA-100's durable audit
  // table. `payload` is an opaque JSON envelope, the same
  // `verification_tokens.payload` precedent migration 4 already
  // establishes — a new `AuthEvent` tag needs no migration to be durably
  // recorded. `correlationId` is reserved, unpopulated until ALF-006.
  migration(13, "create_auth_audit_log", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`
        CREATE TABLE auth_audit_log (
          id TEXT PRIMARY KEY,
          "eventTag" TEXT NOT NULL,
          "actorUserId" TEXT,
          "occurredAt" TIMESTAMPTZ NOT NULL,
          "correlationId" TEXT,
          payload TEXT NOT NULL
        )`.pipe(
          Effect.andThen(
            sql`CREATE INDEX IF NOT EXISTS auth_audit_log_event_tag ON auth_audit_log ("eventTag")`,
          ),
          Effect.andThen(
            sql`CREATE INDEX IF NOT EXISTS auth_audit_log_actor_user_id ON auth_audit_log ("actorUserId")`,
          ),
        ),
      sqlite: () =>
        sql`
        CREATE TABLE auth_audit_log (
          id TEXT PRIMARY KEY,
          "eventTag" TEXT NOT NULL,
          "actorUserId" TEXT,
          "occurredAt" TEXT NOT NULL,
          "correlationId" TEXT,
          payload TEXT NOT NULL
        )`.pipe(
          Effect.andThen(
            sql`CREATE INDEX IF NOT EXISTS auth_audit_log_event_tag ON auth_audit_log ("eventTag")`,
          ),
          Effect.andThen(
            sql`CREATE INDEX IF NOT EXISTS auth_audit_log_actor_user_id ON auth_audit_log ("actorUserId")`,
          ),
        ),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // AOMS-001/AOMS-002 (.issues/high): free-form JSON metadata, mirroring
  // `organization_org.metadata`'s own free-form-string column (migration
  // reference in `@awthaq/organization`'s own repository) — an IdP
  // import's `user_metadata`/`app_metadata` (Auth0), or any other
  // application-level per-user attribute, otherwise has nowhere to land.
  // `NULL`, not `''`, means "no metadata set" (`UserRecord.metadata`'s own
  // `Option.Option<string>`).
  migration(14, "add_users_metadata_column", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE users ADD COLUMN metadata TEXT`,
      sqlite: () => sql`ALTER TABLE users ADD COLUMN metadata TEXT`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // BCR-003 (.issues/high): nullable — an OAuth sign-in flow's own state
  // token (`@awthaq/oauth`) has no real user at issue time, unlike
  // verify-email/reset-password tokens, which always do. Lets
  // `Account.ts`'s own `deleteUser` cascade (`packages/server`) sweep a
  // deleted user's still-live tokens, the same gap `accounts`/`sessions`
  // already closed via their own `userId` column + `deleteAllByUser`.
  migration(15, "add_verification_tokens_user_id_column", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE verification_tokens ADD COLUMN "userId" TEXT`,
      sqlite: () => sql`ALTER TABLE verification_tokens ADD COLUMN userId TEXT`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // `deleteAllByUser`'s own real filter key, unindexed until now — the same
  // class of gap migrations 8/9 already closed for `accounts`/`sessions`.
  migration(16, "create_verification_tokens_user_id_index", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`CREATE INDEX IF NOT EXISTS verification_tokens_user_id ON verification_tokens("userId")`,
      sqlite: () =>
        sql`CREATE INDEX IF NOT EXISTS verification_tokens_user_id ON verification_tokens(userId)`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // BE-002 (.issues/high): `accessToken`/`refreshToken` (migration 2) were
  // already persisted and encrypted at rest but had nowhere to carry their
  // own expiry, scope, or token type — `@awthaq/core`'s `Accounts.ts` gains
  // `findProviderTokens`/`updateProviderTokens` alongside this migration.
  // All four columns nullable: an existing row's `NULL` here means "no
  // stored token metadata for this pre-existing link," which is simply
  // true, not a backfill gap.
  migration(17, "add_accounts_provider_token_metadata_columns", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`ALTER TABLE accounts ADD COLUMN "accessTokenExpiresAt" TIMESTAMPTZ`.pipe(
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN "refreshTokenExpiresAt" TIMESTAMPTZ`),
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN scope TEXT`),
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN "tokenType" TEXT`),
        ),
      sqlite: () =>
        sql`ALTER TABLE accounts ADD COLUMN accessTokenExpiresAt TEXT`.pipe(
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN refreshTokenExpiresAt TEXT`),
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN scope TEXT`),
          Effect.andThen(sql`ALTER TABLE accounts ADD COLUMN tokenType TEXT`),
        ),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // BAM-008: the provider's OIDC `id_token`, stored (encrypted at rest, like
  // `accessToken`/`refreshToken`) so a better-auth import has a destination
  // and RP-initiated logout can send `id_token_hint`. Nullable: an existing
  // row's `NULL` is simply "no stored id_token for this pre-existing link".
  migration(18, "add_accounts_id_token_column", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE accounts ADD COLUMN "idToken" TEXT`,
      sqlite: () => sql`ALTER TABLE accounts ADD COLUMN idToken TEXT`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // PPS-002/SEA-006/SSMS-008: the session device-list page query filters on
  // `userId` and live (`supersededAt IS NULL`) rows and orders by
  // `(createdAt, id)`. The single-column `sessions_user_id` index forced a
  // sort of the user's whole row set; this partial composite index matches
  // filter and order. `sessions_user_id` stays — bulk deletes also remove
  // tombstoned rows, which this partial index excludes. `IF NOT EXISTS`
  // keeps an out-of-band `CREATE INDEX CONCURRENTLY` (a large table) possible.
  migration(19, "create_sessions_user_created_live_index", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`CREATE INDEX IF NOT EXISTS sessions_user_created_live ON sessions("userId", "createdAt", id) WHERE "supersededAt" IS NULL`,
      sqlite: () =>
        sql`CREATE INDEX IF NOT EXISTS sessions_user_created_live ON sessions("userId", "createdAt", id) WHERE "supersededAt" IS NULL`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // THS-003/APS-007: RFC 8176 `amr` — the authentication methods that proved a
  // session, a JSON array of strings. NOT NULL with a `'[]'` default so every
  // pre-existing row reads as "no recorded methods" rather than needing a
  // backfill.
  migration(20, "add_sessions_amr_column", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE sessions ADD COLUMN amr TEXT NOT NULL DEFAULT '[]'`,
      sqlite: () => sql`ALTER TABLE sessions ADD COLUMN amr TEXT NOT NULL DEFAULT '[]'`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // FAMS-002/SAM-003 (wayfinder ticket 09): a user may have no email (a phone
  // or anonymous identity). Postgres drops the constraint in place; SQLite has
  // no `ALTER COLUMN`, so the table is rebuilt (create, copy, drop, rename,
  // re-index) — kept *before* the identity columns are added (id 22), so this
  // rebuild only ever names the columns that existed at id 20 and any later
  // column is a plain `ADD COLUMN`. `users_email_unique` is a full index over
  // `lower(email)`; NULLs are distinct in both engines, so any number of
  // email-less rows coexist with it unchanged.
  migration(21, "make_users_email_nullable", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`,
      sqlite: () =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE users_rebuild (
              id TEXT PRIMARY KEY,
              email TEXT,
              emailVerified INTEGER NOT NULL,
              name TEXT NOT NULL,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              metadata TEXT
            )`;
          yield* sql`
            INSERT INTO users_rebuild (id, email, emailVerified, name, createdAt, updatedAt, metadata)
            SELECT id, email, emailVerified, name, createdAt, updatedAt, metadata FROM users`;
          yield* sql`DROP TABLE users`;
          yield* sql`ALTER TABLE users_rebuild RENAME TO users`;
          yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email))`;
        }),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // FAMS-002/SCP-001/BAM-009: phone identity, suspension state and the profile
  // image. Every existing row reads as an active, phone-less, image-less user
  // — no backfill. `phoneVerified` mirrors `emailVerified`.
  migration(22, "add_users_identity_status_image_columns", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        Effect.gen(function* () {
          yield* sql`ALTER TABLE users ADD COLUMN phone TEXT`;
          yield* sql`ALTER TABLE users ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT FALSE`;
          yield* sql`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`;
          yield* sql`ALTER TABLE users ADD COLUMN "statusReason" TEXT`;
          yield* sql`ALTER TABLE users ADD COLUMN "suspendedUntil" TIMESTAMPTZ`;
          yield* sql`ALTER TABLE users ADD COLUMN image TEXT`;
        }),
      sqlite: () =>
        Effect.gen(function* () {
          yield* sql`ALTER TABLE users ADD COLUMN phone TEXT`;
          yield* sql`ALTER TABLE users ADD COLUMN phoneVerified INTEGER NOT NULL DEFAULT 0`;
          yield* sql`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`;
          yield* sql`ALTER TABLE users ADD COLUMN statusReason TEXT`;
          yield* sql`ALTER TABLE users ADD COLUMN suspendedUntil TEXT`;
          yield* sql`ALTER TABLE users ADD COLUMN image TEXT`;
        }),
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // FAMS-002: phone numbers are unique across users; a partial index so the
  // (many) email/anonymous rows with no phone never collide on NULL.
  migration(23, "create_users_phone_unique_index", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL`,
      sqlite: () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // ALF-010: `AuditLog.list`'s `occurredAfter`/`occurredBefore` range and the
  // retention sweep's `occurredAt < cutoff` delete both filter on the timestamp,
  // which had no index (only the tag and actor columns did). `IF NOT EXISTS`
  // keeps an out-of-band `CREATE INDEX CONCURRENTLY` (a large table) possible.
  migration(24, "create_auth_audit_log_occurred_at_index", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`CREATE INDEX IF NOT EXISTS auth_audit_log_occurred_at ON auth_audit_log ("occurredAt")`,
      sqlite: () =>
        sql`CREATE INDEX IF NOT EXISTS auth_audit_log_occurred_at ON auth_audit_log ("occurredAt")`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
  // CWM-004: the event relay's persisted position — one row per named relay holding the
  // id of the last audit event it delivered (`auth_audit_log.id`, a time-ordered uuidv7),
  // so a restart resumes instead of redelivering the whole log or skipping ahead.
  migration(25, "create_auth_relay_cursor", (sql) =>
    sql.onDialectOrElse({
      pg: () =>
        sql`
        CREATE TABLE auth_relay_cursor (
          name TEXT PRIMARY KEY,
          "lastEventId" TEXT NOT NULL,
          "updatedAt" TIMESTAMPTZ NOT NULL
        )`,
      sqlite: () =>
        sql`
        CREATE TABLE auth_relay_cursor (
          name TEXT PRIMARY KEY,
          "lastEventId" TEXT NOT NULL,
          "updatedAt" TEXT NOT NULL
        )`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    }),
  ),
]);
