# @awthaq/sql

The persistence stratum: the entities, repositories and migrations behind `@awthaq/core`'s SQL-backed services, plus the operations notes for running them. It sits below `@awthaq/core` (which re-exports its id brands) and above nothing but `@awthaq/ports` (`Encryption`). See [`spec/overview.md`](../../spec/overview.md) for the package map and [`spec/behaviors/05-persistence-stratum.md`](../../spec/behaviors/05-persistence-stratum.md) (BEH-EA-033–040) and [ADR-EA-004](../../spec/decisions/004-database-neutral-models.md) for the contract.

## What ships

| Export                | What it is                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Models`              | `makeModels(dialect)` — the `User`, `Account`, `Session`, `VerificationToken`, `VerificationReservation` `Model.Class` entities with the boolean/DateTime wire codec of the given dialect (`"pg"` or `"sqlite"`); `dialectFields(dialect)` / `resolveDialect(sql)` for record stores that declare their own `SqlSchema` structs; the id brands `UserId`, `AccountId`, `SessionId`, `VerificationTokenId` |
| `Repositories`        | one `Context.Service` + `…Live` layer each: `Users`, `Accounts` (requires `Encryption`), `Sessions`, `Verification`, `VerificationReservations` (one atomic claim), `AuditLog`. Built over the ambient `SqlClient`; none opens its own transaction (BEH-EA-035)                                                                                                                                          |
| `CoreMigrations`      | `coreMigrations` — 17 forward-only migrations for the tables above, with one `pg` and one `sqlite` branch each                                                                                                                                                                                                                                                                                           |
| `RateLimiterStoreSql` | an opt-in SQL store for `@awthaq/core`'s rate limiter, with its own migration and tracking table                                                                                                                                                                                                                                                                                                         |

Repositories resolve the dialect once, at layer construction, from the client they are given (`sql.onDialectOrElse`; anything but `pg`/`sqlite` dies), so wiring is just providing a `SqlClient` and, for accounts, `Encryption`:

```ts
const PersistenceLive = Layer.mergeAll(
  Repositories.UsersRepositoryLive,
  Repositories.AccountsRepositoryLive, // needs Encryption
  Repositories.SessionsRepositoryLive,
  Repositories.VerificationRepositoryLive,
  Repositories.VerificationReservationsRepositoryLive,
  Repositories.AuditLogRepositoryLive,
).pipe(Layer.provideMerge(SqlLive), Layer.provide(EncryptionLive));
```

## Runtimes & drivers

The package depends only on `effect`'s `SqlClient`; no driver is a runtime dependency (they are dev dependencies used by the test suites). Whatever client you provide decides where the code can run.

| Driver                                                    | Dialect  | Runs on               | Status here                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect/sql-pg`                                          | `pg`     | Node, Bun, Deno (TCP) | supported; the real-Postgres suite runs (`pnpm run test:pg`)                                                                                                                                                                                                           |
| `@effect/sql-sqlite-node`                                 | `sqlite` | Node (`node:sqlite`)  | supported; the default test target (`:memory:` and a WAL file)                                                                                                                                                                                                         |
| `@effect/sql-libsql` (libSQL / Turso, HTTP or `file:`)    | `sqlite` | edge, workers, Node   | supported; the shared contract cases and `coreMigrations` pass over a `file:` database (`test/Repositories.libsql.test.ts`), including `Migrator`'s `withTransaction`. Remote `libsql:`/`https:` URLs use the same client, but only the `file:` path is exercised here |
| `@effect/sql-d1` (Cloudflare D1), `@effect/sql-sqlite-do` | `sqlite` | workers               | **not exercised.** The `sqlite` branches use only portable SQL, but `Migrator` wraps the whole pending batch in `sql.withTransaction` and D1 has no interactive transactions, so run migrations from Node against the same database instead                            |
| `@effect/sql-pglite`                                      | `pg`     | WASM, in-process      | untested; same `pg` branches                                                                                                                                                                                                                                           |
| MySQL, MSSQL, ClickHouse                                  | —        | —                     | unsupported: `CoreMigrations` and `resolveDialect` die on them                                                                                                                                                                                                         |

