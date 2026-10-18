# Plan 22: Each plugin table's DDL lives with its records module, written once for both dialects

| Property | Value |
|---|---|
| Strength | Worth exploring (batch index). This plan finds it a solid locality and leverage win with three small live defects attached: 47 plugin index migrations break the SSMS-006 `IF NOT EXISTS` rule the SQL README says "new ones must follow", a Postgres `INTEGER` column truncates the WebAuthn signature counter's range, and no check ties a plugin's tenancy declarations to the schema its migrations build |
| Dependency category | in-process (a pure DDL-rendering helper over the ambient `SqlClient`; no new port, no adapter) |
| Wave / order | After plan 05 (done: `TenantScoped`, `AuthPlugin.Table.*`, `StoreFailure`) and plan 08 (done: `records` bundles, `runPluginContractTests` schema check). **Before plan 24**, which edits the same records modules. Independent of plans 11–21 and 23; coordinate `packages/sql/src/index.ts` and `packages/sql/README.md` with plan 16 |
| Fixes live bugs | (1) Every one of the 47 plugin indexes is created without `IF NOT EXISTS`, so the documented online-index procedure (`packages/sql/README.md:121-125`) fails with "relation already exists" on a plugin table. (2) `passkey_credential.counter` is `INTEGER` (int4) on Postgres while a WebAuthn signature counter is a uint32: a counter ≥ 2^31 makes every later sign-in with that credential a 503 on Postgres only. (3) A plugin's `tables` tenancy declarations (plan 05) are never checked against the columns its migrations create. |
| Execution tickets | `.scratch/table-ddl-locality/issues/NN-*.md`, one per phase in §4 (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check them before editing: plans 11–21 land in the same wave and move code in `Passkey.ts`, `Admin.ts` and the organization package.

---

## 1. Summary, goals, non-goals

### Summary

ADR-EA-004 states its own goal in its first sentence: the persistence stratum "must support multiple SQL dialects (PostgreSQL, SQLite, MySQL are the named v1 targets per `research/10-schema-migrations.md` Q74) **without plugin authors hand-writing dialect-specific DDL**" (`spec/decisions/004-database-neutral-models.md:20`). Its Positive consequence repeats it: "Persistence code is dialect-neutral by construction (`Model.Class` + `SqlClient`, **not hand-written per-dialect DDL**)" (`:32`).

The tree contradicts both sentences. The 13 plugin migration lists (12 packages plus the template) hold **65 migrations**. **49** of them wrap a `sql.onDialectOrElse({ pg, sqlite, orElse })` around two hand-written copies of the same statement (§2.1):

- **11** copies are byte-identical (for example `Admin.ts:628-631`, an index statement written twice).
- **35** differ only in a column type token: `TIMESTAMPTZ`/`TEXT` 62 times, `BOOLEAN`/`INTEGER` 4, `DEFAULT FALSE`/`DEFAULT 0` 2, `SERIAL PRIMARY KEY`/`INTEGER PRIMARY KEY AUTOINCREMENT` 1.
- **3** genuinely differ. Two are the admin immutability triggers. The third is the roles `DEFAULT now()` versus `strftime(...)`, which a type token also absorbs.

The other half of the problem is **locality**. A plugin table's DDL lives in the plugin's class file. Its row codec and queries live in the records module beside it. `admin_impersonation`'s DDL and frozen-column trigger lists are `Admin.ts:591-825`. Its codec, queries and memory adapter are `ImpersonationRecords.ts`. Adding `tenantId` meant one new migration that **re-states the whole frozen-column list twice, once per dialect** (`Admin.ts:776-825`), in a different file from the row schema that defines which columns exist (`ImpersonationRecords.ts:488-503`). Passkey (`Passkey.ts:827-958` against three records modules), api-key, device-authorization, jwt, webhooks, SAML, SCIM and roles have the same split. Organization moved its list into a separate `OrganizationMigrations.ts` (`:43-489`) that serves eight records modules. Only `two-factor/src/TwoFactorStore.ts:607-680` and `qadi/src/UserClaims.ts:190-212` keep their migrations next to their records, and those are the precedent this plan generalises.

This plan deepens the migration surface with two small modules:

- **`SqlDdl`** in `@awthaq/sql`. A dialect-resolved set of DDL **fragments** (`timestamp`, `boolean`, `false`/`true`, `int64`, `autoIncrementKey`, `nowTimestamp`) that interpolate into one `sql\`…\`` statement. An `index` statement builder renders `CREATE [UNIQUE] INDEX IF NOT EXISTS` by construction, which makes SSMS-006 impossible to forget. An `only` combinator covers a statement that exists on one dialect.
- **`Migrations.group` and `Migrations.ledger`** in `@awthaq/core`. A records module declares its own migrations as a group keyed by ledger name. The plugin's `migrations` becomes an explicit ledger over its modules' groups, in the historical order, and the compiler checks that the ledger names every migration exactly once.

Each table's DDL then moves into the records module that owns its codec and queries. Migration **names and order are unchanged**, so already-migrated databases neither re-run nor drift (§2.3). A schema lock (Phase 0) proves the refactor creates the same schema on a fresh database.

### Goals

1. **Locality.** For every plugin table, the `CREATE TABLE`, its later `ALTER`s, its indexes and its triggers are in the same file as its row codec, its queries and its memory adapter. No plugin class file contains DDL.
2. **One statement, both dialects.** Every migration statement that differs only by type token is written once with `SqlDdl` fragments. After the plan `grep -c onDialectOrElse` over plugin migration code is **2** (the admin trigger bodies), down from 49.
3. **Unchanged identity.** Every plugin's migration names and order are byte-identical before and after. `awthaq migration status` on a database migrated at `fc990c88` reports no drift. A fresh database gets the same schema (schema lock).
4. **The SSMS-006 convention holds by construction** for plugin indexes (`SqlDdl.index` is the only index builder plugins use). The 47 existing index migrations render `IF NOT EXISTS`.
5. **Admin's frozen columns are derived, not restated.** The trigger column lists come from one array that the compiler checks against the row schema's fields, so adding a column to `admin_impersonation` without freezing it (or explicitly marking it closable) does not compile.
6. **The schema is checked.** `runPluginContractTests` asserts that every declared table and every tenancy column (`partitioned` / `keyed` / `derived` `via`) exists after the plugin's migrations. Under `pnpm test:pg` it also asserts that Postgres and SQLite build the same **logical** schema (columns, nullability, keys, indexes).
7. **The template and `docs/plugin-authoring.md` teach the new shape**, so a third-party author never writes a twin.
8. The passkey counter accepts the full WebAuthn uint32 range on Postgres.

### Non-goals

- **A table-definition DSL** (one declaration that generates `CREATE TABLE`, the row schema and future `ALTER`s). §3.6 weighs it against the counts and rejects it. It is the IR ADR-EA-004 relocated to a future CLI diff planner (BEH-EA-039), and 23 of the 65 migrations are `ALTER`s, backfills, data repairs or cross-table claims that a table DSL cannot express.
- **Core's migrations** (`packages/sql/src/CoreMigrations.ts`, 29 migrations, 29 `onDialectOrElse` blocks). Core quotes camelCase on Postgres and leaves it bare on SQLite (`:96-124`), so 21 of its twins are "structural" only by quoting. Adopting `SqlDdl` there is possible and cheap after this plan, but `packages/sql` is plan 16's territory in this wave (Q1).
- **Changing what any shipped migration does.** No column, type, constraint or index changes. The single schema change is a **new**, appended passkey migration (Phase 4). The `IF NOT EXISTS` retrofit changes no schema: it only changes what an already-existing index does to the statement.
- MySQL. ADR-EA-004 names it, and nothing in the tree targets it. `SqlDdl.make` dies with `UnsupportedDialect` on any other dialect, exactly as every `orElse` does today.
- Moving the plugin's `tables` tenancy declarations into the records modules. They are read statically by `Auth.make` from the plugin class (plan 05, BEH-EA-328) and stay there. This plan only checks them against the schema.

---

## 2. Verified current state

### 2.1 Every plugin migration list

Measured with a TypeScript-AST script over each file (scratchpad `ddl-inventory.cjs`). It finds every `onDialectOrElse` call, extracts the `pg` and `sqlite` branch bodies, and classifies them:

- **identical**: whitespace-normalised equal.
- **type-only**: equal after mapping `TIMESTAMPTZ→TEXT`, `BOOLEAN→INTEGER`, `BIGINT→INTEGER`, `DEFAULT FALSE→0`, `SERIAL PRIMARY KEY→INTEGER PRIMARY KEY AUTOINCREMENT`.
- **structural**: any other difference.

| Package | Migration list (file:lines) | Migrations | `onDialect` blocks | identical | type-only | structural | Distinct index statements | Owning records modules (codec + queries today) |
|---|---|---|---|---|---|---|---|---|
| admin | `admin/src/Admin.ts:591-766` + `:776-825` (`adminMigrations`, `addTenantIdMigration`); used `:836` | 7 | 7 | 2 (`:627`, `:655`) | 3 (`:596`, `:643`, `:671`) | 2 (triggers `:704`, `:782`) | 3 | `ImpersonationRecords.ts` (both tables) |
| api-key | `api-key/src/ApiKey.ts:313-386`; used `:767` | 2 | 2 | 0 | 2 (`:318`, `:356`) | 0 | 2 | `ApiKeyRecords.ts` (`apikey_key`), `ApiKeyClientRecords.ts` (`apikey_client`) |
| device-authorization | `device-authorization/src/DeviceAuthorization.ts:182-252`; used `:733` | 2 | 2 | 0 | 2 (`:187`, `:231`) | 0 | 4 | `DeviceGrantRecords.ts`, `DeviceClientRecords.ts` |
| jwt | `jwt/src/Jwt.ts:476-555`; used `:581` | 4 | 2 | 0 | 2 (`:481`, `:510`) | 0 | 2 (one partial, one expression + partial unique) | `SigningKeyRecords.ts` (migrations 1, 3, 4), `RevocationStore.ts` (2) |
| organization | `organization/src/OrganizationMigrations.ts:43-489`; used `Organization.ts:106` | 21 | 13 | 4 | 9 | 0 | 18 | 8 modules: see §2.2 |
| passkey | `passkey/src/Passkey.ts:827-958`; used `:1032` | 7 | 7 | 3 | 4 | 0 | 2 | `PasskeyCredentials.ts` (1, 2, 5, 6), `ChallengeStore.ts` (3, 4), `PasskeyUserHandles.ts` (7) |
| qadi | `qadi/src/UserClaims.ts:190-212` (already colocated); used `:286` | 1 | 1 | 0 | 1 | 0 | 0 | `UserClaims.ts` |
| roles | `roles/src/Roles.ts:195-230`; used `:324` | 2 | 2 | 1 (`:223`) | 0 | 1 (`DEFAULT now()` vs `strftime`, `:200`) | 1 | `RoleAssignments.ts` |
| saml | `saml/src/Saml.ts:177-348`; used `:818` | 7 | 5 | 0 | 5 | 0 | 5 | `SamlRecords.ts` (4 tables; migration 7 backfills organization's claim tables) |
| scim | `scim/src/Scim.ts:366-439`; used `:505` | 3 | 2 | 0 | 2 | 0 | 4 | `ScimRecords.ts` |
| two-factor | `two-factor/src/TwoFactorStore.ts:616-680` (already colocated); used `TwoFactor.ts:58`, `:477` | 3 | 3 | 1 (`:671`) | 2 | 0 | 1 | `TwoFactorStore.ts` |
| webhooks | `webhooks/src/Webhooks.ts:195-303`; used `:405` | 4 | 2 | 0 | 2 | 0 | 4 | `WebhookRecords.ts` |
| **packages total** | 1,509 lines of migration source | **63** | **48** | **11** | **34** | **3** | **46** | 24 records modules |
| template | `examples/plugin-template/src/Template.ts:210-243` (colocated, one file); used `:326` | 2 | 1 | 0 | 1 | 0 | 1 | `NoteRecords` in the same file |
| **all** | 1,543 lines | **65** | **49** | **11** | **35** | **3** | **47** | |

The candidate description said "~47 twin branches across ~11 plugins". The measured figure is **49 blocks across 12 packages plus the template**. qadi and roles were missed, and qadi is already colocated.

Type tokens across all plugin migration code (`grep -oE` over the 13 files): `TIMESTAMPTZ` 62, `BOOLEAN` 4, `DEFAULT FALSE` 2, `SERIAL` 1, `INTEGER PRIMARY KEY AUTOINCREMENT` 1, `BIGINT` 0. No `JSONB`: opaque JSON is `TEXT` on both dialects (ADR-EA-004 rev 1.1, PPS-009).

The tree already writes 16 migrations dialect-neutrally, with no branch (for example `Admin.ts:780-781`, `Saml.ts:224-234`, all of `OrganizationMigrations.ts:309-386`). Two migrations even mix the styles: `Saml.ts:208` puts its index outside the branch, while `Admin.ts:628-631` wraps an identical index in one. The convention is unstated, and authors copy whichever neighbour they read.

### 2.2 Organization: one list, eight owners, interleaved order

`OrganizationMigrations.ts` migrations by owning records module (positions are ledger ids within the plugin):

| # | Name | Tables touched | Owner |
|---|---|---|---|
| 1 | `create_organization_org` | org | `OrganizationRecords` |
| 2, 3 | `create_organization_membership`, `_indexes` | membership | `MembershipRecords` |
| 4, 5 | `create_organization_invitation`, `_indexes` | invitation | `InvitationRecords` |
| 6, 7 | `create_organization_team`, `_organization_id_index` | team | `TeamRecords` |
| 8, 9 | `create_organization_team_membership`, `_team_id_index` | team_membership | `TeamRecords` |
| 10 | `create_organization_role` | role | `OrgRoleRecords` |
| 11 | `create_organization_active_context` | active_context | `ActiveContextRecords` |
| 12 | `organization_membership_unique_user_org` | membership (dedupe + unique index) | `MembershipRecords` |
| 13 | `organization_active_context_user_id` | active_context | `ActiveContextRecords` |
| 14 | `organization_invitation_token_hash` | invitation | `InvitationRecords` |
| 15 | `organization_team_membership_unique_team_user` | team_membership, team (`memberCount` repair) | `TeamRecords` |
| 16 | `organization_team_membership_role` | team_membership | `TeamRecords` |
| 17 | `organization_team_hierarchy` | team, team_closure (create + backfill) | `TeamRecords` |
| 18 | `organization_org_home_region` | org | `OrganizationRecords` |
| 19 | `organization_oauth_connection` | oauth_connection, oauth_connection_domain | `ConnectionRecords` |
| 20 | `organization_org_suspended_at` | org | `OrganizationRecords` |
| 21 | `create_organization_domain_claim` | domain_owner, domain_claim (create + backfill) | `DomainClaims` |

Every migration has exactly one owner. That includes the two that touch two tables, because both tables in each pair belong to one module. The order interleaves owners, though (1, 2, 4, 6, 10, 11, then back to 2's module at 12). So a plugin ledger **cannot** be "concatenate each module's list". It must name the historical order. jwt (signing key 1, revocation 2, signing key 3–4) and passkey (credential 1–2, challenge 3–4, credential 5–6, handle 7) interleave the same way.

SAML's migration 7 (`claim_saml_connection_domains`, `Saml.ts:322-347`) reads `saml_connection_domain` and writes organization's `organization_domain_claim`/`_owner`. It is a SAML-owned data migration (SAML declares `readsTables` on them). Its owner is `SamlRecords`, which owns `saml_connection_domain`.

### 2.3 Migration identity: what must not change

- `Migrations.run` (`core/src/Migrations.ts:68-81`) gives each migration the numeric id `index + 1` of `auth.migrations`. Effect's `Migrator` (`effect@4.0.0-rc.116` `unstable/sql/Migrator.ts:229-260`) records `(id, name)` and **skips every id at or below the newest recorded one**. It never compares names or bodies.
- `Auth.make`'s `renumberMigrations` (`core/src/Auth.ts:774-793`) re-keys names `NNNN_<plugin>_<name>` in dependency order. User-field migrations go after every plugin's own migrations.
- `awthaq migration status/apply` (`cli/src/Migration.ts:64-83`) **does** compare names. An applied row whose `id:name` the linker no longer produces is reported as `unknown`, which is drift, and `apply` refuses (BEH-EA-204, ECS-009).

So the invariants are:

1. Per plugin, the **sequence of names** must be identical.
2. No migration may be split, merged, removed or reordered.
3. A migration's **body may change** only if it builds the same schema on a fresh database. A body never re-runs on a database that has applied it.

Point 3 is what the schema lock (§3.5) proves. `docs/plugin-authoring.md:121` ("Never edit a migration that has shipped") and `TwoFactorStore.ts:610` ("never reorder or edit a shipped entry") are rewritten to the precise rule: never change what a shipped migration builds. A behaviour-preserving source refactor is allowed when the schema lock does not move.

`Auth.make` does **not** refuse two migrations with the same name inside one plugin today (no check in `Auth.ts`, `AuthPlugin.ts` or `TestAuth.ts`). Two entries sharing a name would have distinct ids, but `awthaq migration status`'s `unknown` set keys on `id:name`, and a later reorder could make a duplicate name collide silently. `Migrations.ledger` makes duplicates a compile error, and `Auth.make` refuses them at runtime (Phase 1).

### 2.4 Live defects

**D1: plugin indexes violate SSMS-006.** `packages/sql/README.md:121`: "The migrator cannot run `CREATE INDEX CONCURRENTLY` … **every index migration is `CREATE [UNIQUE] INDEX IF NOT EXISTS <name>`**, and new ones must follow it". Step 2 (`:124`): "Deploy. The migration is recorded and its `IF NOT EXISTS` statement is a no-op". Core enforces this with a source scan (`sql/test/CoreMigrations.test.ts:110-127`). Across the 13 plugin files there are 47 distinct index names and **0** `IF NOT EXISTS`. Examples: `Admin.ts:629`, `OrganizationMigrations.ts:310` (the unique index created on live data after a dedupe), and `Webhooks.ts`'s delivery indexes.

Repro (Postgres, operator following the README on a populated `webhooks_delivery`):

```sql
CREATE INDEX CONCURRENTLY webhooks_delivery_due ON webhooks_delivery (...);  -- out of band, as documented
-- deploy: Migrations.run(auth.migrations)
-- => ERROR: relation "webhooks_delivery_due" already exists; the whole plugin batch rolls back
```

Severity: operational. No first-party deployment exists yet, but the README promises the procedure for every index.

**D2: the passkey counter is int4 on Postgres.** `Passkey.ts:839` declares `counter INTEGER NOT NULL` on both branches. On Postgres `INTEGER` is int4 (maximum 2,147,483,647). A WebAuthn signature counter is an unsigned 32-bit integer (WebAuthn L2 §6.1, `signCount`). The memory adapter stores any `number` (`PasskeyCredentials.ts:185`), SQLite stores 64-bit, and Postgres raises `integer out of range`. `StoreFailure.orStoreUnavailable` maps that to `StoreUnavailable` (`sql/src/StoreFailure.ts:68-73`). Reachable through registration (`Passkey.ts:1330`) and every authentication or reauthentication (`:1546`, `:1745`, `verified.newCounter`).

Repro (pg only):

```ts
yield* credentials.recordUsage(id, 2 ** 31, true, now)   // memory, SQLite: ok; Postgres: StoreUnavailable("PasskeyCredentials.name")
```

That operation label is wrong too (plan 24 §2 owns the label). It is latent because most authenticators start at 0, but the input is spec-legal and attacker-irrelevant: an authenticator with a large counter simply cannot be used on a Postgres deployment.

Fixing it needs a codec as well as DDL. `@effect/sql-pg` rc.116 decodes and encodes OID 20 (int8) as a JS `bigint` only: `PgTypes.ts:1246-1259`, where `int8Value` requires a `bigint` and the decoder returns `getBigInt64`. So the row schema needs an `int64` wire codec (`bigint` ↔ `number`) on Postgres and `Number` on SQLite, beside `Models.dialectFields`' existing `dateTime`/`boolean` (`sql/src/Models.ts:171-184`).

**D3: tenancy declarations are unchecked against the schema.** `Auth.make` validates that `AuthPlugin.Table.partitioned(column)`, `keyed(column)` and `derived(parent, via)` name plain identifiers and that a derived parent resolves (plan 05 Phase 3 decisions). Nothing checks that the column exists in the migrated schema, and `TenantScope.enableRls` would create a policy over a missing column (`TenantScope.ts`, policy SQL assembled from the declaration). Today every declaration happens to match. The check costs one introspection per contract-test run.

### 2.5 Stale text this plan corrects (no behaviour)

- "Columns left unquoted under `pg`": `Admin.ts:585-589`, `Roles.ts:191-194`, `Passkey.ts:815-820`, `Jwt.ts:470-474` and `OrganizationMigrations.ts:21-26` all say this. Every one of those DDL statements quotes its camelCase columns (`"adminUserId"`, `"userId"`, `"createdAt"`), and `docs/plugin-authoring.md:123` says "All shipped plugins quote their camelCase columns".
- `Admin.ts:699-700`: "The Postgres branch is exercised by no test in this repo (SQLite only)". `ImpersonationRecords.test.ts` is in `scripts/test-pg.sh`, and its header says it runs on Postgres.
- Core's ledger size is stated four ways: "ids 1-17" (`core/src/Migrations.ts:27`, BEH-EA-038 in `spec/behaviors/05-persistence-stratum.md:132`), "1-20" (`cli/src/Migration.ts:5`), "1-25" (`sql/README.md:117`, `CoreMigrations.ts:20`). There are 29 (`CoreMigrations.ts:640`). The rule ("two ledgers") is what matters, so the numbers are replaced with "core's own ids".
- `core/src/Migrations.ts:43-67` says `run` "still has no PRODUCTION call site". The CLI's `apply` calls it (`cli/src/Migration.ts:241`).

### 2.6 Existing tests this plan builds on

- `runPluginContractTests` "migrations apply identically on two fresh databases" (`test/src/TestAuth.ts:1096-1128`). It applies core and then the composition to SQLite `:memory:` twice, reads `sqlite_master` (`:821-843`), and compares the text. It also refuses re-application (`reapplied !== 0`) and ownership violations (`:845-...`, PV-252/INV-EA-016).
- Each records suite migrates with `Migrations.run(Plugin.migrations)` over `TestSql.layer(suite)` (for example `organization/test/MembershipRecords.test.ts:21-33`). All 45 suites in `scripts/test-pg.sh:19-64` run on Postgres in CI (`.github/workflows/check.yml:31-50`).
- `sql/test/CoreMigrations.test.ts:110-127` is the core SSMS-006 source scan.

---

## 3. Target design

### 3.1 `@awthaq/sql`: `SqlDdl.ts` (new)

The module's interface is a handful of fragments and two statement builders. The implementation hides which dialect is running, the type spellings, `IF NOT EXISTS`, identifier quoting and the `UnsupportedDialect` death.

```ts
// packages/sql/src/SqlDdl.ts
import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as Statement from "effect/unstable/sql/Statement";
import type * as Models from "./Models.ts";

/**
 * ADR-EA-004 (revision 1.3): the type tokens that differ between the supported dialects, as
 * fragments that interpolate into one statement. Everything else (TEXT, INTEGER, NOT NULL,
 * PRIMARY KEY, UNIQUE, DEFAULT '<text>') is spelled the same on both and is written inline.
 */
export interface Types {
  readonly dialect: Models.Dialect;
  /** `TIMESTAMPTZ` | `TEXT`. Pair with `Models.dialectFields(...).dateTime`. */
  readonly timestamp: Statement.Fragment;
  /** `BOOLEAN` | `INTEGER`. Pair with `.boolean`. */
  readonly boolean: Statement.Fragment;
  /** `FALSE` | `0` and `TRUE` | `1`, for a boolean column's `DEFAULT`. */
  readonly false: Statement.Fragment;
  readonly true: Statement.Fragment;
  /** `BIGINT` | `INTEGER`. Pair with `.int64` (pg decodes int8 as `bigint`). */
  readonly int64: Statement.Fragment;
  /** `SERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT`. */
  readonly autoIncrementKey: Statement.Fragment;
  /** `now()` | `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, the ISO text `Models` decodes on SQLite. */
  readonly nowTimestamp: Statement.Fragment;
}

export interface IndexOptions {
  readonly unique?: boolean | undefined;
  /** A partial index's predicate (`jwt_signing_key_active_idx`). */
  readonly where?: Statement.Fragment | undefined;
}

export interface Ddl extends Types {
  readonly sql: SqlClient.SqlClient;
  /**
   * SSMS-006: always `CREATE [UNIQUE] INDEX IF NOT EXISTS`, so an operator may build it
   * `CONCURRENTLY` out of band first. A string column is quoted as an identifier; a fragment
   * (an expression such as `("rotatedAt" IS NULL)`) is inlined.
   */
  readonly index: (
    name: string,
    table: string,
    columns: ReadonlyArray<string | Statement.Fragment>,
    options?: IndexOptions,
  ) => Effect.Effect<void, SqlError>;
  /** A statement that exists on some dialects only; a dialect without a branch does nothing. */
  readonly only: <E>(branches: {
    readonly pg?: () => Effect.Effect<unknown, E>;
    readonly sqlite?: () => Effect.Effect<unknown, E>;
  }) => Effect.Effect<void, E>;
}

const pg = (sql: SqlClient.SqlClient) => ({
  dialect: "pg" as const,
  timestamp: sql.literal("TIMESTAMPTZ"),
  boolean: sql.literal("BOOLEAN"),
  false: sql.literal("FALSE"),
  true: sql.literal("TRUE"),
  int64: sql.literal("BIGINT"),
  autoIncrementKey: sql.literal("SERIAL PRIMARY KEY"),
  nowTimestamp: sql.literal("now()"),
}) satisfies Types;

const sqlite = (sql: SqlClient.SqlClient) => ({
  dialect: "sqlite" as const,
  timestamp: sql.literal("TEXT"),
  boolean: sql.literal("INTEGER"),
  false: sql.literal("0"),
  true: sql.literal("1"),
  int64: sql.literal("INTEGER"),
  autoIncrementKey: sql.literal("INTEGER PRIMARY KEY AUTOINCREMENT"),
  nowTimestamp: sql.literal("(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"),
}) satisfies Types;

/** Resolves the ambient client's dialect once. Any other dialect dies (`UnsupportedDialect`). */
export const make = (sql: SqlClient.SqlClient) =>
  sql
    .onDialectOrElse({
      pg: () => Effect.succeed(pg(sql)),
      sqlite: () => Effect.succeed(sqlite(sql)),
      orElse: () => Defects.unsupportedDialect("migrations"),
    })
    .pipe(
      Effect.map((types) => ({
        ...types,
        sql,
        index: (name, table, columns, options) =>
          sql`CREATE ${options?.unique === true ? sql.literal("UNIQUE ") : sql.literal("")}INDEX IF NOT EXISTS ${sql(name)} ON ${sql(table)} (${sql.csv(
            columns.map((column) => (typeof column === "string" ? sql(column) : column)),
          )})${options?.where === undefined ? sql.literal("") : sql` WHERE ${options.where}`}`.pipe(Effect.asVoid),
        only: (branches) => {
          const branch = types.dialect === "pg" ? branches.pg : branches.sqlite;
          return branch === undefined ? Effect.void : Effect.asVoid(branch());
        },
      }) satisfies Ddl),
    );
```

Notes for the executor:

- `as const` on the `dialect` literal is the allowed form (`.oxlintrc.json` override). `satisfies` gives contextual types to the inline arrows. There is no `as`.
- **`sql.csv` and identifiers.** `Statement.ts:507-510` in rc.116 has a `csv(values)` overload. `sql(identifier)` quotes with the dialect's escape, so `"sessionId"` is the same on both. An index over a bare `id` is rendered as `"id"`, which is the same column (`CREATE INDEX … ("startedAt", "id")` and `("startedAt", id)` build identical indexes). The schema lock compares structure (§3.5), not `sqlite_master.sql` text, which is why this is safe.
- If `sql.csv` does not accept an `Identifier` segment in rc.116, use `sql.join(", ", false)` over the fragments (`Statement.ts:512-516`). Check it in Phase 1's unit test, which asserts the compiled SQL with `statement.compile()` for both dialects.
- **The `Models.Dialect` type and `resolveDialect` stay where they are** (`Models.ts:45`, `:190`). `SqlDdl` imports the type only.
- **`int64` wire codec (D2):** add `int64` to `Models.dialectFields` (`Models.ts:171-182`). On pg it is a `Schema` transform `bigint ↔ number` (`Schema.BigInt` decoded to a finite safe integer, encode `BigInt(n)`), and on SQLite it is `Schema.Number`. Name it after the wire, not the column, as the module already does.

### 3.2 `@awthaq/core`: `Migrations.group` and `Migrations.ledger`

```ts
// packages/core/src/Migrations.ts (additions; `Migration`, `Migrations`, `run`, `pluginMigrationsTable` unchanged)
import { SqlDdl } from "@awthaq/sql";

/** A migration body over the resolved dialect helper; its own `SqlClient` is `ddl.sql`. */
export type Up<E> = (ddl: SqlDdl.Ddl) => Effect.Effect<unknown, E>;

const migrationOf = <E>(name: string, up: Up<E>) => ({
  name,
  up: Effect.gen(function* () {
    const ddl = yield* SqlDdl.make(yield* SqlClient.SqlClient);
    yield* up(ddl);
  }),
}) satisfies Migration;

```

`group` keys a records module's own migrations by their ledger name. The key *is* the name, so there is no second spelling to drift. `Object.fromEntries` would lose the key type, and an assertion is not allowed, so `group` builds the record through a guard:

```ts
/**
 * BEH-EA-037 (plan 22): a records module's own migrations, keyed by their ledger name. Declare a
 * group next to the codec and queries of the tables it builds.
 */
export const group = <const B extends Readonly<Record<string, Up<unknown>>>>(bodies: B) => {
  const out: { -readonly [K in keyof B]?: Migration } = {};
  for (const name of Object.keys(bodies)) {
    // `keyof B` narrowing without `as`: iterate the typed keys through a guard.
    if (isKeyOf(bodies, name)) out[name] = migrationOf(name, bodies[name]);
  }
  return completed(bodies, out);
};
```

Here `isKeyOf` is a `(o, k: string): k is keyof typeof o & string` guard. `completed` checks that every key is present and returns `{ readonly [K in keyof B]: Migration }` through an overload whose implementation signature is the widened one. That is the same no-`as` technique plan 08 used for `records`/`hookPoints` ("an overloaded local function declaration … the implementation signature is the widened one", plan 08 Decisions). The executor picks whichever of the two compiles under `tsgo`. Both are allowed; an `as` is not.

```ts
type NamesOf<G> = G extends Readonly<Record<infer K, Migration>> ? K & string : never;

/** Names in two groups at once: `never` when the groups are disjoint. */
type Shared<Gs extends ReadonlyArray<unknown>> = /* pairwise `keyof` intersection over the tuple */;

/**
 * BEH-EA-037/038 (plan 22): the plugin's migration ledger, the one place its historical order is
 * written. `order` must name every migration of every group exactly once, and two groups may not
 * share a name; both are compile errors. Positions are migration ids (BEH-EA-038): append, never
 * reorder.
 */
export const ledger = <
  const Gs extends ReadonlyArray<Readonly<Record<string, Migration>>>,
  const O extends ReadonlyArray<NamesOf<Gs[number]>>,
>(
  groups: Gs & ([Shared<Gs>] extends [never] ? unknown : { readonly sharedNames: Shared<Gs> }),
  order: O &
    ([Exclude<NamesOf<Gs[number]>, O[number]>] extends [never]
      ? unknown
      : { readonly missing: Exclude<NamesOf<Gs[number]>, O[number]> }),
) => order.map((name) => lookup(groups, name));
```

- The error-carrying intersection (`{ readonly missing: … }`) is the repository's existing trick for a readable compile error that names the offending keys (plan 05's coverage map, plan 08's `RecordsLegal`).
- A name listed **twice** in `order` cannot be caught by `Exclude`. A `Duplicates<O>` tuple check is possible but heavy for `tsgo`, so `Auth.make` carries the runtime backstop (next bullet). Q6 decides whether to type it too.
- `lookup` finds the group holding `name`. Because `order`'s element type is `NamesOf<…>`, it returns `Migration` without an `Option`: the guard narrows, and an impossible miss dies with `Defects.invariant`.
- **`Auth.make` refuses duplicate names within one plugin.** Add to the declaration validation that already refuses invalid `tables` (plan 05 Phase 3): `plugin "<id>" declares migration "<name>" twice`. BEH-EA-038 gains the sentence.
- `AuthPlugin.Service`'s `migrations` option keeps the type `Migrations` (a plain array). The ledger returns one. Hand-written arrays (test fixtures, third-party plugins) keep compiling. Q7 asks whether to require the ledger by type.

The group's `Up<E>` does not take `SqlClient` from the environment: the body gets `ddl.sql`. That removes three boilerplate lines from each of the 65 migrations (`Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; … })`), and the dialect is resolved once per migration rather than once per statement.

### 3.3 A records module after the change (passkey credentials, abbreviated)

```ts
// packages/passkey/src/PasskeyCredentials.ts — the table's whole story in one file

