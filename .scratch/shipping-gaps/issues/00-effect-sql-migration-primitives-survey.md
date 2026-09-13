# 00 — Effect v4 SQL/migration primitives survey

**Type:** research
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

`packages/sql` today is a thin, dialect-agnostic repository layer
(`Repositories.ts`, `Models.ts`) with no real database driver behind it,
and `packages/core/src/Migrations.ts` is a scaffold with no executed
migrator anywhere in the repo. Ticket 03 (persistent SQL backend &
migrations) needs to decide what to build on top of, and that decision
should be grounded in what Effect v4 itself actually offers — not
guessed at or copied from upstream's Drizzle-based approach.

What does `../effect`'s own source currently provide for: (a) a real SQL
client/driver layer (Postgres specifically — `effect/sql-pg` or
equivalent, exact module path and API shape in this checked-out version),
(b) a migrator/migration-runner primitive, if one exists, and its
expected file/table conventions, and (c) transactional composition
(anything resembling upstream's `withTransaction`) — is that a first-class
`SqlClient` primitive already, or would it need to be hand-rolled on top
of a lower-level transaction API? Cite exact file paths and export names
from `../effect`, not documentation from memory.

## Answer

Verified checkout: `/Users/mohammadalmechkor/Projects/Perso/effect` (sibling of
`effect-auth` under `Perso/`, matching `../effect`). This is the Effect v4
monorepo (`packages/effect`, `packages/sql/*`, etc).

### (a) Real Postgres client/driver layer — yes, `@effect/sql-pg`

Package: `packages/sql/pg` (npm name `@effect/sql-pg`, version
`4.0.0-rc.115` per `packages/sql/pg/package.json:2`). Native wire-protocol
client (not a wrapper over `postgres.js`/`pg`) — see the module doc comment
at `packages/sql/pg/src/PgClient.ts:1-3` ("PostgreSQL support for Effect
SQL, backed by the native wire protocol client"). Package `exports` map
(`packages/sql/pg/package.json`) publishes `.` → `./src/index.ts` and
`./*` → `./src/*.ts`, and `packages/sql/pg/src/index.ts` re-exports
`PgClient`, `PgMigrator`, `PgPool`, `PgConnection`, `PgAuth`, `PgTypes`,
`PgProtocol` as namespaces. So a consumer imports
`import { PgClient } from "@effect/sql-pg"` or the direct submodule
`@effect/sql-pg/PgClient`.

Service/tag: `PgClient.ts:72` — `export const PgClient =
Context.Service<PgClient>("@effect/sql-pg/PgClient")`. The `PgClient`
interface (`PgClient.ts:51-67`) extends the core `Client.SqlClient`
(imported as `effect/unstable/sql/SqlClient`), i.e. it *is* a
`SqlClient`-shaped service plus Postgres extras (`.json`, `.listen`,
`.notify`, `.config`).

Config: `PgClientConfig` (`PgClient.ts:80-124`, fields: `url`, `host`,
`port`, `path`, `ssl`, `database`, `username`, `password`,
`connectTimeout`, `applicationName`, `transformResultNames`/
`transformQueryNames`/`transformJson`, `types`, `multiplex`/
`multiplexConcurrency`, `prepare`, `preparedStatementCacheSize`,
`maxMessageSize`) and `PgPoolConfig extends PgClientConfig`
(`PgClient.ts:131-138`, adds `idleTimeout`, `maxConnections`,
`minConnections`, `connectionTTL`).

Layer constructors, all in `PgClient.ts`:
- `make(options: PgPoolConfig): Effect.Effect<PgClient, SqlError, Scope.Scope | Reactivity.Reactivity>` (`PgClient.ts:145`) — scoped pooled client.
- `layerFrom(acquire): Layer.Layer<PgClient | Client.SqlClient, E, ...>` (`PgClient.ts:317-325`) — puts *both* the `PgClient` tag and the generic `effect/unstable/sql/SqlClient` tag into the same context (`Context.make(PgClient, client).pipe(Context.add(Client.SqlClient, client))`), so downstream code can depend on either the Postgres-specific or the dialect-agnostic tag.
- `layerConfig(config: Config.Wrap<PgPoolConfig>): Layer.Layer<PgClient | Client.SqlClient, Config.ConfigError | SqlError>` (`PgClient.ts:333-339`) — build from an Effect `Config.Wrap`, i.e. environment/config-provider-driven connection settings.
- `layer(config: PgPoolConfig): Layer.Layer<PgClient | Client.SqlClient, SqlError>` (`PgClient.ts:347-349`) — build from a plain config object.

So: yes, a real, actively-maintained Postgres driver/layer exists; it is
not a stub. A consumer provides connection info via `PgPoolConfig` and
gets both `PgClient` and the generic `SqlClient` service out of one
`Layer.layer(...)` / `Layer.layerConfig(...)` call.

### (b) Migrator — yes, both a dialect-agnostic core primitive and a Postgres-specific wrapper

Core (dialect-agnostic) migrator: `packages/effect/src/unstable/sql/Migrator.ts`,
published subpath `effect/unstable/sql` (barrel export, see
`packages/effect/package.json:50` — `"./unstable/sql":
"./src/unstable/sql/index.ts"`; the barrel at
`packages/effect/src/unstable/sql/index.ts:10` re-exports `Migrator` as a
namespace, so consumers do `import { Migrator } from
"effect/unstable/sql"`; there is no separate `effect/unstable/sql/Migrator`
subpath in the exports map).

Key exports (all in `Migrator.ts`):
- `MigratorOptions<R>` (`Migrator.ts:29-33`): `{ loader: Loader<R>; schemaDirectory?: string; table?: string }`.
- `Loader<R>` / `ResolvedMigration` (`Migrator.ts:42-59`): a loader resolves to `[id: number, name: string, load: Effect<any, any, SqlClient>]` tuples.
- `Migration` (`Migrator.ts:68-72`): `{ id, name, createdAt }` — the row shape read back from the tracking table.
- `MigrationError` (`Migrator.ts:80-90`), a `Data.TaggedError` with `kind: "BadState" | "ImportError" | "Failed" | "Duplicates" | "Locked"`.
- `make(...)` (`Migrator.ts:100-322`) — the actual migrator factory. It is parameterized by a `dumpSchema` callback (used by driver packages to plug in e.g. `pg_dump`) and returns a runner over `MigratorOptions`.
- Four loader constructors: `fromGlob` (`Migrator.ts:337-352`), `fromBabelGlob` (`Migrator.ts:362-375`), `fromRecord` (`Migrator.ts:384-397`), `fromFileSystem(directory): Loader<FileSystem | Path>` (`Migrator.ts:414-453`).

Conventions:
- Tracking table defaults to `effect_sql_migrations` (`Migrator.ts:111`, `table = "effect_sql_migrations"`), overridable via `MigratorOptions.table`.
- Table schema is dialect-specific but structurally the same everywhere: `migration_id` (int, PK), `name` (text/varchar), `created_at` (timestamp, defaulted) — see the per-dialect DDL at `Migrator.ts:120-151` (`sql.onDialectOrElse({ mssql, mysql, pg, orElse })`). For Postgres specifically (`Migrator.ts:135-144`): `CREATE TABLE ${table} (migration_id integer primary key, created_at timestamp with time zone not null default now(), name text not null)`, guarded by a `select ${table}::regclass` existence check.
- File-based migrations (`fromFileSystem` and `fromGlob`) are matched by the regex at `Migrator.ts:427` / `Migrator.ts:342`: `^(?:.*\/)?(\d+)_([^.]+)\.(js|ts|mjs|mts)$` — i.e. `<numeric-id>_<name>.{js,ts,mjs,mts}`, sorted ascending by numeric id. Each file's default export must be an `Effect` (or a value with a `.default` that is one) run against `SqlClient` — see `loadMigration` (`Migrator.ts:177-205`).
- **No down/rollback migrations** — this is forward-only. There is no file-naming convention or API for a "down" migration; `MigratorOptions`, `ResolvedMigration`, and every loader only ever resolve one effect per migration id.
- The whole batch of pending migrations runs inside one `sql.withTransaction(run)` call (`Migrator.ts:307-308`), and a `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` is taken first on Postgres (`Migrator.ts:224-227`) to serialize concurrent migration runs; a unique-constraint conflict on the insert is caught and turned into `MigrationError({ kind: "Locked" })` (`Migrator.ts:265-273`) rather than crashing concurrent deployers.
- Duplicate migration ids in the resolved set fail fast with `MigrationError({ kind: "Duplicates" })` (`Migrator.ts:240-245`).

Postgres-specific wrapper: `packages/sql/pg/src/PgMigrator.ts`. It does
`export * from "effect/unstable/sql/Migrator"` (`PgMigrator.ts:27`) so it
is a drop-in superset of the core module, and adds:
- `run: <R2>(options: MigratorOptions<R2>) => Effect<[id, name][], MigrationError | SqlError, SqlClient | PgClient | ChildProcessSpawner | FileSystem | Path | R2>` (`PgMigrator.ts:35-101`) — calls `Migrator.make({ dumpSchema })` where `dumpSchema` shells out to `pg_dump` (via `effect/unstable/process/ChildProcess` + `ChildProcessSpawner`) to write `<schemaDirectory>/_schema.sql` after migrations complete, stripping comments/`SET`/`pg_catalog` noise (`PgMigrator.ts:47-99`).
- `layer: <R>(options: MigratorOptions<R>) => Layer.Layer<never, MigrationError | SqlError, SqlClient | PgClient | ChildProcessSpawner | FileSystem | Path | R>` (`PgMigrator.ts:109-120`) — `Layer.effectDiscard(run(options))`, i.e. migrations run as a layer-construction side effect (fits an app-startup composition model).

So: not just a scaffold on the effect-auth side — the framework itself
ships a real, tested migrator (integration tests exist at
`packages/sql/pg/test/PgConnection.integration.test.ts` etc.) with
concrete table/file conventions, and Postgres gets first-class schema-dump
support on top of it.

### (c) Transactional composition — first-class `SqlClient.withTransaction`, not hand-rolled

`packages/effect/src/unstable/sql/SqlClient.ts:39` defines `export
interface SqlClient extends Constructor { ... }`, and the transaction
method is part of that same core interface (not Postgres-specific, not an
add-on):

```
// SqlClient.ts:57-59
readonly withTransaction: <R, E, A>(
  self: Effect.Effect<A, E, R>
) => Effect.Effect<A, E | SqlError, R>
```

i.e. `SqlClient.withTransaction` wraps an arbitrary `Effect<A, E, R>` and
guarantees every `sql` query run inside it shares one transaction/
connection, surfacing only `E | SqlError`. The tag is `SqlClient.ts:95` —
`export const SqlClient = Context.Service<SqlClient>("effect/sql/SqlClient")`.
There's also a paired `transactionService: Context.Service<TransactionConnection, ...>`
on the same interface (`SqlClient.ts:64`) for lower-level access to the
in-flight transaction connection, but ordinary transactional composition
doesn't need it — `withTransaction` is the primitive to reach for.

This is exercised internally by the migrator itself
(`Migrator.ts:307-308`: `sql.withTransaction(run)`) and is available on
every driver's `SqlClient`/`PgClient` implementation because `PgClient`
(`packages/sql/pg/src/PgClient.ts:51`) `extends Client.SqlClient`. A
Postgres-specific transaction-acquisition test also exists at
`packages/sql/pg/test/TransactionAcquire.test.ts`, and `PgClient.make`
wires a `transactionAcquirer` (`PgClient.ts:145-149`) into the underlying
implementation that backs `withTransaction`.

**Conclusion for ticket 03:** no framework-level gap here. A real,
maintained Postgres driver (`@effect/sql-pg` → `PgClient`), a
forward-only file/table-convention migrator (`effect/unstable/sql`'s
`Migrator.make` plus the Postgres `PgMigrator` schema-dump wrapper), and
first-class transaction composition (`SqlClient.withTransaction`) all
already exist in this Effect v4 checkout. Ticket 03 does not need to
invent any of these three primitives; it only needs to decide how
`effect-auth`'s existing `packages/sql` (`Repositories.ts`/`Models.ts`)
and `packages/core/src/Migrations.ts` scaffold should be re-pointed at
them (e.g. whether `Migrations.ts` becomes a thin re-export of
`effect/unstable/sql`'s `Migrator`, and whether repositories consume
`SqlClient` directly or the Postgres-specific `PgClient`).
