# Schema & Migrations — Research

Answers Q72–Q81 (Persistence & schema) for PRD v2. All versions verified against registries/docs on 2026-09-12.

## TL;DR

- Effect ecosystem state as of 2026-09: `effect` npm `latest` = **3.22.2**; **Effect v4 is in beta** and `@effect/sql` dialect packages already have `4.0.0-rc.115` dist-tags — v1 of effect-auth should target the v3 line and treat `@effect/sql`'s core modules (Migrator, SqlClient, Statement, SqlSchema, SqlResolver) as the substrate.
- `@effect/sql`'s stock `Migrator` is **single-transaction, ids-only, no checksums, no dry-run, no drift detection** (verified in source). It is a fine runtime "apply" for simple apps but is **not** the migration engine effect-auth needs; we should build our own planner/CLI and can reuse its ledger-lock idea.
- `@effect/sql`'s PG client already exposes `transformQueryNames`/`transformResultNames` (camelCase↔snake_case at the client) and pool sizing (`maxConnections`/`minConnections`/`connectionTTL`); Drizzle has a `casing` mapping option; both are prior art for Q76 enforcement-in-tooling rather than docs-only.
- The winning workflow shape is **Drizzle-kit's snapshot diff** (diff IR snapshot vs previous snapshot — never the live DB, so CI is deterministic) **plus Atlas's guardrails** (review policy, destructive-change lint, plan files, advisory locks) **plus Prisma's drift detection** (optional `--from-database` check with non-zero exit).
- Alembic's documented limitation is the strongest argument for our IR: autogenerate **cannot detect unnamed constraints** and cannot detect renames — so the IR must emit explicit names for every constraint and should treat column/table renames as explicit, opt-in operations.
- DDL reality per dialect: PG = fast defaults + `NOT VALID`/`VALIDATE` two-phase + `CREATE INDEX CONCURRENTLY` (which **cannot run in a transaction**); SQLite = ALTER supports only rename/add column/drop column (drop restricted: fails on PK/UNIQUE/indexed/FK/CHECK-referenced columns; `ALTER COLUMN ... SET/DROP NOT NULL` only since **3.53.0, 2026-04-09**); MySQL 8.4 = `INSTANT` is the default algorithm including `DROP COLUMN` (bounded by a per-table row-version limit).
- RETURNING: PG native; SQLite since 3.35; **MySQL has none** — the repository contract must make "insert → get row back" dialect-mediated (insertId re-select on MySQL).
- D1 works today via `@effect/sql-d1` (0.50.0), but has no client-side transactions (`batch()` is the atomicity unit) and uses `PRAGMA defer_foreign_keys` — a v1 design goal is repositories that can run in "batch mode".
- Plugin schema policy: allow primitive "flag" columns on `user` via `extensions` (better-auth's `additionalFields` prior art), default everything else to plugin-owned side tables; conflict resolution is core → topo-ordered plugin priority → hard error.
- Imports from better-auth / Auth.js / Lucia are tractable because all three use the same four-table shape (user/account/session/verification(-token)) and store PHC-format password hashes — an algorithm-tagged `password_hash` column makes imports a data copy plus rehash-on-login.

## Questions answered

### Q72 — Repository interfaces: surface, pagination, transactions

Evidence:
- `@effect/sql` ships the exact primitives a repository layer needs (verified from package exports and source): `SqlClient` (tag + `withTransaction`), `Statement` (tagged-template compiler with `.withoutTransform`, insert/update helpers with `.returning`), `SqlSchema` (typed single/void/array query constructors), `SqlResolver` (batched/grouped loaders), `SqlConnection` (Acquirer abstraction), `SqlStream` (streaming results).
- Transactions: `SqlClient.withTransaction` runs an effect inside a transaction; the internal `TransactionConnection` tag carries a `depth` counter, i.e. nested `withTransaction` calls become savepoints rather than real nested transactions (verified in `SqlClient.ts` source, v3 branch).
- Pool config is part of the client layer, not user code: `PgClientConfig` accepts `url` (Redacted), `maxConnections`, `minConnections`, `connectionTTL`, `idleTimeout`, `connectTimeout` (verified in `PgClient.ts` source).
- Pagination prior art: offset pagination makes the DB walk and discard all skipped rows ("No Offset" — Markus Winand, https://use-the-index-luke.com/no-offset); Slack moved its API to keyset/cursor pagination for exactly this reason (https://slack.engineering/evolving-api-pagination-at-slack/). Session/token tables are append-mostly with monotonic `created_at` + `id`, the ideal keyset shape.

Recommendation:
- Core repository interfaces per PRD §19 (`UserRepository`, `AccountRepository`, `SessionRepository`, `VerificationRepository`) as `Context.Service` tags with Effect-typed errors (`RepositoryError` wrapping `SqlError`, plus domain errors like `UserNotFound`).
- Pagination: **keyset everywhere** — cursor is opaque base64 of `(created_at, id)` (tiebreaker required; timestamps alone collide). `listExpired(limit)`, `listByUser(userId, cursor)` shapes. No `offset` in the public contract.
- Transactions: repositories do **not** open transactions themselves; they run against the ambient `SqlClient`/Acquirer. Services compose with `sql.withTransaction(() => ...)`; nesting is safe (savepoints). Expose `Effect tslint`-style helper `withRepoTransaction` in core so plugins can't get it wrong.
- `SqlResolver.ordered`/`grouped` for `findByIds` batching on the session-lookup path; `SqlSchema` for typed one-off queries.

**Confidence:** high

### Q73 — Schema IR: one definition driving validation Schemas and DDL

Evidence:
- PRD §20 already mandates a database-neutral IR compiled to PG/MySQL/SQLite, and PRD §6 puts `readonly schema: DatabaseSchema` and `readonly migrations: ReadonlyArray<Migration>` on the plugin contract.
- Prior art for "one definition → both runtime validation types and DDL": Drizzle's TS schema is the source for drizzle-kit DDL, and Drizzle officially documents deriving Effect Schema validators from the same tables (https://orm.drizzle.team/docs/effect-schema, verified live). `@effect/sql/Model` similarly derives query helpers from Effect `Schema.Class` fields.
- Alembic's autogenerate documentation is the cautionary tale: it cannot detect table/column **renames** (reports add/drop pairs), **cannot detect anonymously-named constraints**, and CHECK-constraint diffing is name-based-only and off by default (https://alembic.sqlalchemy.org/en/latest/autogenerate.html). Drizzle-kit handles renames/deletes by *prompting the user* (its own npm description: "covers ~95% of the common cases like deletions and renames by prompting user input").

Recommendation — proposed IR shape (all plain data, no classes, JSON-serializable so CLI + tests + snapshot files all share it):

```ts
interface SchemaIR {
  readonly version: 1                       // IR format version, for snapshot compat
  readonly tables: ReadonlyArray<TableIR>
}
interface TableIR {
  readonly name: string                     // physical, snake_case (Q76)
  readonly owner: "core" | PluginId
  readonly columns: ReadonlyArray<ColumnIR>
  readonly primaryKey: PrimaryKeyIR
  readonly indexes: ReadonlyArray<IndexIR>      // all explicitly named
  readonly foreignKeys: ReadonlyArray<ForeignKeyIR>  // all explicitly named
  readonly checks?: ReadonlyArray<CheckIR>       // named only
}
interface ColumnIR {
  readonly name: string
  readonly type: ColumnType                 // closed union, see Q77
  readonly typeArgs?: ...                   // length, precision, enum values
  readonly required: boolean                // NOT NULL
  readonly default?: SqlDefault             // literal | currentTimestamp | sql`...`
  readonly unique?: boolean
  readonly generated?: never                // v1: no generated columns
}
```

- Relationship to Effect Schema: the IR is the **source**; validation Schemas are **derived** (`Schema.Struct` per table; column types map to `Schema.String`/`Schema.Number`/`Schema.Boolean`/`Schema.DateTimeUtc`/JSON-unknown). One may hand-write an Effect Schema and *derive* a draft IR, but the canonical path is `defineTable()` helpers that build both at once — mirrors Drizzle's effect-schema integration rather than duplicating definitions.
- Snapshot files (`auth/schema.snapshot.json`) under version control are the diff basis (Drizzle-kit model: "compose a json snapshot of your schema ... compare current json snapshot to the most recent one" — https://orm.drizzle.team/docs/drizzle-kit-generate).
- Diffs against snapshots never touch a database → deterministic in CI; drift vs a live DB is an explicit opt-in command (Q75).

**Confidence:** high

### Q74 — v1 adapters: PostgreSQL, SQLite (+D1?), MySQL

Evidence (all verified):
- Effect ships first-party clients: `@effect/sql-pg`, `@effect/sql-sqlite-node` (+ `-wasm`), `@effect/sql-mysql2`, `@effect/sql-d1` (0.50.0), `@effect/sql-mssql`, `@effect/sql-clickhouse`, plus `@effect/sql-kysely`/`@effect/sql-drizzle` bridges; v4 tree adds libsql, pglite, sqlite-bun, sqlite-do (verified from npm dist-tags and the v4 `packages/sql` tree).
- RETURNING: PG native; SQLite `RETURNING` since 3.35.0 (https://www.sqlite.org/lang_altertable.html, https://www.sqlite.org/changes.html); MySQL has no `RETURNING` — `@effect/sql`'s Statement exposes `.returning` on insert/update builders, and the mysql2 client contains no returning support (verified: zero hits in `MysqlClient.ts`).
- MySQL 8.4: `ALGORITHM=INSTANT` is the default and applies to ADD/DROP COLUMN, subject to a per-table INSTANT row-version limit after which MySQL demands a rebuild (https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html).
- MySQL `DATETIME` has no time zone — the app must pin UTC ([INFERENCE from SQL standard behavior; MySQL docs recommend explicit conventions]).
- D1: FKs supported with `PRAGMA defer_foreign_keys = true` to order multi-statement work (https://developers.cloudflare.com/d1/sql-api/foreign-keys/); atomicity unit is `batch()`, not client transactions (https://developers.cloudflare.com/d1/worker-api/d1-database/).
- SQLite ALTER limitations: only rename / add column / drop column / (`ALTER COLUMN` NOT NULL since 3.53.0); everything else needs the documented table-rebuild procedure; DROP COLUMN fails if the column is PK/part of PK, has UNIQUE, is indexed, appears in a partial index WHERE, in a CHECK constraint, or in an FK (https://www.sqlite.org/lang_altertable.html).
- PG: ADD COLUMN with non-volatile default is metadata-only; ADD FOREIGN KEY takes only SHARE ROW EXCLUSIVE and supports NOT VALID → VALIDATE CONSTRAINT (non-blocking validation); `CREATE INDEX CONCURRENTLY` cannot run inside a transaction and leaves an INVALID index on failure (https://www.postgresql.org/docs/current/sql-altertable.html, /sql-createindex.html).

| Adapter | Driver | Gaps vs PG | Effort note |
|---|---|---|---|
| PostgreSQL | `@effect/sql-pg` | none material | Reference dialect; ~2–3 weeks incl. migrator + tests [estimate] |
| SQLite (node/wasm) | `@effect/sql-sqlite-node`, `-wasm` | no `CONCURRENTLY`, no partial-index drops, ALTER limits, single writer; STRICT tables (3.37+) recommended | Cheapest to test (in-memory); ~1.5–2 weeks [estimate] |
| MySQL 8.4 | `@effect/sql-mysql2` | no RETURNING (insertId + re-select), no partial indexes, DATETIME-UTC convention, no transactional DDL → failed multi-statement migration leaves partial state | ~2–3 weeks [estimate] |
| D1 (experimental) | `@effect/sql-d1` | no client transactions (batch only), `defer_foreign_keys` for ordering, no `CONCURRENTLY` | Ship as "experimental"; requires batch-mode repositories (~1 week on top of SQLite dialect) [estimate] |

Recommendation:
- v1 ships **PostgreSQL + SQLite**, MySQL **in v1.x** (it's the DDL-hard one: no transactional DDL means our migrator must checkpoint per-statement there), D1 **experimental** — it shares the SQLite dialect so the marginal cost is small and it proves the edge story.
- Migration runner must support **per-migration transaction modes** (`transactional` default / `none` for `CREATE INDEX CONCURRENTLY`, huge backfills) — this is where `@effect/sql`'s stock Migrator (everything in one `withTransaction`) is insufficient, and where Atlas/Flyway-style `--tx-mode` flags come from.
- Repository insert helpers: `returning()` on PG/SQLite; MySQL path = insert then `select` by insertId inside the same transaction.

**Confidence:** high (facts), medium (effort estimates)

### Q75 — Migration engine: generated vs authored, ledger, drift, dry-run & destructive UX

Evidence:
- PRD §21 fixes the CLI surface: `auth schema`, `auth migration generate|apply|status`, desired-schema → planner → database, "deterministic and reviewable", destructive requires explicit confirmation.
- `@effect/sql` stock Migrator (source-verified): ledger `effect_sql_migrations(migration_id PK, created_at, name)`; PG runner takes `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` then races an INSERT into the PK as the concurrency lock ("Migrations already running" on conflict); duplicate-id detection; single `withTransaction` over the whole batch; optional `dumpSchema` hook. No checksums, no status verb, no dry-run.
- Atlas (v1.3, open-core Apache-2.0 CE) demonstrates the guardrail UX: `schema apply` prints the plan and prompts by default; review policy `lint { review = ERROR|WARNING|ALWAYS }`; diff policy can skip `drop_table`/`drop_schema` unless `--var destructive=true`; **plan files** (`atlas schema plan` → reviewed plan applied later without re-lint); advisory lock with `--lock-timeout` (default 10s); lint analyzers flag destructive and data-dependent changes (https://atlasgo.io/declarative/apply, https://atlasgo.io/lint/analyzers).
- Prisma demonstrates drift detection: `prisma migrate diff` between datamodel / migration history / live database, `migrate status`, baselining an existing DB via `migrate resolve --applied`, shadow database for computing diffs (https://www.prisma.io/docs/orm/prisma-migrate).
- Drizzle-kit demonstrates review ergonomics: `generate` (snapshot diff, prompts for deletes/renames), `push` (live diff for prototyping), `check` (detects divergent/out-of-order migration branches), custom/data migrations, `pull` (introspection) (https://orm.drizzle.team/docs/kit-overview).
- Alembic's own warning: "autogenerate is not intended to be perfect. It is *always* necessary to manually review" (https://alembic.sqlalchemy.org/en/latest/autogenerate.html).
- dbmate/golang-migrate/sqitch are the minimal VCS-friendly baseline: plain up/down SQL files in git, tiny ledger table, nothing more (https://github.com/amacneil/dbmate, https://github.com/golang-migrate/migrate, https://github.com/sqitchers/sqitch). Sqitch adds a plan file + dependency ordering + revert — closest to "migrations as reviewed artifacts".

Recommendation — `@effect-auth/migration` engine:
1. **Generation is snapshot-diff, DB-optional** (Drizzle model): `auth migration generate` diffs `schema.snapshot.json` (previous) against the compiled IR of `Auth.make({plugins})` (desired) and writes `NNNN_<name>/{migration.sql, snapshot.json, plan.json}`. Rename/destructive candidates become **prompts or explicit annotations** (`auth migration generate --rename users.user_name account.name`) — never silent add/drop pairs.
2. **Plugin-authored migrations are first-class**: a plugin may ship `migrations: [{id, name, sql | Effect<SqlClient>}]` (data backfills, index builds outside transactions) which the aggregator interleaves by plugin topo order at each step; generated + authored steps merge into one deterministic ordered file list.
3. **Ledger**: `auth_migrations(id PK, name, checksum, plugin, applied_at, duration_ms, success)`. Concurrency: PG = ledger `LOCK TABLE ... ACCESS EXCLUSIVE` + insert-race (proven pattern from `@effect/sql`); MySQL = `GET_LOCK()`; SQLite = `BEGIN IMMEDIATE`. Checksum verify on apply → tamper = hard error (Flyway `validate` semantics).
4. **Status**: `auth migration status` = files vs ledger (pending/applied/missing/foreign); `auth migration status --drift` additionally introspects the live DB (`information_schema` / `PRAGMA table_info`) and diffs against IR with non-zero exit on drift (Prisma `migrate diff --exit-code` semantics) — the CI guard against hand-edited schemas.
5. **Dry-run is the default**: `apply` prints statements + waits for confirmation in TTY, requires `--yes` in CI; **destructive classification** (DROP TABLE/SCHEMA/COLUMN, type narrowing, ADD UNIQUE/PK, ADD NOT NULL without default, ADD FK without NOT VALID-first) requires `--allow-destructive "<reason>"`; the reason is recorded in the ledger row. Atlas's `lint { destructive { error } }` + review-policy model is the template; plan files (`--plan`/`--edit`) offered for teams that want reviewed plans before apply.
6. **Escapes**: per-step `transactional: false` for `CREATE INDEX CONCURRENTLY`/large backfills; engine records partial failure state (critical for MySQL non-transactional DDL) and prints resume guidance.

**Confidence:** high

### Q76 — Naming conventions: snake_case mapping, index/FK names, enforcement

Evidence:
- Drizzle solves this with a first-class `casing` mapping option (TS camelCase → DB snake_case) documented in its schema declaration guide, and cautions that config must be set in **both** drizzle-kit and the ORM client or they diverge (https://orm.drizzle.team/docs/sql-schema-declaration; drift bug reports like drizzle-orm#4392 show what happens when the two layers disagree).
- `@effect/sql` PG client already has the same lever built in: `transformQueryNames` / `transformResultNames` on `PgClientConfig` (verified in source).
- Alembic documents "The Importance of Naming Constraints": unnamed constraints are invisible to its differ, and it cannot detect them at all (https://alembic.sqlalchemy.org/en/latest/naming.html, https://alembic.sqlalchemy.org/en/latest/autogenerate.html). Postgres will silently invent names (`users_email_key`, `users_pkey`) for unnamed constraints, and each backend invents differently [INFERENCE: de-facto defaults from PG behavior, not formally specified].
- Rails demonstrates convention-as-ecosystem: deterministic index/FK naming + `schema.rb` dump keeps diffs stable (https://guides.rubyonrails.org/active_record_migrations.html).

Recommendation:
- Logical names in TS (camelCase); **physical names generated once by the IR** into snake_case (`createdAt` → `created_at`), stored explicitly in the snapshot — the compiler emits fully-qualified DDL and never relies on DB defaults.
- Fixed name grammar, enforced at IR-build time (reject unnamed constraints): index `{table}_{cols}_idx`, unique `{table}_{cols}_uq`, FK `{table}_{cols}_{ref}_fk`, PK `{table}_pkey`, CHECK `{table}_{col}_ck`. Truncate deterministically (63-byte PG identifier limit) with hash suffix on collision [INFERENCE on exact truncation scheme].
- Reserved prefixes: `auth_` core tables; plugin side tables `{pluginId}_{table}`; conflict = compile error (aligns with PRD §"Schema conflicts" validation).
- Enforcement is mechanical: because the IR owns all physical names, a dialect can't drift (the drizzle two-config bug can't happen — one compiler, one mapping table).

**Confidence:** high

### Q77 — IR type system: JSON, timestamps, booleans, enums, defaults

Evidence:
- PG: use `timestamptz`; the Postgres wiki "Don't Do This" explicitly calls out `timestamp` (without TZ) as an anti-pattern (https://wiki.postgresql.org/wiki/Don%27t_Do_This).
- SQLite: dynamic typing means mis-typed data is silent; **STRICT tables** (3.37+) give real column-type enforcement (https://www.sqlite.org/stricttables.html). JSON1 functions ship in the core amalgamation since 3.38 (https://www.sqlite.org/json1.html). D1 inherits the SQLite semantics.
- MySQL 8.4 online-DDL table: `ALGORITHM=INSTANT` is the default for ADD/DROP COLUMN with a finite per-table row-version budget (https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html) — relevant to enum defaults and column churn.
- MySQL `DATETIME` carries no zone; TIMESTAMP is UTC-normalized but capped at 2038 [INFERENCE on 2038; zone semantics well-known].

Recommendation — closed `ColumnType` union with per-dialect rendering:

| IR type | PostgreSQL | MySQL 8.4 | SQLite (STRICT) |
|---|---|---|---|
| `string(n)` | `varchar(n)` | `varchar(n)` | `TEXT` (CHECK length optional) |
| `text` | `text` | `text` | `TEXT` |
| `boolean` | `boolean` | `tinyint(1)` | `INTEGER` (0/1, CHECK) |
| `integer` | `integer` | `int` | `INTEGER` |
| `bigint` | `bigint` | `bigint` | `INTEGER` |
| `timestamp` | `timestamptz` | `datetime(3)` (UTC convention) | `INTEGER` epoch-ms |
| `json` | `jsonb` | `json` | `TEXT` (CHECK `json_valid`) |
| `bytes` | `bytea` | `blob` | `BLOB` |
| `enum(v…)` | `varchar` + named CHECK | `varchar` + named CHECK | `TEXT` + named CHECK |
| `uuid` | `uuid` | `binary(16)` or `char(36)` | `TEXT` |

- **Enums: never native ENUM/`CREATE TYPE` in v1.** Native PG enums make add-value a special DDL op and MySQL ENUM edits rebuild the table; varchar+CHECK diffs cleanly and ports. App-level union types come from the derived Effect Schema (`Schema.Literals`), so the DB never needed the native type.
- Timestamps stored UTC always; IR maps Effect `DateTimeUtc` to `timestamp`. SQLite epoch-ms keeps STRICT typing and cheap comparisons; PG/MySQL get native types.
- Defaults: allow literal values, `currentTimestamp`, and explicit SQL fragments (recorded verbatim in the IR so diffs stay deterministic); reject volatile defaults (PG rewrites the table: verified in ALTER TABLE notes).
- Booleans/`SafeIntegers`: `@effect/sql` has a `SafeIntegers` reference switch — enable for bigint columns to get BigInt results rather than silent precision loss [verified: `SafeIntegers` exists in SqlClient source].

**Confidence:** high

### Q78 — Shared-table extension policy: plugin columns on `user` vs side tables

Evidence:
- PRD §20 explicitly shows a plugin extending `user` (`extensions: { user: { twoFactorEnabled } }`) **and** contributing its own tables (`recoveryCode`) — both paths are product-intended.
- better-auth (the direct benchmark) puts plugin fields **directly on the user table** via `additionalFields`, alongside its core four-table schema (user/session/account/verification) and per-plugin tables; it also documents field extension and secondary storage on the same database page (https://www.better-auth.com/docs/concepts/database).
- DDL cost of additive columns is now low on all three dialects: PG fast defaults (metadata-only, verified), MySQL 8.4 INSTANT add/drop (verified), SQLite single-writer ALTER is cheap for small tables. The cost is not runtime — it is **ownership and conflict**.

Recommendation:
- **Two-tier policy.** `extensions.user` is allowed only for: primitive types (`boolean`, `integer`, `string(n<=255)`, `timestamp`), nullable or defaulted, **no UNIQUE, no PK, no FK, no index ownership** (core may index if it wants). Everything row-shaped or relational → plugin side table with `user_id` FK (`{plugin}_recovery_code`).
- **Conflict resolution order** (compile-time, deterministic): (1) core-reserved column names on `user` — plugin collision = hard error; (2) two plugins claiming the same column — resolved by plugin topo order (dependency-first), but **only if** both declare the extension with identical IR (else error); (3) same-plugin duplicate = error. Rationale: silent override is how divergent snapshot diffs happen.
- **No renames/drops of shared columns by plugins** in v1; changing an extension is add-new-column → backfill (authored migration) → core drops it in a major release (expand/contract).
- Every IR column carries `owner`, so `auth schema` can print per-plugin ownership and the migrator can attribute destructive ops to the owning plugin in review output.

**Confidence:** high

### Q79 — Query performance: session-lookup hot path, token indexes, pooling

Evidence:
- The hot path is a single-row lookup by opaque token; the invariant that makes it fast is a **unique b-tree index on the stored hash** (column must therefore be fixed-length-ish and high-entropy — hash at rest; see Q45/SessionsTokens for the token format itself [cross-ref]).
- Offset pagination degrades linearly; keyset keeps O(log n) seeks (https://use-the-index-luke.com/no-offset; https://slack.engineering/evolving-api-pagination-at-slack/).
- `@effect/sql` PG layer is a `pg.Pool` wrapper with `maxConnections`/`minConnections`/`connectionTTL`/`idleTimeout` config and `applicationName` for observability (verified in `PgClientConfig`); `Effect.Pool` is available if a non-driver pool is ever needed.
- MySQL partial indexes don't exist; SQLite/PG have them — cleanup queries (`expires_at < now`) should use partial indexes where available [INFERENCE on exact query plans].

Recommendation:
- Schema-level guarantees shipped by core IR: `session.token_hash UNIQUE` (the only lookup on the secret material); `session(user_id)` for revocation cascades; `session(expires_at)` partial index `WHERE expires_at > ...` on PG/SQLite for the reaper, plain index on MySQL; same pattern for verification tokens and (later) api-key prefixes.
- Hot path reads are `SqlSchema.findOne` / prepared-tag templates with `.withoutTransform` where the compiler transform is pure overhead; batch resolution via `SqlResolver.grouped` for fan-out endpoints.
- Pooling: expose `maxConnections/minConnections/connectionTTL` as `Config`-driven options on the adapter Layer (default `maxConnections = 10`); document the pgbouncer transaction-pooling caveat (avoid session-level state; `LISTEN/NOTIFY` unavailable through transaction pooling) [INFERENCE].
- Add a `@effect-auth/test` benchmark fixture (in-memory SQLite + local PG) so plugin authors can measure before/after — PRD asks for a benchmark harness (§"Performance").

**Confidence:** high (design), medium (exact pool defaults)

### Q80 — NoSQL/edge seams: D1/Mongo/Redis later

Evidence:
- D1 works today through `@effect/sql-d1` (verified, 0.50.0) — the SQL seam already reaches Cloudflare Workers; the v4 `@effect/sql` tree adds sqlite-do (Durable Objects) and libsql, confirming Effect's own trajectory toward edge/SQLite-variant storage.
- D1's model (no client transactions; `batch()` atomic; `PRAGMA defer_foreign_keys`) shows what an edge adapter cannot promise (https://developers.cloudflare.com/d1/sql-api/foreign-keys/, https://developers.cloudflare.com/d1/worker-api/d1-database/).
- better-auth ships "secondary storage" (Redis etc.) for sessions/rate-limits as an explicit alternative to DB tables — proof that auth frameworks need a non-SQL seam for the hottest, most disposable data (https://www.better-auth.com/docs/concepts/database).
- Mongo/Redis are not relational: a repository interface typed against SQL columns will never map cleanly; the seam must be **capability-shaped**, not table-shaped [INFERENCE — design judgment].

Recommendation:
- Keep the **SQL repositories as the only core contract** for v1 (PRD G5). Everything else is additive capabilities with narrow, behavior-typed surfaces:
  - `SessionStore` (get/touch/revoke by hashed token, `Duration`-TTL semantics) — default implementation = SQL sessions; Redis/Durable-Object adapters implement this one interface.
  - `TokenStore` (purpose-scoped single-use verification tokens) — same duality.
  - `RateLimiter`/`AuditSink` (owned by their questions) follow the same pattern.
- Migrator seam: adapters declare `capabilities: { transactions: boolean; returning: boolean; concurrentDdl: boolean }` so plugins/migrator degrade or fail fast with actionable errors (D1: transactions=false → batch mode; MySQL: returning=false → insertId flow).
- Explicit non-goal now: a Mongo document adapter. The IR→DDL compiler stays SQL-only; a future Mongo adapter would implement the store capabilities, not the IR.

**Confidence:** high

### Q81 — Seeds/imports: admin bootstrap, importing from better-auth/Lucia/Auth.js

Evidence:
- The three ecosystems share a common shape, making import a column-mapping problem rather than ETL archaeology:
  - better-auth: core tables user/session/account/verification (https://www.better-auth.com/docs/concepts/database).
  - Auth.js: adapter contract models User/Account/Session/VerificationToken (https://authjs.dev/guides/creating-a-database-adapter).
  - Lucia: pivoted from library to learning resource (https://lucia-auth.com/), so its table layout (user/session + key era) is frozen — good static import target.
- Password hashes across all of them are stored as PHC-format strings (`$argon2id$...`, `$scrypt$...`, bcrypt variants) — self-describing, so import = copy the string + record the algorithm; weak/legacy params get upgraded lazily via rehash-on-login (design cross-ref Q52).
- Seeding prior art: Prisma `db seed` convention (package.json script), drizzle-seed, Rails `db/seeds.rb`, and Flyway-style "afterMigrate callbacks" — all treat seeds as **repeatable, idempotent data ops**, distinct from versioned schema migrations [INFERENCE on Flyway callbacks detail].

Recommendation:
- **Seeds ≠ migrations.** `auth seed` CLI with named, idempotent, re-runnable seed units recorded in a separate `auth_seeds(name PK, checksum, applied_at)` ledger. Shipped seeds: `admin-bootstrap` (creates the first admin from env/flags or prints a one-time claim URL — never a hardcoded password), `demo` (dev-only fixtures).
- **`auth import` with `--from better-auth|authjs|lucia --dry-run`**: column maps per source (they're small and stable), verification of password-hash algorithms against the installed hasher capability, and a report of unmapped columns (plugin-added fields land in a per-user JSON `metadata` column or are dropped with a warning).
- `password_hash` stays an **algorithm-tagged PHC string** in core so imports never require cracking; sessions/verification tokens are **not** imported (force re-login — they're short-lived by design).
- CSV/JSONL generic importer for "from anything else" cases with a declared mapping file.

**Confidence:** medium-high (source schemas stable but column-level details should be re-verified at implementation time)

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to effect-auth |
|---|---|---|---|---|
| `@effect/sql` (+ pg/sqlite/mysql2/d1/kysely) | Effect SQL toolkit: clients, typed statements, Migrator, Model, SqlResolver | MIT | Stable on v3 (0.52–0.53); 4.0-rc in flight | The substrate: SqlClient/transactions/ledger patterns; we build the planner on top |
| effect 3.22.2 / v4 beta | Runtime | MIT | v3 stable, v4 beta→rc | Peer-range decision (see Q2 owner); SQL API stable across both |
| Drizzle ORM + drizzle-kit (0.45.2 / 0.31.10; v1.0 announced) | TS schema-as-source, snapshot-diff migrations, push, pull, studio | Apache-2.0 (orm) / MIT (kit) | Very active; v1.0 shipping | Blueprint for snapshot-diff generation, `casing` option, Effect Schema integration |
| Prisma migrate (CLI 7.10.0 stable, 8.0-rc) | Declarative schema language + versioned migrations, shadow DB, drift/baseline | Apache-2.0 | Mature, large team | Blueprint for drift detection, baselining, `migrate status` UX |
| Atlas (Ariga) v1.3 | Schema-as-code, declarative diff, versioned migrations, lint, plan files, per-tenant groups | Apache-2.0 CE (open-core) | Mature (Go), commercial cloud | Closest to PRD's "desired schema → planner"; review policy + destructive lint + plan files |
| Alembic 1.20 | Python migrations w/ autogenerate from MetaData | MIT | Very mature | Documents autodiff limits (renames, unnamed constraints) — informs IR strictness |
| Kysely 0.29.5 + kysely-ctl | Typed SQL query builder + official migration CLI | MIT | Mature | Manual-migration baseline; ISO-date-prefixed migration names |
| Knex 3.3.0 | SQL builder + hand-written migrations | MIT | Mature | The "no diff, just builders" baseline |
| Rails ActiveRecord migrations | Timestamped migrations + schema.rb dump | MIT (Rails) | Reference implementation | Naming conventions + schema-dump culture |
| Flyway | Versioned SQL, `flyway_schema_history`, validate/baseline | Redgate commercial shift (Teams tier closed to new customers 2025-05) | Mature | Checksum validation + per-migration tx semantics |
| Liquibase | Changelog-based migrations, DATABASECHANGELOG | FSL from v5.0 (2025-10; was Apache-2.0) | Mature | Changelog/diff concepts; license shift is a lesson for our own licensing |
| dbmate / golang-migrate / sqitch | Minimal SQL-file migrators (ledger table, up/down) | MIT / MIT / MIT (sqitchers) | Mature | The "keep files boring and VCS-friendly" baseline; sqitch adds plan files + deps |
| `@effect/sql-d1` | Cloudflare D1 client | MIT | Present, small | Edge adapter path for v1-experimental |

## Books, papers, blogs, talks

- Markus Winand, "No Offset" (Use The Index, Luke) — https://use-the-index-luke.com/no-offset — why keyset pagination is the only defensible default for large tables; pairs with his indexing book *SQL Performance Explained*.
- Slack Engineering, "Evolving API Pagination at Slack" — https://slack.engineering/evolving-api-pagination-at-slack/ — production migration story from offset to cursor at scale.
- PostgreSQL docs: `ALTER TABLE` notes & `CREATE INDEX` — https://www.postgresql.org/docs/current/sql-altertable.html, https://www.postgresql.org/docs/current/sql-createindex.html — the canonical lock/rewrite matrix our planner encodes (fast defaults, NOT VALID two-phase, CONCURRENTLY can't be in a transaction, INVALID index on failure).
- PostgreSQL Wiki, "Don't Do This" — https://wiki.postgresql.org/wiki/Don%27t_Do_This — timestamptz, `char(n)`, and friends; a checklist our type mapping already follows.
- SQLite: `ALTER TABLE` & release notes — https://www.sqlite.org/lang_altertable.html, https://www.sqlite.org/changes.html — the full restriction list for DROP COLUMN and the 3.53.0 ALTER COLUMN addition; also STRICT tables https://www.sqlite.org/stricttables.html.
- MySQL 8.4 Reference, InnoDB Online DDL Operations — https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html — per-operation ALGORITHM/LOCK table; INSTANT default and row-version limits.
- Atlas docs: Declarative apply / lint analyzers / versioned intro — https://atlasgo.io/declarative/apply, https://atlasgo.io/lint/analyzers, https://atlasgo.io/versioned/intro — the review-policy + destructive-guardrail UX to emulate.
- Atlas blog, "Migrate Multi-Tenant Environments With Atlas" + database-per-tenant guide — https://atlasgo.io/blog/2022/10/27/multi-tenant-support, https://atlasgo.io/guides/database-per-tenant/deploying — target-group fan-out pattern if effect-auth grows tenant-keyed deployments.
- Alembic autogenerate + naming constraints — https://alembic.sqlalchemy.org/en/latest/autogenerate.html, https://alembic.sqlalchemy.org/en/latest/naming.html — the "always review, name everything" doctrine.
- Drizzle: migrations & kit docs — https://orm.drizzle.team/docs/kit-overview, https://orm.drizzle.team/docs/drizzle-kit-generate, https://orm.drizzle.team/docs/sql-schema-declaration — snapshot mechanics and the casing option.
- Prisma Migrate docs — https://www.prisma.io/docs/orm/prisma-migrate — shadow database, drift, baseline, status.
- Liquibase licensing announcement — https://www.liquibase.com/blog/liquibase-community-for-the-future-fsl — FSL shift (2025-10); relevant when we pick effect-auth's own license/CLI packaging.
- gh-ost — https://github.com/github/gh-ost — why huge-table MySQL DDL leaves the migration-tool layer entirely (triggerless online schema change); context for "not our problem in v1".

## People & projects to follow

- **Ariel Mashraki (a8m)** — co-founder of Ariga, leads Atlas; the most prolific thinker on schema-as-code, diffing, and migration linting — https://github.com/a8m, https://ariga.io/atlas.
- **Drizzle team** — Alex Blokh, Dan Kochetov, Andrey Sherman, Kyrylo Usichenko (npm maintainers on drizzle-kit) — snapshot-diff migrations and casing at scale — https://github.com/drizzle-team/drizzle-orm.
- **Johannes Schickling** — Prisma founder *and* Effect maintainer; uniquely placed at the Prisma↔Effect intersection — https://github.com/schickling.
- **Michael Arnaldi** — Effect lead; owns `@effect/sql` architecture — https://github.com/mikearnaldi.
- **Mike Bayer (zzzeek)** — SQLAlchemy/Alembic author; decades of autodiff edge cases documented in Alembic docs — https://github.com/sqlalchemy/alembic.
- **Kysely maintainers (koskimas, igalklebanov)** — kysely + kysely-ctl; excellent writing on typed SQL boundaries — https://github.com/kysely-org/kysely.
- **Tim Griesser (tgriesser)** — Knex creator; the original JS migration-file conventions — https://github.com/tgriesser.
- **David E. Wheeler** — Sqitch author; plan files, dependency-ordered migrations, revert discipline — https://github.com/sqitchers/sqitch.
- **Nathan Voxland** — Liquibase founder (license-shift saga worth following for our own governance) — https://www.liquibase.com.
- **Markus Winand** — indexing/pagination pedagogy — https://use-the-index-luke.com.

## Recommended defaults for effect-auth

1. **Build `@effect-auth/migration` on `@effect/sql`, do not wrap its stock Migrator.** Keep its good parts (dialect-aware ledger creation, lock-by-insert, duplicate-id detection) and add checksums, status, dry-run, per-step tx modes, drift, destructive guardrails.
2. **IR is data, not classes** (Q73): JSON-serializable tables/columns/indexes/FKs/checks with `owner` metadata; versioned snapshots in git; one compiler per dialect; validation Effect Schemas derived from the same IR (Drizzle↔effect-schema as precedent).
3. **Name every constraint at IR level** with a fixed grammar (`{table}_{cols}_{idx|uq|fk|ck}`); physical names stored in snapshots; reject unnamed constraints at compile time (Alembic lesson).
4. **Generation = snapshot diff** (never live DB) with prompts/flags for renames; **drift check = explicit opt-in command with non-zero exit** for CI (Prisma model).
5. **Guardrails:** dry-run default, typed destructive classification + `--allow-destructive "<reason>"` recorded in the ledger, Atlas-style plan files for teams, per-step `transactional: false` escape for `CREATE INDEX CONCURRENTLY`.
6. **v1 adapters: PostgreSQL (reference), SQLite node+wasm (test story), MySQL early-v1.x (no RETURNING, non-transactional DDL → per-statement checkpointing), D1 experimental** (`@effect/sql-d1`, batch mode). Adapters declare `capabilities {transactions, returning, concurrentDdl}`.
7. **Type map:** `timestamptz`/`datetime(3)`-UTC/epoch-ms; `jsonb`/`json`/TEXT+`json_valid`; booleans as CHECK'd ints on SQLite/MySQL; enums as varchar+named CHECK everywhere (no native ENUM in v1); STRICT tables on SQLite 3.37+.
8. **Repositories:** keyset-only pagination (`(created_at, id)` cursor), no offsets; transactions via `sql.withTransaction` (savepoint-nested); batched lookups via `SqlResolver`; unique index on `token_hash` as the enforced hot path.
9. **Extensions policy:** primitive flag columns on `user` allowed (nullable/defaulted, no unique/FK/index ownership); row-shaped plugin data in `{plugin}_*` side tables; conflicts resolved core → topo-order → error; no plugin-driven renames/drops of shared columns in v1.
10. **Seeds/imports:** separate idempotent seed ledger + `auth seed admin` (claim-URL bootstrap, never seeded passwords); `auth import --from better-auth|authjs|lucia` with PHC-hash passthrough and rehash-on-login; never import sessions/verification tokens.
11. **Effect version:** target `effect@^3.22` / `@effect/sql@^0.52` for v1.0; keep CI green against the `4.0.0-rc` line (it's already tagged) so the v4 cutover is a version-bump, not a rewrite.

## Open questions for the user

1. **Migration file format** — what lands in the user's repo?
   - (a) plain SQL files + snapshot JSON (drizzle-style, reviewable in any diff tool)
   - (b) plan.json + SQL (Atlas-style, machine-checkable plans)
   - (c) TS files exporting Effects (data migrations natural, but not diffable as SQL)
2. **How opinionated should destructive guardrails be?**
   - (a) hard-block + `--allow-destructive` flag with recorded reason (recommended)
   - (b) warn-only, team policy files decide
   - (c) core blocks, plugins may pre-approve their own destructive steps
3. **Is MySQL v1.0 or v1.x?**
   - (a) v1.0 (heavier test matrix, non-transactional DDL checkpointing from day one)
   - (b) v1.x — ship PG+SQLite first, MySQL once the migrator hardens (recommended)
   - (c) PG+SQLite only at v1, MySQL behind experimental flag
4. **Should `extensions.user` columns be allowed at all, or side-tables only?**
   - (a) follow PRD: flags allowed with strict primitive/no-index rules (recommended)
   - (b) side tables only; `user` stays core-immutable (cleaner, but diverges from PRD sketch and better-auth parity)
5. **Where do seeds live?**
   - (a) separate `auth_seeds` ledger + `auth seed` command (recommended)
   - (b) seeds as authored migrations flagged `seed: true`
   - (c) no first-party seeds; document patterns only

## Sources

- Effect SQL: https://www.npmjs.com/package/@effect/sql · https://github.com/Effect-TS/effect/tree/v3/packages/sql (Migrator.ts, SqlClient.ts, Statement.ts, Migrator/FileSystem.ts) · https://github.com/Effect-TS/effect/tree/v3/packages/sql-pg/src/PgClient.ts · https://effect.website/blog/releases/effect/40-beta · https://registry.npmjs.org/@effect/sql · https://registry.npmjs.org/@effect/sql-d1
- Drizzle: https://orm.drizzle.team/docs/kit-overview · https://orm.drizzle.team/docs/drizzle-kit-generate · https://orm.drizzle.team/docs/sql-schema-declaration · https://orm.drizzle.team/docs/effect-schema · https://orm.drizzle.team/docs/v0-v1-changes · https://registry.npmjs.org/drizzle-orm · https://registry.npmjs.org/drizzle-kit
- Prisma: https://www.prisma.io/docs/orm/prisma-migrate · https://registry.npmjs.org/prisma
- Atlas: https://atlasgo.io/ · https://atlasgo.io/declarative/apply · https://atlasgo.io/lint/analyzers · https://atlasgo.io/versioned/intro · https://atlasgo.io/guides/database-per-tenant/deploying · https://atlasgo.io/blog/2022/10/27/multi-tenant-support · https://atlasgo.io/community-edition · https://github.com/ariga/atlas/releases · https://pkg.go.dev/ariga.io/atlas
- Alembic: https://alembic.sqlalchemy.org/en/latest/autogenerate.html · https://alembic.sqlalchemy.org/en/latest/naming.html
- PostgreSQL: https://www.postgresql.org/docs/current/sql-altertable.html · https://www.postgresql.org/docs/current/sql-createindex.html · https://wiki.postgresql.org/wiki/Don%27t_Do_This
- SQLite: https://www.sqlite.org/lang_altertable.html · https://www.sqlite.org/changes.html · https://www.sqlite.org/stricttables.html · https://www.sqlite.org/json1.html
- MySQL: https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html · https://github.com/github/gh-ost
- Cloudflare D1: https://developers.cloudflare.com/d1/sql-api/foreign-keys/ · https://developers.cloudflare.com/d1/sql-api/sql-statements/ · https://developers.cloudflare.com/d1/worker-api/d1-database/
- Pagination: https://use-the-index-luke.com/no-offset · https://slack.engineering/evolving-api-pagination-at-slack/
- Auth ecosystem schemas: https://www.better-auth.com/docs/concepts/database · https://authjs.dev/guides/creating-a-database-adapter · https://lucia-auth.com/
- Minimal migrators: https://github.com/amacneil/dbmate · https://github.com/golang-migrate/migrate · https://github.com/sqitchers/sqitch · https://kysely.dev/docs/migrations · https://github.com/kysely-org/kysely-ctl
- Commercial tools & licensing: https://guides.rubyonrails.org/active_record_migrations.html · https://www.liquibase.com/blog/liquibase-community-for-the-future-fsl · https://www.bytebase.com/blog/flyway-vs-liquibase/ · https://documentation.red-gate.com/fd/transition-license-information-233439261.html