// ---- schema: append-only (names are ledger ids; never reorder) ----------------------------
export const migrations = Migrations.group({
  create_passkey_credential: ({ sql, timestamp, boolean }) => sql`
    CREATE TABLE passkey_credential (
      id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "webauthnUserId" TEXT NOT NULL,
      "publicKey" TEXT NOT NULL,
      counter INTEGER NOT NULL,
      "deviceType" TEXT NOT NULL,
      "backedUp" ${boolean} NOT NULL,
      transports TEXT NOT NULL,
      aaguid TEXT NOT NULL,
      name TEXT NOT NULL,
      "createdAt" ${timestamp} NOT NULL,
      "lastUsedAt" ${timestamp} NOT NULL
    )`,
  create_passkey_credential_user_id_index: ({ index }) =>
    index("passkey_credential_user_id", "passkey_credential", ["userId"]),
  add_passkey_credential_counter_anomaly_at: ({ sql, timestamp }) =>
    sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyAt" ${timestamp}`,
  add_passkey_credential_counter_anomaly_count: ({ sql }) =>
    sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyCount" INTEGER NOT NULL DEFAULT 0`,
  // D2 (plan 22): a WebAuthn signCount is a uint32; int4 overflows at 2^31 on Postgres.
  widen_passkey_credential_counter: ({ sql, only }) =>
    only({ pg: () => sql`ALTER TABLE passkey_credential ALTER COLUMN counter TYPE BIGINT` }),
});

