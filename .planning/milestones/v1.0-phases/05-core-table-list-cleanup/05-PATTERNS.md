# Phase 5: Core-table list cleanup - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 17
**Analogs found:** 16 / 17 (the catalogue module itself has only a style analog)

Analog paths were checked as git-tracked source (`git ls-files`). Line numbers are from reads this session; re-read before editing. Full design, pin matrix (P1-P8), drift-guard skeleton and AAD pin literals are in `05-RESEARCH.md` (Q2, Q5, Code Examples); this file only assigns analogs and excerpts.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/sql/src/CoreTables.ts` (NEW) | utility (declaration module) | transform | `packages/sql/src/KeysetSql.ts` (header + typed exports), `CoreSealedColumns.ts` (declarations) | role-match (style) |
| `packages/sql/src/TenantScope.ts` (MOD :44-53) | utility | transform | itself | exact |
| `packages/sql/src/index.ts` (MOD) | barrel | n/a | itself :29 (`CoreSealedColumns`) | exact |
| `packages/test/src/LaggingReplica.ts` (MOD :30-38) | test double | CRUD | itself; imports `ReadRouting` from `@awthaq/sql` already | exact |
| `packages/core/src/Auth.ts` (MOD :779-782, :886, import :22) | service (link-time check) | request-response | itself | exact |
| `features/step-definitions/TenancySteps.ts` (MOD :17, :69-77, :123) | BDD steps | request-response | itself | exact |
| `packages/sql/test/CoreTablePins.test.ts` (NEW, Wave 0) | test | transform | `packages/sql/test/TenantScoped.test.ts` (coverage fixtures), `packages/test/test/CoreSealedColumns.test.ts:416-445` | role-match |
| `packages/sql/test/CoreTables.test.ts` (NEW, drift guard) | test | batch (migrations) | `packages/sql/test/SqlDdl.test.ts` | exact |
| `packages/test/test/LaggingReplica.test.ts` (NEW, P5) | test | CRUD | `packages/test/test/ReadRouting.test.ts` | role-match |
| `packages/core/test/AuthTenancy.test.ts` (MOD, P6) | test | request-response | itself :45-48 | exact |
| `packages/sql/test/TenantScope.postgres.test.ts` (MOD, P8) | test | CRUD | itself (`describe.skipIf(skip)`, near :176) | exact |
| `.changeset/core-table-catalogue.md` (NEW) | changeset | n/a | `.changeset/keyset-page-module.md` | exact |
| `spec/behaviors/28-tenancy.md`, `spec/overview.md`, `spec/traceability.md` (MOD) | spec | n/a | their own Revision/Change History | exact |
| `packages/sql/README.md` (MOD :126, :150) | doc | n/a | itself | exact |
| `05-BASELINE.md` (NEW) | doc | n/a | `.planning/phases/04-connection-lifecycle-module/04-BASELINE.md` | exact |

## Pattern Assignments

### `packages/sql/src/CoreTables.ts` (utility, transform)

**Analog (style):** `packages/sql/src/KeysetSql.ts:1-17`: a `// @awthaq/sql: <Name> (<REQ>, <BEH>)` header comment explaining the contract, then `import type` for type-only edges, then exported, doc-commented declarations.

**Shape to copy:** the compiled prototype in `05-RESEARCH.md` "Pattern 1" (`declared` as const tuple in migration-creation order; one explicit typed `const` per view; no `as`, since `.oxlintrc.json` forbids assertions in `packages/*/src`).
- Import only `./CoreSealedColumns.ts` (DAG: `SealedColumn <- CoreSealedColumns <- CoreTables <- TenantScope`); never `TenantScope`, `TenantScoped`, `CoreMigrations` (`pnpm circular` counts type-only imports).
- Relative imports name `.ts` files, house style `import * as CoreSealedColumns from "./CoreSealedColumns.ts";`.
- `sealed` = `CoreSealedColumns.deployed({ encryptPii: true }).filter((c) => c.table === name)`. Never copy the six declarations.
- Annotate every exported const with an explicit type (TS2883).
- Public views: `tables`, `names`, `partitionedTables`, `directoryTables`, `stamped`, `replicated`, `isStamped(name: string): boolean`.
- Entry keys only: `name`, `owner: "core"`, `tenancy`, `replicated`, `sealed`, `reason?` (no column types or DDL; key-set test enforces ADR-EA-004).

### `packages/sql/src/TenantScope.ts` (MOD)

