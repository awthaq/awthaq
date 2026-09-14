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
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
    }),
  ),
  migration(5, "create_verification_tokens_live_identifier_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`
        CREATE UNIQUE INDEX verification_tokens_live_identifier
        ON verification_tokens(identifier) WHERE "consumedAt" IS NULL`,
      sqlite: () => sql`
        CREATE UNIQUE INDEX verification_tokens_live_identifier
        ON verification_tokens(identifier) WHERE consumedAt IS NULL`,
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
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
      pg: () => sql`CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`,
      sqlite: () => sql`CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`,
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
    }),
  ),
  // Ticket 03: `accounts.userId` is a real filter key (`Repositories.ts`'s
  // `listByUser`/`deleteAllByUser`), unindexed until now.
  migration(8, "create_accounts_user_id_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE INDEX accounts_user_id ON accounts("userId")`,
      sqlite: () => sql`CREATE INDEX accounts_user_id ON accounts(userId)`,
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
    }),
  ),
  // Ticket 03: `sessions.userId` is a real filter key (`Repositories.ts`'s
  // `listByUser`/`deleteAllForUserExcept`), unindexed until now.
  migration(9, "create_sessions_user_id_index", (sql) =>
    sql.onDialectOrElse({
      pg: () => sql`CREATE INDEX sessions_user_id ON sessions("userId")`,
      sqlite: () => sql`CREATE INDEX sessions_user_id ON sessions(userId)`,
      orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
    }),
  ),
]);