// ---- codec (beside the DDL it decodes) ---------------------------------------------------
const makeCredentialRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({ /* … */ counter: wire.int64, backedUp: wire.boolean, createdAt: wire.dateTime /* … */ });
```

```ts
// packages/passkey/src/Passkey.ts — the ledger only
migrations: Migrations.ledger(
  [PasskeyCredentials.migrations, ChallengeStore.migrations, PasskeyUserHandles.migrations],
  [
    "create_passkey_credential",
    "create_passkey_credential_user_id_index",
    "create_passkey_challenge",
    "create_passkey_challenge_expires_at_index",
    "add_passkey_credential_counter_anomaly_at",
    "add_passkey_credential_counter_anomaly_count",
    "create_passkey_user_handle",
    "widen_passkey_credential_counter", // appended (plan 22, D2)
  ],
),
```

On SQLite the new migration is a recorded no-op, because SQLite's `INTEGER` is already 64-bit. Both ledgers stay in step.

### 3.4 Admin: the frozen columns are derived and checked

The two trigger migrations stay dialect-branched, since they are genuinely different SQL. Their column lists come from one place, which the compiler ties to the row schema:

```ts
// packages/admin/src/ImpersonationRecords.ts (module-private)
type ImpersonationColumn = keyof ReturnType<typeof makeImpersonationRow>["Type"];
/** The columns an UPDATE may set, and only while the episode is open (closing it). */
type Closable = "endedAt" | "endedBy";