**Current** (`TenantScope.ts:43-53`):
```typescript
/** Per-user, per-request tables that partition by tenant. */
export const partitionedTables = [
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
] as const;

/** The global identity directory (DRS-005): unique across tenants, RLS only on request. */
export const directoryTables = ["users", "accounts"] as const;
```
**Change:** keep names and doc comments; body becomes `= CoreTables.partitionedTables` / `= CoreTables.directoryTables` with `import * as CoreTables from "./CoreTables.ts";` beside `import * as TenantScoped from "./TenantScoped.ts";` (:39). `coverage` (:103-108) is untouched. Element type becomes the literal union (tuple type is lost; changeset note).

### `packages/sql/src/index.ts` (barrel)

Add `export * as CoreTables from "./CoreTables.ts";` between `CoreStoresSql` and `KeysetSql`? Alphabetical: after `CoreSealedColumns` (:29), before `CoreStoresSql` ("CoreT" > "CoreS", so after `CoreStoresSql`). Place it right after `CoreStoresSql`. Header comment lines 1-5 mention modules; add a one-line mention only if neighbours do.

### `packages/test/src/LaggingReplica.ts` (MOD)

**Current** (:30-38) is the hand copy with a wrong doc comment ("The core tables `CoreMigrations` creates"). **Change:**
```typescript
import { CoreTables, ReadRouting } from "@awthaq/sql";
/** The tables the catalogue marks replicated (`CoreTables.replicated`): the stamped core tables, in creation order. */
export const coreTables: ReadonlyArray<string> = CoreTables.replicated;
```
Keep the export name and `ReadonlyArray<string>` type; `make` still uses `options.tables ?? coreTables` (:59). Import line today is `import { ReadRouting } from "@awthaq/sql";` (:1).

### `packages/core/src/Auth.ts` (MOD)

**Current** (:779-782 and :884-886):
```typescript
const coreTables: ReadonlyArray<string> = [
  ...TenantScope.partitionedTables,
  ...TenantScope.directoryTables,
];
...
    if (parent === undefined) {
      if (coreTables.includes(tenancy.parent)) continue;
```
**Change:** delete the const; use `CoreTables.isStamped(tenancy.parent)` (NOT all names, so `auth_relay_cursor`/`rate_limit_buckets` stay `UnknownParent`). Import (:22) becomes `import { CoreTables, type SealedColumn, TenantScope, type TenantScoped } from "@awthaq/sql";`; check `TenantScope` is still used elsewhere in the file before keeping it (knip/lint).

### `features/step-definitions/TenancySteps.ts` (MOD)

**Current:** import `:17` `import { Models, TenantScope, TenantScoped } from "@awthaq/sql";`; literal `STAMPED_TABLES` `:69-77` (doc "The tables `BEH-EA-231` names; the only identifiers ever spliced into a query"); use `:123`:
```typescript
assert.ok(STAMPED_TABLES.includes(table), `"${table}" is not a stamped table`);
```
**Change:** delete the literal, `assert.ok(CoreTables.isStamped(table), ...)`, add `CoreTables` to the import. Keep the per-table `switch` (:437-495, `default: assert.fail`). Keep the "only identifiers spliced into a query" comment on the assertion. Edge `features -> @awthaq/sql` exists (devDependencies).

### `packages/sql/test/CoreTables.test.ts` (test, drift guard)

**Analog:** `packages/sql/test/SqlDdl.test.ts:1-14`:
```typescript
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlDdl from "../src/SqlDdl.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const SqlLive = TestSql.layer("sql_SqlDdl");
...
    }).pipe(Effect.provide(SqlLive)),
```
Header comment style: "Runs on SQLite, and on Postgres under `pnpm test:pg` (the same file, `TestSql.layer` picks the database)." Copy it. Use the `it.effect` + `TestSql.schemaOf` (`shape.tables[name]` columns) + `Migrator.make({})({ loader: CoreMigrations.coreMigrations })` skeleton from `05-RESEARCH.md` Code Examples; layer name `"sql_CoreTables"`. Import `TestSql` by relative path only (knip baseline); filter `RateLimiterStoreSql.migrationsTable` out of the table set. Add the five guard assertions from Q5, the key-set test, and the projection-equals-oracle checks.

### `packages/sql/test/CoreTablePins.test.ts` (Wave 0, green on unchanged src)

**Analogs:** coverage fixture `declared` in `packages/sql/test/TenantScoped.test.ts` (`describe("TenantScope.coverage")`, ~:138-171; note :167-171 is a relative assertion and pins nothing); AAD order check `packages/test/test/CoreSealedColumns.test.ts:416-445`. Pin with `assert.deepStrictEqual` against inline literals (never `toMatchFileSnapshot`, which `-u` can regenerate). Run `coverage` for the 5-option matrix and freeze the real output. Created-table pin (P4) uses the same `TestSql.layer` shape as the guard. Pre-refactor, import from `../src/TenantScope.ts`, `../src/CoreSealedColumns.ts`, `../src/SealedColumn.ts`.

### `packages/test/test/LaggingReplica.test.ts` (P5)