The deployment split that follows from this: **edge runtimes** (Workers, Vercel Edge) do stateless work — verifying a signed JWT with `@awthaq/jwt`, presence checks — and never need a database; **origin** (Node) owns everything backed by a `SqlClient`: sessions, users, credentials, verification tokens, migrations. An edge function that must read sessions directly needs an HTTP-capable sqlite-dialect driver (libSQL/D1) and accepts the caveats in the table.

## Postgres client configuration

The repositories share the client you give them with the rest of your application, and they never override its codecs. Configure the pool for your environment; the defaults are not an operations posture.

```ts
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";

// `layerConfig` accepts a plain value or a `Config` for every field.
const PgLive = PgClient.layerConfig({
  url: Config.Redacted("DATABASE_URL"),
  maxConnections: 10, // see sizing below
  minConnections: 2,
  idleTimeout: "30 seconds",
  connectionTTL: "30 minutes", // recycle connections behind a rotating proxy / load balancer
  applicationName: "my-app-auth",
  // prepare: false,   // required behind pgbouncer in transaction-pooling mode
});
```

- **Sizing.** `maxConnections ≈ (server max_connections − headroom for admin/migrations) ÷ app instances`. Every sign-in holds a connection for the credential lookup and again for the session insert; sign-in throttling and the constant-time credential check bound how many can be in flight, so a small pool is normally enough.
- **pgbouncer (transaction mode).** Set `prepare: false` (named prepared statements do not survive between queries on a pooled server connection) and do not rely on session state. Nothing in this package does: tenant/`set_config` style settings, where used, are transaction-local.
- **Timeouts.** Set `statement_timeout` at the role level (`ALTER ROLE app SET statement_timeout = '5s'`), which works regardless of pooler. Pool exhaustion surfaces as the driver's own error; distinguishing it is an upstream `@effect/sql-pg` concern.

## Embedded SQLite in production

`@effect/sql-sqlite-node` opens the file in **WAL mode** with a **5 second busy timeout** by default. What that means for operating a file-backed `auth.db`:

- **Sidecar files.** WAL mode keeps recent writes in `auth.db-wal`, with shared-memory index `auth.db-shm`. They are part of the database: never copy `auth.db` alone while the app runs, and never delete a `-wal` file next to a database that was not cleanly closed — that discards committed transactions.
- **Live backup.** Use the client's `backup`, which copies a consistent snapshot without stopping writers (it is the SQLite online-backup API, not a file copy):

  ```ts
  import { SqliteClient } from "@effect/sql-sqlite-node";
  const backup = Effect.gen(function* () {
    const client = yield* SqliteClient.SqliteClient;
    yield* client.backup(`/backups/auth-${Date.now()}.db`);
  });
  ```

- **Checkpointing.** SQLite checkpoints the WAL into the main file automatically (every ~1000 pages). A long-lived reader can keep it from truncating; if `auth.db-wal` grows without bound, run `yield* sql\`PRAGMA wal_checkpoint(TRUNCATE)\`` from a scheduled job at a quiet moment. A clean shutdown checkpoints on its own.
- **Busy timeout.** With a single process there is no contention. If a second process (a backup tool, a migration run, `sqlite3` shell) writes concurrently, writers wait up to `busyTimeout` (`SqliteClient.layer({ filename, busyTimeout: "10 seconds" })`) and then fail with a `SqlError`. `node:sqlite` is synchronous, so a long wait blocks the event loop.
- **One writer, one instance.** SQLite serializes writers, and the WAL index lives in shared memory of one host. Run **one app instance per database file**, on a local disk (not NFS/SMB). Horizontal scale needs Postgres.