/** As frozen by `add_admin_impersonation_immutability_triggers` (shipped; never edit). */
const frozenBeforeTenancy = [
  "id", "adminUserId", "targetUserId", "sessionId", "reason", "startedAt", "expiresAt",
] as const satisfies ReadonlyArray<ImpersonationColumn>;

/** Accepts a column list only when it names every column that is not `Closable`; the error names the rest. */
const everyColumnBut = <const C extends ReadonlyArray<ImpersonationColumn>>(
  columns: C &
    ([Exclude<ImpersonationColumn, Closable | C[number]>] extends [never]
      ? unknown
      : { readonly unfrozen: Exclude<ImpersonationColumn, Closable | C[number]> }),
) => columns;

/** The current set. A new row field fails to compile here until it is frozen or made `Closable`. */
const frozen = everyColumnBut([...frozenBeforeTenancy, "tenantId"]);

/** pg: the guard function's UPDATE condition; sqlite: the immutable trigger's WHEN clause. */
const changed = (sql: SqlClient.SqlClient, columns: ReadonlyArray<ImpersonationColumn>, distinct: "IS DISTINCT FROM" | "IS NOT") =>
  sql.join(" OR ", false)(columns.map((c) => sql`NEW.${sql(c)} ${sql.literal(distinct)} OLD.${sql(c)}`));