**Analog:** `packages/test/test/ReadRouting.test.ts` (only existing consumer of `LaggingReplica`); copy its import style (`@awthaq/test` internal relative imports) and `it.effect` layout. Minimal: `assert.deepStrictEqual(LaggingReplica.coreTables, ["users","accounts","sessions","verification_tokens","verification_reservations","auth_audit_log"])`.

### `packages/core/test/AuthTenancy.test.ts` (P6)

**Analog:** same file :45-48:
```typescript
it("accepts a core table as a Derived parent", () => {
  const p = plugin("ctx", { ctx_a: T.derived("sessions", "sessionId") });
  assert.strictEqual(Auth.make([p] as never).tenancy.length, 1);
});
```
Add a loop over `users, accounts, verification_tokens, verification_reservations, auth_audit_log` (accepted) and `auth_relay_cursor, rate_limit_buckets` (refused; copy the existing `UnknownParent` refusal assertion from the `stranger_a` case in the same file).

### `packages/sql/test/TenantScope.postgres.test.ts` (P8)

**Analog:** same file; header "Skips (not fails) without `AWTHAQ_POSTGRES_URL`", existing `describe.skipIf(skip)` blocks, probes via `PgClient`. Add one `it.effect` near :176: after `enableRls({ includeDirectory: true })`, `pg_class.relrowsecurity` true for exactly the six stamped tables, false for `auth_relay_cursor`. Run with `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`.

### `.changeset/core-table-catalogue.md`

**Analog:** `.changeset/keyset-page-module.md`: frontmatter of `"@awthaq/pkg": minor|patch` lines, one paragraph describing the module, blank line, `Migration:` paragraph. Packages: `@awthaq/sql: minor`, `@awthaq/test: patch`, `@awthaq/core: patch`. `Migration:` text: the lists' values are unchanged; code indexing `partitionedTables`/`directoryTables` by literal position must widen (tuple type is now `ReadonlyArray` of the literal-name union); `LaggingReplica.coreTables` unchanged.

### Spec, README, baseline

- Spec: bump `Revision` and the newest Change History entry together in each touched doc (`28-tenancy.md` 1.15->1.16 naming `CoreTables` in BEH-EA-231 at :34-36; `overview.md` 1.18->1.19 package-map row :48; `traceability.md` 1.93->1.94 rows for the three new test files). Verify BEH ids (A3). Check 10 needs every cited test path to exist; check 14 needs Revision == newest Change History.
- `packages/sql/README.md`: :126 and :150 call the tables the catalogue's stamped tables; add a short "Core tables" paragraph (catalogue, two classified exclusions).
- `05-BASELINE.md`: copy the structure of `04-BASELINE.md` (every gate at HEAD, Known intermittents section, "run locally on the CI image, CI confirmation open (no git remote)").

## Shared Patterns

### No assertions in library source
**Source:** `.oxlintrc.json` (`typescript/consistent-type-assertions: never`, `as const` allowed). **Apply to:** `CoreTables.ts`, the `TenantScope.ts`, `LaggingReplica.ts`, `Auth.ts` edits. Use inferred type predicates over the `as const` tuple, never `as`.

### Dual-dialect tests from one file
**Source:** `packages/sql/test/SqlDdl.test.ts:1-3,9-10` (`TestSql.layer("sql_<Name>")`). **Apply to:** `CoreTables.test.ts`, `CoreTablePins.test.ts` created-table pin.

### Frozen literals, never self-referential asserts
**Source:** `05-RESEARCH.md` Pitfall 1. **Apply to:** all pins: the expected side is inline text; do not compare a view to the list it was derived from.

### Order is a contract
Declare entries in migration-creation order (`users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log, auth_relay_cursor, rate_limit_buckets`); never sort in a view. Pins P1, P2, P5 and the `STAMPED_TABLES` literal catch drift.

### Dependency / lint gates
`tsc -b` then `tsc -p tsconfig.test.json`, `pnpm circular`, `pnpm knip` (baseline: 39 `.claude/` files + 3 unlisted deps in `readme-quickstart.ts`), `pnpm check:readmes`, `pnpm spec:verify:strict`. Known intermittents: passkey `Contract.test.ts` consume-atomic and organization `TenantMiddleware.test.ts` suspended-org (one re-run).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/sql/src/CoreTables.ts` | declaration catalogue | transform | No existing module is a data-first table classification; use the compiled prototype in RESEARCH "Pattern 1" and `KeysetSql.ts` for header and doc style only |

## Metadata

**Analog search scope:** `packages/sql/{src,test}`, `packages/test/{src,test}`, `packages/core/{src,test}`, `features/step-definitions`, `.changeset`, `.planning/phases/04-*`
**Pattern extraction date:** 2026-11-14