The suite proves the compare-and-swap primitives (`Sessions.touch`, `VerificationReservations.claim`) across two connections on one WAL file (`test/Repositories.file.test.ts`).

## Running migrations

`CoreMigrations.coreMigrations` is a standard `Migrator` loader, forward-only, applied in one transaction:

```ts
import { CoreMigrations } from "@awthaq/sql";
import * as Migrator from "effect/unstable/sql/Migrator";

yield * Migrator.make({})({ loader: CoreMigrations.coreMigrations });
```

**Two ledgers, on purpose.** `Migrator` records only a numeric id and skips any id at or below the newest one recorded. Core's ids (1–17) live in the default `effect_sql_migrations` table. The plugin list (`auth.migrations`, run with `@awthaq/core`'s `Migrations.run`) numbers from 1 as well, so it uses its own table, `awthaq_plugin_migrations`; the SQL rate limiter's migration uses `awthaq_rate_limiter_migrations`. Never run two id spaces against one table. Order: core first, then plugins. Plugin ids are positions in the dependency-ordered list, so on a database that has already been migrated, add new plugins at the end of the composition rather than in the middle.

### Migrating a populated database

The migrator cannot run `CREATE INDEX CONCURRENTLY` (it holds one transaction for the whole batch). The convention that makes online index builds possible: **every index migration is `CREATE [UNIQUE] INDEX IF NOT EXISTS <name>`**, and new ones must follow it. On a large Postgres table:

1. Build the index out of band, on the primary, with the same name and definition: `CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_user_id ON sessions ("userId");`
2. Deploy. The migration is recorded and its `IF NOT EXISTS` statement is a no-op (proven by `test/CoreMigrations.test.ts`).
3. For a new `NOT NULL` column: expand (add it nullable, backfill in batches), deploy code that writes it, then contract (add the constraint) in a later release.

A new _unique_ index over existing data fails if the data already violates it (for example `users_email_unique` on a database with case-insensitive duplicate emails); de-duplicate first.

## Schema conventions

- **Identifiers are quoted.** The Postgres DDL declares camelCase columns with preserved case, so every query quotes them (`"userId"`); SQLite is case-insensitive either way.
- **Timestamps.** Postgres columns are `timestamptz` (driver `Date`); SQLite columns are `TEXT` holding fixed-width UTC ISO-8601 with milliseconds (`2026-01-02T03:04:05.006Z`). That fixed width is what makes string comparison and keyset ordering correct on SQLite, and is pinned by tests; `STRICT` tables would not enforce the format, so they are not used.
- **Booleans.** `BOOLEAN` on Postgres, `0 | 1` on SQLite. `Models.makeModels(dialect)` is the only place that difference exists; every JSON variant is identical across dialects.
- **Opaque JSON is `TEXT` on every dialect** (`verification_tokens.payload`, `auth_audit_log.payload`, `users.metadata`), encoded with `Schema.fromJsonString`. A Postgres-only `JSONB` branch is added when a feature must query payload contents server-side; until then the absence is deliberate (ADR-EA-004, revision 1.1).
- **Email.** Compared by JavaScript `toLowerCase()` at the domain boundary; the unique index is `lower(email)` (BEH-EA-041).
- **Spans.** Every hand-written repository method is wrapped in a `<Prefix>.<method>` span (`Users.findByEmail`) with id-only attributes; nothing secret or personal is ever an attribute.

## Encryption at rest

What this package encrypts, and what it does not:

| Data                                                                            | At rest                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts.accessToken`, `accounts.refreshToken`                                 | **Encrypted by the application**: AES-256-GCM through `@awthaq/ports`' `Encryption`, key-id envelope, AAD `providerId:userId:field` (a ciphertext cannot be moved between rows or columns). Retired keys stay readable and are re-encrypted lazily on read; an undecryptable column degrades to `null` on identity reads and surfaces as `AccountTokenUndecryptable` on the strict read |
| `accounts.passwordHash`, `sessions.secretHash`, `verification_tokens.valueHash` | Hash only (argon2id/scrypt for passwords, SHA-256 for session and token secrets); no reversible secret is stored                                                                                                                                                                                                                                                                        |
| `sessions.ipAddress`, `sessions.userAgent`, `users.metadata`                    | Plaintext by default; **opt-in encryption** with the `…EncryptedLive` layers below                                                                                                                                                                                                                                                                                                      |
| `users.email`, `users.name`, audit payloads                                     | Plaintext. Email must stay plaintext to be looked up and to enforce uniqueness (`lower(email)`); a blind-index scheme is deliberately not built (it would change the uniqueness semantics, and there is no customer for it yet)                                                                                                                                                         |

For SOC 2 / GDPR posture, **full-disk or database-level encryption and TLS to the database are deployer responsibilities** and are assumed for every plaintext column above.

**Opt in to PII column encryption** by swapping the repository layers, which puts `Encryption` in their requirements (so forgetting to provide it is a compile error):

```ts
Repositories.SessionsRepositoryEncryptedLive; // sessions.ipAddress / userAgent, AAD `session:<id>:<field>`
Repositories.UsersRepositoryEncryptedLive; // users.metadata, AAD `user:<id>:metadata`
```

Everything above the repositories is unchanged: they hand back the same plaintext rows. Rows written earlier as plaintext keep working and are sealed on their next read (or immediately on write); `AccountsRepositoryConfig.reencryptOnRead: false` turns the read-time sealing off. A value that has the envelope shape but fails authentication (moved to another row, tampered) reads as `null` and is logged, never as plaintext. Encrypted columns cannot be filtered or indexed on, which none of these are.

## Read replicas

Off by default, and additive: with nothing configured every read uses the primary. To route display/history listings to a Postgres streaming replica, provide the replica's client once, at the top of the application (so both the repositories and the effects that capture tokens see it):

```ts
import { ReadRouting } from "@awthaq/sql";

const AppLive = Layer.mergeAll(/* … */).pipe(
  Layer.provide(ReadRouting.replica(PgReplicaLive)), // PgReplicaLive: a Layer<SqlClient> for the replica
);
```

What may read the replica is decided per read, and the default is the primary: writes, `Users`, `Accounts`, `Sessions` point reads and CAS, and everything in `Verification`/`VerificationReservations` are always primary — a revoked or rotated session is authoritative on the very next read (ADR-EA-014). Only `Sessions.listByUser(…, { consistency: "eventual" })` (a device list; never a liveness check) and `AuditLog.list` (eventual by default; pass `{ consistency: "authoritative" }` to force the primary) may use it. Read-your-writes: a service that writes and then lists on the same fiber wraps the write in `ReadRouting.captureToken`; eventual reads on that fiber then use the replica only after it has replayed past the write (Postgres: `pg_last_wal_replay_lsn()`), else the primary. The token does not cross requests yet (ADR-EA-024, decision 4). Replication lag is otherwise the replica's own; monitor it, and treat an eventual listing as up to that stale.

## Testing

```
pnpm --filter @awthaq/sql test    # :memory: SQLite, a temp-file WAL database, and the no-server Postgres decode cases
pnpm run test:pg                  # + the real-Postgres suites, against a throwaway postgres:16 container
```

`test/contract.ts` holds the dialect-neutral contract cases as one function, run by the `:memory:`, file-backed and real-Postgres suites, so a case added there runs on every dialect. `AWTHAQ_POSTGRES_URL` points the Postgres suites at an existing server instead; they drop and recreate the core tables, so use a scratch database. Without it they skip.

## Migrating from another auth system

- Auth.js / NextAuth: [`docs/migrations/authjs.md`](../../docs/migrations/authjs.md) (users, OAuth accounts, bcrypt Credentials hashes, and bridging database-strategy sessions with no forced re-login).
- Better Auth: `@awthaq/migrate-better-auth`. Auth0: `@awthaq/migrate-auth0`.
