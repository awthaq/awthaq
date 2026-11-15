# Phase 3: Keyset-page module - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 24 (new + modified)
**Analogs found:** 22 / 24 (two have only partial analogs)

Line numbers below are from this worktree. 03-RESEARCH.md has the per-listing inventory and the golden literals; this file only adds the analogs and excerpts.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `packages/ports/src/Keyset.ts` (new) | utility (pure helper) | transform | `packages/ports/src/PruneExpired.ts` | exact (pure helper) |
| `packages/ports/src/index.ts` (+1 export) | config (barrel) | n/a | its own `export * as` block | exact |
| `packages/ports/test/Keyset.test.ts` (new) | test | transform | `packages/ports/test/pruneExpired.test.ts` | exact |
| `packages/sql/src/KeysetSql.ts` (new) | utility (SQL builder) | request-response | `OrganizationRecords.ts:420-427` (row-value) + `AuditLogStoreSql.ts:192` (`sql.and`) | role-match |
| `packages/sql/test/KeysetSql.test.ts` (new) | test | transform | `packages/sql/test/UserStoreSql.test.ts` scaffold | role-match |
| `packages/ports/src/UserStore.ts` (modify: `next` to `nextCursor`, delete `byCreation`, memory via `paginate`) | port + memory adapter | CRUD | itself (`:146-157`, `:183-186`, `:359-381`) | exact |
| `packages/sql/src/UserStoreSql.ts` (modify `usersPage` `:176-192`, slice `:473-492`) | SQL adapter | CRUD | `OrganizationRecords.ts:414-437` | role-match |
| `packages/core/src/Users.ts` (delete `listLimit` `:556-561`, `DEFAULT_LIST_LIMIT` `:381`) | service | CRUD | itself | exact |
| `packages/admin/src/ImpersonationRecords.ts` (memory `:196-205,457-466`; SQL `:682-702,768-784`; delete `pageLimit` `:108-114`, `toPage` `:209-219`) | records (memory + SQL) | CRUD | itself | exact |
| `packages/organization/src/OrganizationRecords.ts` (`listPage` returns `Page`; memory `:211-232`, SQL `:414-437`) | records | CRUD | `ImpersonationRecords.ts` page-returning shape | role-match |
| `packages/organization/src/OrganizationDirectory.ts` (`listPage` `:67-71,218-219`) | service | CRUD | itself | exact |
| `packages/admin/src/AdminTenants.ts` (`:198-212`: drop `+1`, trim, clamp) | service | request-response | `Admin.listUsers` `Admin.ts:727-730` (gate then delegate) | exact |
| `packages/admin/src/AdminApi.ts` (`LimitSchema` `:160-163`, `MAX_PAGE_SIZE`) | config (wire) | request-response | itself; keep the three cursor schemas | exact |
| `packages/test/src/internal/storeContract/users.ts` (new case near `:505`) | test (contract) | CRUD | existing `listPage` case `:505-534` | exact |
| `packages/admin/test/contract/ImpersonationRecords.ts`, `packages/organization/test/contract/OrganizationRecords.ts` (RecordsContract cases) | test (contract) | CRUD | `ImpersonationRecords.ts:447-570` | exact |
| Golden cursor test (new, e.g. `packages/admin/test/KeysetCursors.test.ts`) | test (pin) | transform | `packages/cli/test/PluginViews.test.ts` (header) + `packages/test/test/TestAuthSurface.test.ts` | role-match |
| `features/step-definitions/PersistenceMigrationSteps.ts` (`.next` at `:139-141,234-238`), `TenancyWorld.ts:287`, `CoreStoresSql.test.ts:394-397`, `UserStoreSql.test.ts:310`, `Users.test.ts:827`, `OrganizationConnections.test.ts:74` | test/step | CRUD | mechanical rename | exact |
| `spec/overview.md` (`surface:ports` `:96-128`) | doc | n/a | existing alphabetical block | exact |
| `spec/behaviors/05-persistence-stratum.md` (BEH-EA-036 `:97-114`, Rev 1.13 to 1.14) | doc | n/a | Rev 1.13 row | exact |
| `spec/traceability.md` + `features/traceability.md` | doc | n/a | Phase 2 commit 34f572a9 | exact |
| `.changeset/<name>.md` (new) | config | n/a | `.changeset/cli-plugin-views-config-list.md` | exact |

## Pattern Assignments

### `packages/ports/src/Keyset.ts` (utility, transform)

**Analog:** `packages/ports/src/PruneExpired.ts` (pure helper, no layer, per-file `import * as X from "effect/X"`).