```

Both migrations call `changed(sql, frozenBeforeTenancy, …)` and `changed(sql, frozen, …)` inside their existing pg and sqlite branches (§2.1 rows `:704`, `:782`). Adding a column to the row schema without handling it is now a compile error at `frozen`'s `everyColumnBut` call. The developer must either freeze it, which requires a new trigger-recreating migration because the shipped ones render their own historical array, or add it to `Closable`.

The completeness check rides on a call whose result is used (`frozen`), not on a standalone constant or type alias. `tsconfig.base.json:35` sets `noUnusedLocals`, which would flag an unused one.

**Dialect constraint**: `sql(c)` in a plpgsql function body (`$$ … $$`) is rendered into the statement text, not bound. That matches what the hand-written body does today. `sql.unsafe` is not needed, and the body has no parameters.

### 3.5 Tests that see the schema: `TestSql.schemaOf` and the contract additions

```ts
// packages/test/src/TestSql.ts (addition)
export interface ColumnShape { readonly name: string; readonly type: LogicalType; readonly notNull: boolean; readonly hasDefault: boolean; readonly primaryKey: boolean }
export interface IndexShape { readonly name: string; readonly table: string; readonly columns: ReadonlyArray<string>; readonly unique: boolean; readonly partial: boolean }
export interface TriggerShape { readonly name: string; readonly table: string }
export interface SchemaShape {
  readonly tables: Readonly<Record<string, ReadonlyArray<ColumnShape>>>;
  readonly indexes: ReadonlyArray<IndexShape>;
  readonly triggers: ReadonlyArray<TriggerShape>;
}
/** `text | timestamp | boolean | integer` from the declared type: pg `information_schema`; SQLite `pragma table_info` (declared type text). */
export type LogicalType = "text" | "timestamp" | "boolean" | "integer" | "other";

/** The structural schema of the ambient database, minus the two ledgers and SQLite internals. Sorted, so it compares by value. */
export const schemaOf: Effect.Effect<SchemaShape, SqlError, SqlClient.SqlClient>;
```

- **SQLite:** `sqlite_master` for names. `pragma_table_info(t)` gives `name`, `type`, `notnull`, `dflt_value`, `pk`. `pragma_index_list(t)` + `pragma_index_info(i)` give columns (an expression column reads as `NULL` name, recorded as `"<expr>"`), `unique` and `partial`. Triggers come from `sqlite_master WHERE type = 'trigger'`.
- **Postgres:** `information_schema.columns` (`data_type`, `is_nullable`, `column_default`) and `pg_index`/`pg_class`/`pg_attribute` for index columns and flags (`indisunique`, `indpred IS NOT NULL`). Triggers come from `pg_trigger WHERE NOT tgisinternal`. Use `current_schema()`, because `TestSql` gives each suite its own schema.
- **LogicalType mapping.** pg: `timestamp with time zone → timestamp`, `boolean → boolean`, `integer|bigint → integer`, `text → text`. SQLite: the declared type `TEXT → text`, `INTEGER → integer`. **Parity rule:** pg `timestamp` matches SQLite `text`, pg `boolean` matches SQLite `integer`. Everything else must match exactly.

Uses:

1. **Schema lock (Phase 0, permanent).** For every first-party plugin and the template, `packages/<p>/test/Schema.lock.test.ts` runs core plus the plugin's migrations on SQLite `:memory:` and asserts `schemaOf` equals a committed `test/schema.sqlite.json` via `expect(...).toMatchFileSnapshot(...)`. Run vitest with `--update` only deliberately; CI runs without it. The lock is what proves Phases 2–7 change no schema. Q2 decides whether it stays after the plan. The recommendation is yes: it is the first, cheapest piece of ADR-EA-004's deferred drift detection.
2. **`runPluginContractTests`, new case "every declared table and tenancy column exists".** After `applyMigrations` (`TestAuth.ts:821-843`, switched from the `sqlite_master` text read to `schemaOf`), every key of `plugin.tenancy` (or `plugin.tables`) is a table in the schema. A `partitioned(column)` or `keyed(column)` column exists on it, and a `derived(parent, via, parentKey)` `via` column exists on the table and `parentKey` on the parent. Global tables only need to exist. Third-party plugins get it for free (BEH-EA-198).
3. **`runPluginContractTests`, new case "the same logical schema on Postgres and SQLite"**. It runs only when `AWTHAQ_POSTGRES_URL` is set: apply to both, `schemaOf` each, compare under the parity rule, and name the first difference (table, column, aspect).
4. The existing "migrations apply identically on two fresh databases" keeps its meaning and compares `schemaOf` instead of `sqlite_master.sql` text. Whitespace in a trigger body or `"id"` versus `id` is not a schema difference.
5. **SSMS-006 for plugins.** A source scan in the shape of `CoreMigrations.test.ts:110-127`, placed in `packages/test/test/PluginMigrations.test.ts`. It scans `packages/*/src/**/*.ts` and `examples/plugin-template/src`, and asserts there is no `CREATE (UNIQUE )?INDEX` outside `packages/sql/src/SqlDdl.ts` and `CoreMigrations.ts`. Every plugin index then goes through `ddl.index`.

### 3.6 How far the helper goes (decision, with counts)

| Option | What it removes | Real callers | Cost | Verdict |
|---|---|---|---|---|
| (a) Keep `onDialectOrElse` twins | nothing | n/a | 49 twins; each new column is two edits; drift between twins is unchecked (none found today, by luck) | rejected: ADR-EA-004's own goal |
| (b) **Type fragments + `index` + `only` + `group`/`ledger`** | 46 of 49 twins (11 identical + 35 type-only), plus the roles `now()` default; 65 × 3 lines of per-migration scaffolding; SSMS-006 by construction | 63 migrations in 12 packages, 47 indexes, template | ~150 lines in `SqlDdl.ts`/`Migrations.ts` + tests | **chosen** |
| (c) (b) + a generic frozen-columns trigger builder in `SqlDdl` | the admin trigger's column list | 1 table (admin); core has no triggers (`CoreMigrations.ts`: none) | a library API with one caller | rejected: no second caller. §3.4 does it module-privately, which gives the same compile-time guarantee |
| (d) A table DSL (`Table.make({ columns })` → `CREATE TABLE` + row schema) | the column list written twice (DDL + row schema), ~24 tables | the 24 `CREATE TABLE`s only | an IR with per-dialect rendering; it cannot express 23 of the 65 migrations (ALTERs, dedupe-then-unique-index, backfills, cross-plugin claim migration); a table's *current* shape is the fold of its history, so a DSL either regenerates applied DDL (unsafe) or needs a diff planner | rejected: reopens ADR-EA-004's rejected alternative ("bespoke schema IR"), whose planner half BEH-EA-039 relocated to the CLI |

Measured effect of (b) on the 1,509 lines of plugin migration source:

- 325 duplicated DDL lines go (the second copy of every identical and type-only block).
- About 184 lines of `onDialectOrElse`/`orElse` scaffolding go.
- About 195 lines of per-migration `Effect.gen`/`SqlClient` scaffolding go.

That is roughly 700 lines fewer, before the moves.

### 3.7 What stays outside

- The tenancy declarations stay on the plugin class (static, read by `Auth.make`).
- `Auth.make`'s renumbering, the two ledgers, `Migrations.run`, the CLI's drift report and `Migrator`: untouched.
- User-field migrations (`UserFields.migrationFor`, `core/src/UserFields.ts:273`) are already generated and dialect-neutral apart from one structural branch. They are untouched.
- Core's `CoreMigrations.ts` (Q1).

---

## 4. Phased migration

Phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Every phase from 2 on also requires **the schema lock to be unchanged**, except Phase 4, which adds one migration and updates the passkey lock in the same commit, with the diff reviewed. Phases 4–7 also run `pnpm test:pg`, because SQL statements change. Plan gate: `pnpm check && pnpm test:pg`. Before starting, re-run the §2.1 inventory: the script is in §5.4, and any migration added by plans 11–21 joins the phase of its package.

### Phase 0: pin the schema and the defects (tests first)

Files:

1. `packages/test/src/TestSql.ts`: add `schemaOf`, `SchemaShape`, `LogicalType` and `parityDifferences(a, b)` (§3.5). Unit-test them in `packages/test/test/TestSqlSchema.test.ts`: a hand-made table, index, partial index, expression index and trigger, on SQLite (and Postgres under `test:pg`).
2. `packages/<p>/test/Schema.lock.test.ts` for admin, api-key, device-authorization, jwt, organization, passkey, qadi, roles, saml, scim, two-factor, webhooks and `examples/plugin-template`. Each one migrates core plus `Auth.make([<plugin's dependsOn closure>, Plugin]).migrations` and runs `toMatchFileSnapshot("schema.sqlite.json")`. Generate the snapshots at `fc990c88`'s behaviour (this phase changes no source), then commit them.
3. Failing tests, each named after its defect:
   - `packages/test/test/PluginMigrations.test.ts`: "SSMS-006: every plugin index is created IF NOT EXISTS (through SqlDdl.index)". This is the source scan of §3.5 item 5 and **fails** (47 hits).
   - `packages/passkey/test/PasskeyCredentials.test.ts`, inside `suite(name, layer)`: "a WebAuthn signature counter up to 2^32 - 1 round-trips". Run `create` with `counter: 2 ** 32 - 1`, then `recordUsage(id, 2 ** 32 - 1, …)`, and read it back. It **fails only on Postgres** (`test:pg`) and passes on memory and SQLite. Mark it in the ticket so the executor does not mistake a green SQLite run for the fix.
   - `packages/core/test/AuthPlugin.test.ts`: "Auth.make refuses a plugin that declares one migration name twice". It **fails**.
   - `packages/test/src/TestAuth.ts` gets the two new contract cases (§3.5 items 2, 3). "Declared tables and tenancy columns exist" **passes** today for every first-party plugin, which is the guard for later phases. The parity case runs under `test:pg`, and its expected result is a pass at `fc990c88` (the type-only twins already agree). If it fails, the twin that drifted is a finding for §2. Record it in the ticket.
4. `.scratch/table-ddl-locality/issues/00-baseline.md`: the inventory output, the lock files and the `test:pg` result (or "not run: no Docker").

Gate: phase gate. The SSMS-006 scan and the duplicate-name test are `it.fails` until Phases 1 and 7 turn them green. Mark them that way, never skipped, so the suite stays green.

### Phase 1: `SqlDdl` and `Migrations.group`/`ledger` (additive)

1. `packages/sql/src/SqlDdl.ts` (§3.1), exported from `packages/sql/src/index.ts` as `SqlDdl`. Add `int64` to `Models.dialectFields` (`Models.ts:171-182`).
2. `packages/sql/test/SqlDdl.test.ts`. For each fragment and for `index` (plain, unique, expression, partial, with columns needing quotes), compile the statement on both dialects. Use a pg `Statement.Compiler` (`@effect/sql-pg`'s `PgClient.makeCompiler`) and SQLite's, with no database needed, and assert the SQL text. On SQLite `:memory:` (and pg under `test:pg`), run every fragment in a `CREATE TABLE` and read it back through `TestSql.schemaOf`. `only` runs the branch for the current dialect and skips the other.
3. `packages/core/src/Migrations.ts`: `Up`, `group`, `ledger` (§3.2). Rewrite the stale header text (§2.5).
4. `packages/core/src/Auth.ts`: refuse duplicate migration names per plugin (the Phase 0 test turns green). BEH-EA-038 sentence (§6).
5. `packages/core/test/Migrations.test.ts` (new). `group` keys names and resolves the dialect once per migration. `ledger` returns the order. Type tests in `packages/core/test/Migrations.types.test.ts` with `// @ts-expect-error`: a name missing from `order`, a name not in any group, and two groups sharing a name.
6. `.changeset/sql-ddl-fragments.md` (`@awthaq/sql`, `@awthaq/core` minor; §6.4).

### Phase 2: the colocated three (two-factor, qadi) and roles

1. `two-factor/src/TwoFactorStore.ts:607-680`: rewrite as `export const migrations = Migrations.group({...})` with `timestamp` and `index`. `TwoFactor.ts:58`/`:477` uses `Migrations.ledger([TwoFactorStore.migrations], [the three names])`.
2. `qadi/src/UserClaims.ts:190-212`: same.
3. `roles/src/Roles.ts:195-230` → `roles/src/RoleAssignments.ts` (owner of the codec and queries, `:106-188`). The `DEFAULT now()`/`strftime` branch becomes `DEFAULT ${nowTimestamp}`. `Roles.ts:324` uses the ledger. Delete the stale comment `:185-194`.
4. Gate: schema lock unchanged for the three. `RolesSql.test.ts`, `UserClaims.test.ts` and `TwoFactorStore.test.ts` are green.

### Phase 3: admin

1. Move `Admin.ts:576-825` (comment, both lists) into `ImpersonationRecords.ts` as `export const migrations = Migrations.group({...})`, with the seven names in order. The four type-only/identical ones use fragments and `index`.
2. The two trigger migrations keep their `pg`/`sqlite` bodies, with the column lists rendered from `frozenBeforeTenancy`/`frozen` (§3.4). `everyColumnFrozen` is added.
3. `Admin.ts:836` → `Migrations.ledger([ImpersonationRecords.migrations], [...])`. Delete the stale comments (`:585-589`, `:699-700`).
4. Tests: `ImpersonationRecords.test.ts`'s tamper cases (SQL-only, `:339-575`) are the behavioural proof that the triggers still refuse a frozen-column UPDATE. Run them on SQLite and pg. Add one type test in `packages/admin/test/ImpersonationRecords.types.test.ts` with `// @ts-expect-error`: a row schema with an extra field and no `frozen`/`Closable` entry does not compile. Exercise it by a local copy of the guard type over a widened row type, not by editing the real schema.
5. Gate: schema lock unchanged. The trigger *structure* (name, table) is in the lock. Trigger bodies are compared by the tamper tests, not by text.

### Phase 4: passkey, and the counter fix

1. `Passkey.ts:803-958` → split by owner: `PasskeyCredentials.ts` (migrations 1, 2, 5, 6), `ChallengeStore.ts` (3, 4), `PasskeyUserHandles.ts` (7). `Passkey.ts:1032` uses the ledger (§3.3). Rewrite the stale comment (`:803-826`) as each module's short schema header.
2. Append `widen_passkey_credential_counter` (pg-only `ALTER COLUMN counter TYPE BIGINT`, via `only`) to `PasskeyCredentials.migrations` and to the ledger's end.
3. `PasskeyCredentials.ts` row schema: `counter: wire.int64`. Every insert and update binds through the schema's encode (so the pg parameter is a `bigint`). Check every raw `sql` interpolation of `counter` in `layerSql` (`:366-381`, `:418-431`): it must go through a `SqlSchema` request with `wire.int64`, or bind `BigInt(counter)` explicitly on pg. The Phase 0 round-trip test is the arbiter.
4. Update `packages/passkey/test/schema.sqlite.json`. The only diff must be the new ledger row, since SQLite's `counter` stays `INTEGER` and is now a no-op. The parity case under `test:pg` sees `integer` on both sides (bigint → integer).
5. Gate: phase gate plus `pnpm test:pg` (the counter test turns green on Postgres).

### Phase 5: api-key, device-authorization, jwt

1. `ApiKey.ts:313-386` → `ApiKeyRecords.ts` (`create_apikey_key`) and `ApiKeyClientRecords.ts` (`create_apikey_client`). The ledger goes in `ApiKey.ts:767`.
2. `DeviceAuthorization.ts:182-252` → `DeviceGrantRecords.ts` and `DeviceClientRecords.ts`, including their indexes created inside the `CREATE` migrations (4 `ddl.index`). The ledger goes at `:733`.
3. `Jwt.ts:476-555` → `SigningKeyRecords.ts` (1, 3, 4: the partial index `index(…, ["createdAt"], { where: sql\`"rotatedAt" IS NULL\` })` and the expression-plus-partial unique index `index(…, [sql\`("rotatedAt" IS NULL)\`], { unique: true, where: … })`) and `RevocationStore.ts` (2). The ledger goes at `:581`. Delete the stale comment `:464-474`.
4. Gate: schema lock unchanged. `test:pg`.

### Phase 6: webhooks, SAML, SCIM

1. `Webhooks.ts:195-303` → `WebhookRecords.ts`. The ledger goes at `:405`.
2. `Saml.ts:177-348` → `SamlRecords.ts` (all seven, including `claim_saml_connection_domains`, which keeps its clash query and its failure message verbatim). The ledger goes at `:818`.
3. `Scim.ts:366-439` → `ScimRecords.ts`. The ledger goes at `:505`.
4. Gate: schema lock unchanged. `SamlDomainClaimMigration.test.ts` green on both dialects. `test:pg`.

### Phase 7: organization

1. Split `OrganizationMigrations.ts` by the owner column of §2.2 into the eight records modules' `migrations` groups. Move the header comment's still-true parts (dedupe-before-unique, closure-table rationale, no-foreign-keys) to the owning module.
2. `Organization.ts:106` (or `OrganizationBundle.ts`, per Q5): `migrations: Migrations.ledger([OrganizationRecords.migrations, MembershipRecords.migrations, InvitationRecords.migrations, TeamRecords.migrations, OrgRoleRecords.migrations, ActiveContextRecords.migrations, ConnectionRecords.migrations, DomainClaims.migrations], [the 21 names of §2.2, in order])`.
3. Delete `OrganizationMigrations.ts`. Its importers are `Organization.ts` only (`grep -rln OrganizationMigrations` at `fc990c88`).
4. The SSMS-006 scan (Phase 0) now finds no plugin `CREATE INDEX` outside `SqlDdl`, so drop its `it.fails`.
5. Gate: schema lock unchanged. All eight organization records suites green on SQLite and pg.

### Phase 8: template, docs, spec

1. `examples/plugin-template/src/Template.ts:204-243`: `notesMigrations` → `Migrations.group` beside `NoteRecords`, and `migrations: Migrations.ledger([migrations], [...])` at `:326`. Rewrite the teaching comment: "A statement that differs between dialects only by a type uses `SqlDdl`'s fragments; an index is `ddl.index` (always `IF NOT EXISTS`); a statement that exists on one dialect only is `ddl.only`; a body that is genuinely different per dialect (a trigger) is the rare exception, branched with `ddl.sql.onDialectOrElse` inside the one migration."
2. `docs/plugin-authoring.md`:
   - Table row `:16`: "Migrations | `Template.ts` (`migrations`, a `Migrations.group` beside the records) | Append-only; one statement per change, dialect types from `SqlDdl`; the plugin's `migrations` is a `Migrations.ledger`."
   - Rewrite `## Migrations` (`:119-125`): the precise append-only rule (§2.3), groups beside the records module, `SqlDdl` fragments, `ddl.index` for SSMS-006, the ledger and its compile errors, the schema lock, and the two new contract checks. Keep the quoting and dialect-codec bullets (`:123-124`), and add the `int64` wire codec and its pg `bigint` note.
   - Checklist item 1 (`:242`): "`migrations` (a `Migrations.ledger` over your records modules' groups)". New item: "a `Schema.lock.test.ts` over your plugin's migrations".
3. `packages/sql/README.md`: "Migrating a populated database" (`:121`) adds "plugin indexes too: `SqlDdl.index` renders `IF NOT EXISTS`". Fix the id range (`:117`).
4. Spec, ADR, traceability and changesets: §6.

---

## 5. Test plan

**Replace, don't layer.** The new checks live at the interface that owns them: `SqlDdl` (rendering), `Migrations` (identity), `runPluginContractTests` (declarations against schema, cross-dialect parity) and the schema lock (no-change proof). No records suite gains a migration test. Each keeps migrating through `Migrations.run(Plugin.migrations)` exactly as today, so the DDL coverage stays in each records suite by construction.

### 5.1 New tests

| Test | Where | Dialects | Proves |
|---|---|---|---|
| `SqlDdl` fragments and `index`/`only` render the expected SQL | `sql/test/SqlDdl.test.ts` | compiled for both; executed on SQLite (+pg) | §3.1 |
| `schemaOf` reads columns, indexes (expression, partial), triggers | `test/test/TestSqlSchema.test.ts` | SQLite (+pg) | §3.5 |
| `group` keys names; `ledger` keeps order; duplicates and omissions do not compile | `core/test/Migrations.test.ts`, `Migrations.types.test.ts` | n/a | §3.2 |
| `Auth.make` refuses a duplicate migration name | `core/test/AuthPlugin.test.ts` | n/a | §3.2 |
| Schema lock per plugin | `packages/<p>/test/Schema.lock.test.ts` × 12 + template | SQLite | goal 3 |
| Declared tables and tenancy columns exist | `runPluginContractTests` (every `Contract.test.ts`) | SQLite | D3 |
| Same logical schema on pg and SQLite | `runPluginContractTests` | pg + SQLite (`test:pg`) | goal 6 |
| SSMS-006 for plugins | `test/test/PluginMigrations.test.ts` | source scan | D1 |
| Counter up to 2^32-1 round-trips | `passkey/test/PasskeyCredentials.test.ts` suite | memory, SQLite, pg | D2 |
| A new impersonation column must be frozen or closable | `admin/test/ImpersonationRecords.types.test.ts` | type-level | §3.4 |

### 5.2 Existing tests that change

- `runPluginContractTests` "migrations apply identically on two fresh databases" (`TestAuth.ts:1096-1128`): compares `schemaOf` instead of the `sqlite_master` text (§3.5 item 4). Its test name and meaning are unchanged.
- `features/` BDD: `PluginContractSteps.ts`/`CompositionSteps.ts`/`PluginFixtures.ts` reference fixture migration names, not first-party ones (`grep` at `fc990c88`). They need no change, but run `pnpm test:bdd`. Add one scenario under BEH-EA-198 in the plugin-contract feature: "a plugin whose partitioned column does not exist fails the contract suite" (REQ id: the next free one, above `REQ-EA-1306` today, re-checked at execution).

### 5.3 Deleted

No test is deleted. `organization/src/OrganizationMigrations.ts` is deleted as source in Phase 7.

### 5.4 Re-measurement

The inventory script (TypeScript AST over the migration files) is reproduced in the Phase 0 ticket. Acceptance re-runs it: `onDialectOrElse` inside plugin migration code = 2 (the admin triggers), `CREATE INDEX` outside `SqlDdl` = 0.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 ADR

**ADR-EA-004 → revision 1.3** (this plan amends it; no new ADR). Change history: "1.3 (plan 22): dialect-neutral plugin DDL through `SqlDdl` fragments; a table's migrations live with its records module and the plugin's `migrations` is a `Migrations.ledger`."

Add a Consequences paragraph, **Dialect-neutral DDL (revision 1.3)**:

> The decision's goal, "without plugin authors hand-writing dialect-specific DDL", was not met by `Model.Class` alone: migrations stayed hand-written, and 49 of 65 plugin migrations carried a `pg` and a `sqlite` copy of one statement (46 differing only by a type token). `@awthaq/sql`'s `SqlDdl` supplies the dialect's type tokens as fragments (`timestamp`, `boolean`, `false`/`true`, `int64`, `autoIncrementKey`, `nowTimestamp`), an index builder that is always `IF NOT EXISTS` (SSMS-006), and `only` for a one-dialect statement; a statement is written once. Each table's migrations are a `Migrations.group` in the records module that owns its codec and queries; the plugin's `migrations` is a `Migrations.ledger` that names the historical order (ids are positions: BEH-EA-038) and fails to compile when it omits a migration or two groups share a name. A shipped migration's source may be refactored only when the plugin's schema lock (a structural snapshot of the schema its migrations build) does not move; what it builds never changes.

Add to Alternatives: "**A table DSL that renders `CREATE TABLE` and the row schema from one declaration** (plan 22 §3.6). Rejected: a table's current shape is the fold of its migration history, 23 of 65 plugin migrations are ALTERs, backfills and repairs a table DSL cannot express, and rendering applied DDL from a current definition needs the diff planner BEH-EA-039 keeps out of the runtime. It is this ADR's original rejected alternative under another name."

### 6.2 Behaviours (each with a Document Control revision and a change-history line)

- `spec/behaviors/05-persistence-stratum.md` → **1.6**.
  - BEH-EA-037: append "**As shipped (plan 22):** a plugin's migrations are declared as `Migrations.group({ <name>: (ddl) => … })` in the records module that owns the tables, and composed by `Migrations.ledger(groups, order)` on the plugin class. Both are static values, resolvable without evaluating `make`."
  - BEH-EA-038: replace "(ids 1–17)" and "≤ 17" with "core's own ids" (§2.5). Add: "`Auth.make` refuses a plugin that declares one migration name twice (plan 22); a migration's name and position are its identity in both ledgers and in `awthaq migration status`."
  - New **BEH-EA-<next free>** "A plugin's migrations build one logical schema on every supported dialect". REQUIREMENT: every statement differing only by a dialect type is written once through `SqlDdl`; every plugin index is `IF NOT EXISTS`; `runPluginContractTests` checks the declared tables and tenancy columns exist and, under Postgres, that the logical schema matches SQLite's. Append it at the end of the file as plan 05 did for BEH-EA-324..328, so `spec/README.md`'s ranges list it. The number is the next free id at execution: 338 at `fc990c88`, but siblings allocate first.
- `spec/behaviors/25-testing-harness.md` → **1.5**. BEH-EA-198: add the two new checks to the "As shipped" paragraph, and "schemas compare structurally (`TestSql.schemaOf`), not by statement text".
- `spec/behaviors/17-passkey.md` → **1.4**. BEH-EA-131: "The stored signature counter holds the full WebAuthn `signCount` range (uint32) on every dialect (plan 22, D2)."
- `spec/behaviors/28-tenancy.md`: no text change. BEH-EA-328's declarations are now checked against the schema; add that sentence only if the executor finds the BEH's "As shipped" text lists the validations.

### 6.3 Traceability

- `spec/traceability.md:147` (ADR-EA-004 row): add `packages/sql/test/SqlDdl.test.ts`, `packages/core/test/Migrations.test.ts`, the `Schema.lock.test.ts` files, `packages/test/test/PluginMigrations.test.ts` and the new BEH id. Bump the document revision (1.32 at `fc990c88`).
- `features/traceability.md`: the new REQ row (§5.2).

### 6.4 Changesets (ADR-EA-034; every package is in the fixed group)

- Phase 1, `.changeset/sql-ddl-fragments.md`, `@awthaq/sql` minor, `@awthaq/core` minor:
  > `SqlDdl` renders the dialect-specific DDL tokens (`timestamp`, `boolean`, `int64`, `autoIncrementKey`, `nowTimestamp`) as fragments and builds `IF NOT EXISTS` indexes; `Migrations.group`/`Migrations.ledger` declare a records module's migrations beside its codec and compose a plugin's ledger, checked at compile time (ADR-EA-004 rev 1.3, BEH-EA-037). `Auth.make` refuses a plugin that names one migration twice (BEH-EA-038).
  >
  > Migration: none required. A plugin that declares two migrations with the same name now fails `Auth.make`; rename one by appending a new migration (never rename an applied one).
- Phases 2–7, `.changeset/plugin-ddl-locality.md`, every touched plugin, patch:
  > Each table's migrations moved into its records module and are written once for both dialects. Migration names and order are unchanged; an already-migrated database applies nothing new and `awthaq migration status` reports no drift. Plugin indexes are created `IF NOT EXISTS` (SSMS-006), so an index built `CONCURRENTLY` beforehand no longer fails the deploy.
  >
  > Migration: none.
- Phase 4, `.changeset/passkey-counter-bigint.md`, `@awthaq/passkey` minor:
  > The stored signature counter accepts the full WebAuthn range (up to 2^32 - 1) on Postgres; a new migration `widen_passkey_credential_counter` widens the column to `BIGINT` (a no-op on SQLite) (BEH-EA-131).
  >
  > Migration: run the plugin migrations. On a large `passkey_credential` table the `ALTER COLUMN … TYPE BIGINT` rewrites the table under an exclusive lock; schedule it.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| A moved migration is renamed or reordered by accident, so a migrated database drifts | The ledger lists names as literals checked against the groups at compile time. `schemaOf` excludes the ledger tables, so each Phase 0 lock test also asserts `Plugin.migrations.map((m) => m.name)` equals the `fc990c88` list, written out literally in the test |
| A fragment renders a different type than the twin it replaces | The schema lock compares declared types per column on SQLite; the pg parity case compares them on Postgres in CI. Both are run before and after each phase |
| `IF NOT EXISTS` hides a genuinely conflicting index of the same name but a different definition | SSMS-006 already accepts this for core (same name, same definition is the operator's contract, README `:123`). The lock proves the definition on a fresh database |
| A records module now imports `Migrations` from `@awthaq/core` and `SqlDdl` from `@awthaq/sql` → a cycle | Records modules already import `@awthaq/core` (for example `MembershipRecords.ts:8`) and `@awthaq/sql` (`:9`). roles and qadi have no `@awthaq/sql` dependency: they use `Migrations.Up`'s `ddl` parameter only (its type comes through core's re-export), so no new package edge. `pnpm circular` gates every phase |
| The pg `BIGINT` change of a populated table locks it | Changeset `Migration:` line. The column is small and the table is per-credential |
| `int64` encoding: `@effect/sql-pg` requires a `bigint` for an int8 parameter (`PgTypes.ts:1246-1259`) | All counter writes go through the row schema's encode (Phase 4 step 3); the Phase 0 test runs on pg in CI |
| Docker is unavailable locally (plans 05, 07, 08 could not run `test:pg`) | The pg-only checks (parity, counter) run in CI's Postgres service (`.github/workflows/check.yml:31-50`). The executor records "not run locally" honestly, and the PR does not merge until CI's `test:pg` is green |
| Plans 11–21 add a plugin migration in the same wave | §4 preamble: re-run the inventory before starting. A new migration joins its package's phase, written with `SqlDdl` |

**Rollback.** Each phase from 2 on is a pure move per package and reverts alone. Phase 1 is additive. Phase 4's new migration cannot be "un-applied" on a database that ran it. Reverting the code after that would leave `awthaq migration status` reporting an unknown applied row, so revert Phase 4 only before a release, or keep its migration and revert the rest.

---

## 8. Interactions with other plans

- **05 (done).** Builds on its `tables` tenancy declarations (now checked against the schema, D3), `StoreFailure` (D2's `StoreUnavailable` mapping) and the template's partitioned table. No change to `TenantScoped`/`TenantScope`.
- **08 (done).** Builds on `runPluginContractTests`' schema check (`TestAuth.ts:821-843`) and `TestSql` in `@awthaq/test`. The records bundles are untouched.
- **16 (sql-store-adapters).** Both plans touch `packages/sql/src/index.ts` (16 removes `Repositories`, 22 adds `SqlDdl`) and `packages/sql/README.md` (16 fixes `:9-25`, 22 fixes `:117`/`:121`). Rebase whichever lands second; there is no semantic overlap. After 16, adopting `SqlDdl` in `CoreMigrations.ts` is a natural follow-up (Q1).
- **17 (core-sealed-columns).** No DDL change expected there. If it adds a core migration, it is in core's ledger (not touched here).
- **23 (relay-cursor-store).** The relay cursor table is core migration 27 (`CoreMigrations.ts:603`). If 23 moves the table to a ports-level store, its DDL stays in core's ledger. No interaction unless 23 turns it into a plugin table, in which case it uses `Migrations.group`.
- **15 (host-composition).** Derives the servable layer, including migrations, from `Auth.make`. `built.migrations` keeps its type and order, so no interaction beyond reading BEH-EA-038's new duplicate refusal.
- **24 (memory records over SQLite).** 24 runs **after** 22 and edits the same 24 records modules, so 22 moves the DDL in first. If 24's spike says "go" (SQLite becomes the memory path), every records module is left with one adapter plus its DDL, and 22's locality makes each one self-contained. 22's pg-versus-SQLite parity check becomes the main guard, because almost every test would then run on SQLite. If 24's spike says "no-go" (its recommended default), 24's parity contract migrates through the ledgers 22 builds. D2 (the counter range) is fixed here, and 24 §2 lists it as a memory/Postgres drift owned by 22.
- **11–14, 18–21.** No shared files beyond line shifts in `Passkey.ts` (plan 12: the passkey ceremony) and `Admin.ts` (plan 13: the admin gate). Phases 3 and 4 move code *out* of those files, so rebase on whichever lands first and re-verify line numbers.

---

## 9. Acceptance checklist

- [ ] `@awthaq/sql` exports `SqlDdl` (fragments, `index`, `only`); `Models.dialectFields` has `int64`.
- [ ] `@awthaq/core` `Migrations` exports `group`, `ledger` and `Up`; omissions and shared names are compile errors (type tests); `Auth.make` refuses a duplicate name.
- [ ] No plugin class file (`Admin.ts`, `ApiKey.ts`, `DeviceAuthorization.ts`, `Jwt.ts`, `Organization.ts`, `Passkey.ts`, `Roles.ts`, `Saml.ts`, `Scim.ts`, `Webhooks.ts`, `TwoFactor.ts`) contains `CREATE`, `ALTER` or `DROP`; each has a `Migrations.ledger`. `OrganizationMigrations.ts` is deleted.
- [ ] Every plugin's `migrations.map(m => m.name)` equals its `fc990c88` list; passkey's has one appended name.
- [ ] Every schema lock is unchanged from Phase 0, except passkey's one reviewed ledger addition.
- [ ] `onDialectOrElse` in plugin migration code: 2 (admin triggers). `CREATE (UNIQUE )?INDEX` outside `SqlDdl.ts`/`CoreMigrations.ts`: 0. The SSMS-006 scan is green without `it.fails`.
- [ ] The admin frozen-column lists render from one checked array; the type test proves an unfrozen new column does not compile; the tamper tests are green on SQLite and pg.
- [ ] Passkey counter test is green on memory, SQLite and Postgres.
- [ ] `runPluginContractTests` checks declared tables and tenancy columns (all plugins green) and, under `test:pg`, cross-dialect parity (all plugins green).
- [ ] No `as` (other than `as const`), no return-type annotations on new Effect/Layer consts.
- [ ] Template and `docs/plugin-authoring.md` teach groups, ledger, `SqlDdl`, the precise append-only rule and the schema lock; `packages/sql/README.md` updated.
- [ ] ADR-EA-004 rev 1.3; BEH-EA-037/038 (+ new BEH), BEH-EA-198, BEH-EA-131 with revision bumps; traceability updated; `pnpm spec:verify:strict` green.
- [ ] Changesets with `Migration:` lines for Phases 1, 2–7 and 4.
- [ ] `pnpm check` green; `pnpm test:pg` green in CI (and locally if Docker runs).

---

## 10. Open questions only the user can answer

1. **Core's migrations.** Adopt `SqlDdl` in `CoreMigrations.ts` too (29 twin blocks, of which 21 differ by identifier quoting as well as types)? It is the same refactor, but on the ledger that is most sensitive to drift, and in plan 16's package. *Recommended: not in this plan. A follow-up ticket after plan 16 lands, behind core's own schema lock.*
2. **Keep the schema lock after the plan?** It makes every schema change a reviewed JSON diff, which is the first slice of ADR-EA-004's deferred drift detection. It also means a deliberate schema change touches two files. *Recommended: keep it permanently, and let `docs/plugin-authoring.md` teach it.*
3. **Editing shipped migrations' source.** This plan rewrites the source of every applied plugin migration, behaviour-preservingly, and retrofits `IF NOT EXISTS`. The alternative is to freeze the shipped bodies verbatim and use `SqlDdl` only for new migrations. That gives zero risk to history but keeps all 49 twins. *Recommended: rewrite, with the lock as proof. Nothing is published (all packages 0.1.0, no tags), and every applied body never re-runs.*
4. **Passkey counter.** Widen to `BIGINT` with a new migration (correct for the full uint32 range, a table rewrite on Postgres), or clamp the stored counter at 2^31 - 1 (no migration, but a counter-regression check against a clamped value would read every later assertion as "moved forward" forever)? *Recommended: widen.*
5. **Where the ledger lives for organization.** On `Organization.ts` (where `migrations` is declared), or in `OrganizationBundle.ts` beside the records bundle (`Organization.ts:108`)? *Recommended: `OrganizationBundle.ts`, which already gathers the eight modules; `Organization.ts` imports it.*
6. **Duplicate names in `order`.** `Exclude` catches an omission but not a name listed twice. The runtime `Auth.make` refusal catches it at the first build. Add a type-level duplicate check too (costs `tsgo` time on a 21-name tuple)? *Recommended: runtime only. A duplicate fails every test that builds the plugin, so it cannot ship.*
7. **Require the ledger by type?** Make `AuthPlugin.Service`'s `migrations` accept only a branded `Migrations.Ledger`, so a plugin cannot pass a hand-written array? It is stricter, but every test fixture and BDD fixture plugin (`features/step-definitions/PluginFixtures.ts`) would change. *Recommended: no. Keep `Migrations` (array) and teach the ledger. The compile-time checks only matter where there are groups.*