**Header and imports** (PruneExpired.ts lines 1-9). A `//` comment block first (no `/** */`), then blank line, then:
```typescript
import * as DateTime from "effect/DateTime";
import * as HashMap from "effect/HashMap";

/** The map size below which pruning is skipped: ... */
const pruneThreshold = 10_000;

/** Drops every entry whose expiry is at or before `now`. */
export const pruneExpired = <K, V>(
  map: HashMap.HashMap<K, V>,
  now: DateTime.Utc,
  expiryOf: (value: V) => DateTime.Utc,
): HashMap.HashMap<K, V> => ...
```
Conventions to copy: `.ts` extensions on relative imports, namespace imports `import * as Effect from "effect/Effect"` / `import * as Option from "effect/Option"` / `import * as Order from "effect/Order"` (the research sketch's `import { Option, Order } from "effect"` is NOT the house style; use subpath namespace imports), `import type` only for pure types, one-line `/** */` on each export, header comment may start `// @awthaq/ports — Keyset` (see `Defects.ts:1`, `RelayCursorStoreSql.ts:1`).
- No `as` and no `any` in `packages/*/src` (oxlint `consistent-type-assertions: never`; `as const` is fine). Use accessor functions per key, not `row[column]`.
- Exported generics need explicit return annotations (TS2883).
- Barrel: add alphabetically between `Jws` and `KeyProvider`... `Keyset` sorts after `KeyProvider`:
```typescript
export * as KeyProvider from "./KeyProvider.ts";
export * as Keyset from "./Keyset.ts";
export * as LegacySessionBridge from "./LegacySessionBridge.ts";
```
(`packages/ports/src/index.ts` lines 33-35 today; the `export * as` lines are the machine-checked list.)

### `packages/ports/test/Keyset.test.ts` (test, transform)

**Analog:** `packages/ports/test/pruneExpired.test.ts`.
```typescript
// TMS-004: the shared eviction the in-memory Sessions/Verification twins use.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as PruneExpired from "../src/PruneExpired.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

describe("pruneExpired (TMS-004)", () => {
  it("drops only entries ...", () => {
    ...
    assert.deepStrictEqual(Array.from(HashMap.keys(pruned)), ["future"]);
  });
});
```
For effectful `paginate` with a fake `fetch`, use `it.effect("...", () => Effect.gen(function* () { ... }))` (the repo's `@effect/vitest` style). Import the module as `import * as Keyset from "../src/Keyset.ts"`.

### `packages/sql/src/KeysetSql.ts` (utility, request-response)

**Analogs:** row-value predicate `packages/organization/src/OrganizationRecords.ts:420-427`; `sql.and` composition `packages/sql/src/AuditLogStoreSql.ts:192` and `ImpersonationRecords.ts:690-702`; imports `RelayCursorStoreSql.ts:9-20`.

Row-value (copy this spelling, it is the target form):
```typescript
r.afterCreatedAt === null || r.afterId === null
  ? sql`SELECT * FROM organization_org ORDER BY "createdAt", id LIMIT ${r.limit}`
  : sql`SELECT * FROM organization_org
        WHERE ("createdAt", id) > (${r.afterCreatedAt}, ${r.afterId})
        ORDER BY "createdAt", id LIMIT ${r.limit}`,
```
Composition with other filters (to be replaced by `KeysetSql.after(...)` inside `sql.and`):
```typescript
const conditions = [
  TenantScoped.predicate(sql, "tenantId", r.seen),
  ...(r.active ? [sql`"endedAt" IS NULL`] : []),
  ...(cursor ? [sql`("startedAt" < ${r.cursorStartedAt} OR ("startedAt" = ${r.cursorStartedAt} AND id < ${r.cursorId}))`] : []),
];
return sql`SELECT * FROM admin_impersonation WHERE ${sql.and(conditions)} ORDER BY "startedAt" DESC, id DESC LIMIT ${r.limit + 1}`;
```
Imports to copy: `import * as SqlClient from "effect/sql/SqlClient";` (and `Statement` type for the fragment: `import type * as Statement from "effect/unstable/sql/Statement"` only if that is where the repo gets it; grep `Statement.Fragment` in `packages/sql/src` before writing, I did not verify the module path). Cross-package: `import { Keyset } from "@awthaq/ports";` (named namespace import from the barrel, as `RelayCursorStoreSql.ts:9`). `@awthaq/ports` is already a dependency of `packages/sql/package.json:33`. `ports` must not import `sql`.
Cursor values must be bound through the existing dialect codecs (`models.wire.nullableDateTime`, `dialectFields`; see `UserStoreSql.ts:176-183` Request struct), so Postgres receives a `Date` and SQLite the fixed-width ISO text. Column names and direction come from the closed declaration, never from input.

**Dying on mixed direction (lint/convention):** the Defects helpers (`Defects.invariantViolation`, `Defects.ts:50-51`) return an `Effect.die`, so they do not fit a pure builder. The repo precedent for refusing a bad declaration at construction in pure code is a `throw new <TaggedError>`: `packages/core/src/UserFields.ts:146-165` (`throw new InvalidDeclaration({ key, message: "awthaq: ..." })`). Recommended: `throw new Defects.InvalidConfiguration({ setting: "keyset order", message: "awthaq: ..." })` in `KeysetSql.make` (class is exported at `Defects.ts:19`). Message is a constant sentence starting `awthaq:`. If `make` is ever made effectful, switch to `Defects.invalidConfiguration(setting, message)`.

### `packages/sql/test/KeysetSql.test.ts` (test)

**Analog:** `packages/sql/test/UserStoreSql.test.ts:1-25` (SQLite via `@effect/sql-sqlite-node/SqliteClient`, `@effect/vitest`, `.ts` relative imports). Header style is a `//` paragraph naming what the file pins and what lives elsewhere. Include a refusal test: `assert.throws(() => KeysetSql.make(mixedOrder))`. Postgres cases are not written here; the existing `*.postgres.test.ts` files (`CoreMigrations.postgres.test.ts`, `ReadRouting.postgres.test.ts`) are the precedent for PG-only files in this package.

### Adopting stores (UserStore, UserStoreSql, ImpersonationRecords, OrganizationRecords)

Current spellings to replace (excerpts for the planner to delete/convert):
- `UserStoreSql.ts:176-192` expanded OR with `LIMIT ${request.limit + 1}`; the `+1` moves out to `paginate` (the SQL `fetch` does `LIMIT ${take}`).
- `ImpersonationRecords.ts:696-702` OR form with `LIMIT ${r.limit + 1}`; memory `rows.slice(0, limit+1)` at `:466`.
- `OrganizationRecords.ts:424-427` already row-value with `LIMIT ${r.limit}`; org memory `:211-232`; caller `AdminTenants.ts:202` adds `limit: limit + 1` (delete, same commit as the store change).
- `Admin.listUsers` `Admin.ts:727-730` is the shape for the thin caller: `gate.collection` then the store call, no clamp or trim. The post-page `gate.visibleEpisodes` at `Admin.ts:983-991` stays.

### Contract cases (StoreContract users, RecordsContract suites)

**Analog:** `packages/test/src/internal/storeContract/users.ts:505-534`. Case shape: a named group with `read: [ { name: "<sentence>", run: Effect.gen(function* () { const store = yield* UserStore.UserStore; ... }) } ]`. Add new cases as further entries in the `read` array (or a new key beside `listPage`), same helpers (`newUser("b", { minutes: 5 })`, `userIds`), loops over limits, `assert.deepEqual`. Rename `page.next` to `page.nextCursor` in the existing case.
Parametrization: nothing per-case. `RecordsContract.ts:66,116,263-272` defines suites with `read`/`write`/`sql` arrays; `sql` cases run only in SQL mode (`sql: true` row at `:266`). Memory, SQLite `:memory:`, WAL, libSQL, sealed variants come from `StoreContract.*.test.ts` files; Postgres is selected by `process.env["AWTHAQ_POSTGRES_URL"]` in `packages/test/src/TestSql.ts:26` and `contractRunner.ts:631`, so there is no explicit per-case skip: with the env unset the same suites run on SQLite. Put PG-only expectations (collation self-consistency, whole-ms precision) in a `sql` case. Gate any exact-code-unit expectation to canonical lowercase uuidV7 ids; mixed-case ids assert only complete/no-duplicate/resumable (CI is Debian `postgres:16`, `en_US.utf8`).
Admin/organization suites: `packages/admin/test/contract/ImpersonationRecords.ts:447-570` (limit sweep, normalised limits `[0,-3,2.5,NaN,10000]`, local `codeUnit` helper) and `packages/organization/test/contract/OrganizationRecords.ts:93-100, 285-340` (page-count `Math.floor(7/limit)+1` becomes `Math.ceil(7/limit)`; `rows.some` becomes `page.items`).

### Golden cursor test (pin, written in Wave 0 against today's code)

**Analogs:** Phase 1 `packages/cli/test/PluginViews.test.ts:1-12` (header: ticket id, "pins ... before and after ...; written against the pre-refactor code", exact-equality note) and Phase 2 `packages/test/test/TestAuthSurface.test.ts:1-3` (one-line header, `import { assert, it } from "@effect/vitest"`, `import * as X from "../src/X.ts"`). Header to copy: `// KEY-04, architecture deepening batch 3 phase 3: pins the three keyset cursor wire encodings byte-for-byte, green before and after the keyset module.` Expected values are inline literals (the three base64url strings and decoded JSON in 03-RESEARCH.md "Golden Cursor Values"); also assert equality with `Buffer.from(JSON.stringify({...})).toString("base64url")`. No committed `.mjs` (knip). Place it where the three schemas are importable (`@awthaq/admin` for `UserCursorSchema`, `CursorSchema`, org schema in `AdminTenantsApi.ts:47-58`).

### Spec, traceability, changeset

**Spec Revision bump** (analog `spec/behaviors/05-persistence-stratum.md:8,13`): header table has `| Revision | 1.13 |` and the Change History cell ends with `<br> 1.13 (2026-11-10): BEH-EA-036: every keyset listing normalises an in-process `limit` like `Users.list`; ... (architecture plan 40)`. Append `<br> 1.14 (2026-11-14): BEH-EA-036: ...` and change Revision to 1.14 in the same edit (check 14 regex `(?:^|<br>|;)\s*(\d+\.\d+)\s*\(`). Do the same for `spec/overview.md` (1.17 to 1.18) and `spec/traceability.md` (1.90 to 1.91). Reference commits (read with `git show`): Phase 2 `34f572a9` ("docs(02-05): cite ... in spec behaviors, traceability and invariants"; commit body lists each file with its new Revision) and Phase 1 `ffe1e99f`. No new BEH id (avoids the check 17 range bump).
**`surface:ports` block** (`spec/overview.md:96-128`): add the line `Keyset` between `KeyProvider` and `LegacySessionBridge`; it must equal the `export * as` names of `index.ts` (32 after this phase). Also add a `Keyset` row to the module table (`:132+`, format `| \`Name\` | kind | notes |`).
**Changeset** (analog `.changeset/cli-plugin-views-config-list.md`): frontmatter lists each package with a bump, a prose paragraph, then a blank line and a `Migration:` line:
```
---
"@awthaq/cli": minor
---

<what changed, BEH ids>

Migration: <what callers do instead>
```
For this phase name `@awthaq/ports`, `@awthaq/sql`, `@awthaq/admin`, `@awthaq/organization`, `@awthaq/core`, `@awthaq/test` (single `fixed` group, CONTRIBUTING.md:104) and put in the `Migration:` line: `UserStore.listPage` page field `next` is now `nextCursor`; `OrganizationRecords.listPage`/`OrganizationDirectory.listPage` return a page (callers stop adding and trimming `limit + 1`); `pageLimit`, `DEFAULT_PAGE_SIZE` removed from `@awthaq/admin` (use `Keyset.limit`).

## Shared Patterns

### Tracked-source check
All analog paths above were verified as source files under `packages/`, `spec/`, `.changeset/`; none is a `.gsd/capabilities` mirror. Plans should still not cite anything under `.claude/`.

### Defect convention
`packages/ports/src/Defects.ts:19,50`: typed tagged classes with constant `awthaq: ...` messages; `Effect.die` helpers for effects, `throw new <Tagged>` for pure construction (`UserFields.ts:148`).

### No assertions, explicit return types
`consistent-type-assertions: never` in `packages/*/src`; annotate exported generic returns.

### Do-not-touch (KEY-07)
MembershipRecords, SessionStore/SessionStoreSql, SCIM, AuditLog stores, webhook deliveries (including their own `MAX_PAGE_SIZE`): diff must be empty.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `Keyset.paginate` existential `key(...)` with accessors | utility | transform | No in-repo generic multi-key ordering helper exists; use Effect `Order.mapInput/combine/flip` per RESEARCH.md and spike for `as`-free typing |
| Postgres-only precision/collation cases | test | CRUD | No existing case is PG-specific inside StoreContract; only whole-file `*.postgres.test.ts` files exist in `packages/sql/test` |

## Metadata

**Analog search scope:** `packages/ports`, `packages/sql`, `packages/test`, `packages/admin`, `packages/organization`, `packages/cli/test`, `spec/`, `.changeset/`
**Pattern extraction date:** 2026-11-14
