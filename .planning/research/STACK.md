# Technology Stack

**Project:** awthaq, milestone v1.0 Architecture Deepening (batch 3)
**Researched:** 2026-11-14
**Overall confidence:** HIGH (every claim was read from installed sources in `node_modules/.pnpm/effect@4.1.2` and the repo itself; no external docs were needed)

## Verdict

**Add no new dependencies. Change no versions.** All eight candidates are internal restructurings of code that already sits on the right primitives. The work is design (where the seam goes, what the interface hides), not tooling.

### Version correction (read this first)

The brief says the repo pins `effect@4.0.0-rc.116`. It does not.

- `pnpm-workspace.yaml` catalog: `effect: ^4.1.2`, and every `@effect/*` package is `^4.1.2`.
- `pnpm-lock.yaml` resolves `effect@4.1.2` (importer entries: `version: 4.1.2(effect@4.1.2)`), `vitest@5.0.2`, `typescript@7.0.2`, `oxlint@1.92.0`, `knip@6.44.1`.
- `node_modules/.pnpm/` still holds stale `effect@4.0.0-rc.116` and `@effect/*@4.0.0-rc.116` directories from an older install. Nothing in the lockfile importers points at them. The only `rc.116` strings left in `pnpm-lock.yaml` are `@effect-cucumber/*` peer ranges (`^4.0.0-rc.116`), which 4.1.2 satisfies.
- A root `node_modules/effect` symlink does not exist. Each package resolves `effect` through `packages/<pkg>/node_modules/effect` -> `.pnpm/effect@4.1.2/`. Research and plans must read **`node_modules/.pnpm/effect@4.1.2/node_modules/effect/src`**, not the rc.116 directory sitting beside it.
- Import paths are `effect/sql/SqlClient`, `effect/schema/Model`, `effect/cli/Command`, `effect/http-api/HttpApi` (no `unstable/` segment). Modules in `sql/`, `http/`, `http-api/`, `cli/`, `schema/Model`, `persistence/` carry `@stability unstable`; the catalog comment already records that a later 4.x minor can change them.

## Recommended Stack (unchanged)

### Core

| Technology | Version (installed) | Purpose | Why |
|------------|---------------------|---------|-----|
| effect | 4.1.2 | Services, Layers, Schema, Stream, SQL | Every primitive the eight candidates need exists in it (table below) |
| @effect/sql-sqlite-node / sql-pg / sql-libsql | 4.1.2 | Dialect drivers | Keyset and record-store work must stay dialect-neutral; `pnpm test:pg` covers pg |
| @effect-cucumber/vitest | 0.10.1 | BDD runner | Already provides the Layer-scoping the test-host composer needs (see candidate 3) |
| @effect/vitest | 4.1.2 | Effect-aware tests | Unchanged |
| vitest | 5.0.2 | Runner | Unchanged |
| typescript / @effect/tsgo | 7.0.2 / catalog | Compiler, Effect language service | Unchanged; pinned as a pair |

### Per-candidate: what already provides the primitive

| # | Candidate | Primitive that already exists | Evidence (4.1.2 source / repo) | New dep? |
|---|-----------|-------------------------------|--------------------------------|----------|
| 1 | Keyset-page module | `Stream.paginate(seed, (s) => Effect<[ReadonlyArray<A>, Option<S>]>)` for "walk every page" consumers; `Order.Tuple` / `Order.combine` / `Order.flip` + `DateTime.Order` for the memory twin's comparator; `sql.and` / `sql.or` / `sql.literal` / `sql.onDialect` for the predicate and direction; `Schema.fromJsonString` + `Schema.StringFromBase64Url` + `Schema.DateTimeUtcFromMillis` if a cursor must be an opaque token | `Stream.ts:1573` (`paginate` emits whole pages, state is `Option<S>`); `Order.ts` (`Tuple` 682, `flip`); `sql/Statement.ts:550-621` (fragment helpers). `AuditLog.replay` already calls `Stream.paginate` (`packages/core/src/AuditLog.ts:469`); `UserStoreSql.ts:176-193`, `ImpersonationRecords.ts:682-702`, `OrganizationRecords.ts:423-426` each hand-write the same `limit + 1` / `(a = x AND id > y)` predicate | No |
| 2 | Connection-lifecycle module (SAML/org/SCIM) | `Data.taggedEnum` for states, `Match` for transitions, `Context.Service` + `Layer.effect` for the module, `Data.TaggedError` for refusals | All present in `Data.ts`, `Match.ts`, `Context.ts`, `Layer.ts`. Effect ships no FSM/statechart library, and none is warranted for a handful of states | No |
| 3 | Test-host composer for BDD Worlds | `describeFeature(feature, { shared, perScenario }, ...)`, `Rule(name, extraLayer, narrow, define)`, `defineSteps<World>`; `Layer.mergeAll` / `provideMerge` / `fresh` / `mock` / `build`; `Context.Service` for each World | `@effect-cucumber/vitest` README (shared vs per-Scenario Layer scope, `Rule` extends the ambient Layer with `Layer.provideMerge`, narrowed Worlds); `Layer.ts` exports confirmed. 31 `*World.ts` files already use this | No |
| 4 | Split `TestAuth.ts` (1869 lines) | Plain TS modules; keep `export * as TestAuth from "./TestAuth.ts"` in `packages/test/src/index.ts` and make `TestAuth.ts` a thin re-exporting barrel over `internal/*.ts` | `packages/test/src/index.ts` exposes the namespace; `package.json` `exports` has a single `.` entry, so no subpath map changes | No |
| 5 | CLI views behind `Output.report`; delete `ConfigList` | `Output.report(value, render)` **already exists** (`packages/cli/src/Output.ts:80`) and `ConfigList.show` already uses it. A "view" is `{ value, render }` data plus one `report` call; `effect/cli` (`Command`, `Flag`, `Prompt`) is already the command layer (ADR-EA-027) | `packages/cli/src/ConfigList.ts` is 28 lines; `Plugin.ts:266-283` still branches on `out.json` and calls `out.document` directly, which is the leak to close | No |
| 6 | Single table catalogue (core/sql/cli) | Plain data module in the lowest stratum that all three can import (`@awthaq/ports` or `@awthaq/sql`), reusing `TenantScoped.Tenancy` / `TableDeclaration` (`packages/sql/src/TenantScoped.ts`) | `Model.Class` carries no table name, so the catalogue cannot be derived from `Models.ts`; it has to be declared once. Tables are currently named as string literals in `UserStoreSql.ts`, `TenantScope.ts`, `CoreSealedColumns.ts`, `TestSql.ts`, `LaggingReplica.ts`, `AdminGate.ts` | No |
| 7 | Shared record-store scaffolding (16 `*Records.ts`) | `Layer.effect`, `Context.Service`, `SqlSchema.*`, existing `@awthaq/sql` `SqlStore` / `StoreFailure` / `TenantScoped` / `SealedColumn`, `MutableHashMap` / `Ref` for the memory twin, `RecordsContract` for the shared contract suite | See "Rejected" for `SqlModel.makeRepository` | No |
| 8 | Fold credential registry into `server/Credentials.ts` | `Context.Service`, `Layer.effect`, `Data.TaggedError`, `Redacted` (all already imported in that file) | `Credentials.ts` is 678 lines and already holds `CredentialResolvers`, `contribute`, `presented`, `Source`. Pure module consolidation | No |

## Candidate notes that affect how plans are written

### 1. Keyset-page module

- **Where the seam goes.** Three pieces, in strata that already exist:
  - `@awthaq/ports` (lowest stratum): the position type and the page result, generic over a key. `{ items, next: Option<Cursor> }` is already the shape of `UserStore.listPage` (`UserStore.ts:152-155`), `ImpersonationRecords.Page` and `AdminTenants`.
  - `@awthaq/ports`: the in-memory comparator, built from `Order.Tuple(DateTime.Order, Order.String)` and `Order.flip` for newest-first, so the memory twin and the SQL `ORDER BY` share one declared sort key.
  - `@awthaq/sql`: the SQL predicate builder, taking the column pair, the direction, and the cursor, returning a `Statement.Fragment`. It reads `limit + 1` rows and trims, as all three existing call sites already do.
- **Direction.** Ascending (`users`, organizations) and descending (`admin_impersonation`) both occur. Use `sql.literal("ASC"|"DESC")` chosen from a closed union, never from caller input.
- **Dialect trap.** `models.wire.nullableDateTime` exists because SQLite binds ISO strings and pg binds `Date` (`Models.ts` header, TS-001). A row-value comparison `(a, b) > (?, ?)` is valid in both engines, but string comparison of ISO timestamps in SQLite only matches `Date` ordering if every writer emits the same format. Keep the existing wire codec in the request schema and prove it with `pnpm test:pg` plus the SQLite suite. Do not "simplify" to a unified column type here.
- **Cursor encoding.** Today callers and `AdminApi` expose a structured cursor (`{ createdAt, id }`), not an opaque token. Changing to an opaque base64url token is an API change, and spec ADR/behaviour (BEH-EA-036) would need revising. Default: keep the structured cursor and put the `Schema` for it in the keyset module. Opaque tokens are available from `Schema.fromJsonString` + `Schema.StringFromBase64Url` if the milestone decides to change the wire.
- **No `as`.** `oxlint` forbids type assertions in `packages/*/src` (`typescript/consistent-type-assertions: never`). A generic keyset module must take explicit accessor/codec functions (`key: (row) => Cursor`) rather than index rows by column-name strings.

### 3. Test-host composer

- `@effect-cucumber/vitest` already gives the two tiers the composer should expose: a `shared` Layer built once per Feature and a `perScenario` Layer, plus `Rule(..., extraLayer, ...)` extension. A composer is therefore a function `(options) => { shared, perScenario }` built from `Layer.mergeAll` / `Layer.provideMerge`. It is not a new abstraction library.
- `Layer.mock` (confirmed in `Layer.ts`) builds partial service stubs for fault injection, which the Worlds currently hand-roll through `Ref<Faults>` (`DomainWorld.ts`).
- `Layer.fresh` is the tool for the case where one World needs a second isolated copy of an otherwise memoised Layer. Layers are memoised by reference within one build; this is the usual source of "two databases" surprises when composing.
- The README warns that a shared Layer is built with `Effect.orDie`, runs before the Scenario's `TestClock` exists, and cannot fork sleeping fibers. A composer that puts clock-dependent services in `shared` will break expiry scenarios.
- `features` already depends on every `@awthaq/*` package, `@effect/sql-sqlite-node`, `@effect/platform-node`; nothing to add.

### 4. `TestAuth.ts` split

- `knip` treats `features/step-definitions/**` and `features/**/*.steps.test.ts` as entries; for `packages/*` it follows `exports`. A new internal file with an export nothing imports is a `knip` failure, so move code and its single importer together.
- `pnpm circular` runs madge twice (value cycles, then type-inclusive cycles). Splitting by concern commonly creates `import type` back-edges (for example `App` <-> `layer` options). Put shared option/result types in one leaf file that both import.
- `packages/test/src/internal/` already holds `contract.ts`, `foundation.ts`, `storeContract/`. Follow that.

### 5. CLI views

- No parser or renderer library. `Output.report(value, render)` is the seam and already honours `--json` (BEH-EA-225) and the no-secrets rule (BEH-EA-201: `Output` never receives a `Redacted`).
- `Plugin.ts` has a second JSON switch, `options.format === "json" || out.json`, that bypasses `report`. Folding it in means deciding what `--format dot` and `--format json` mean beside the global `--json`; that is a CLI behaviour decision (BEH-EA-225/229), not a library question.
- Deleting `ConfigList.ts` also touches `Cli.ts` (the import and the `config list` handler), `packages/cli/package.json` description text, and the CLI/BDD tests that import it. `knip` has `ignoreExportsUsedInFile: true` for `packages/cli`, so a stranded `renderText` export will not be flagged; check by hand.

### 6. Table catalogue

- The `TenantScoped.Tenancy` tagged enum (`Partitioned | Keyed | Derived | Global`) and `TableDeclaration` already exist and `awthaq plugin list` prints them. The catalogue should extend that declaration, not introduce a parallel registry.
- Dependency direction matters for `pnpm circular`: core, sql and cli all consume it, so it lives in `@awthaq/ports` or `@awthaq/sql`, never in `@awthaq/core`.

### 7. Record-store scaffolding

Scaffolding means shared helpers inside `@awthaq/sql` / `@awthaq/ports` for what the 16 files repeat: `layerMemory` + `layerSql` pairing, dialect wire resolution (`SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql))`), tenancy stamping, sealed columns, `StoreFailure` classification. It stays a design task over code that already exists.

### 8. Credentials

No stack content. Note ADR-EA-042 (credential resolution module) is adjacent and must be revised explicitly if the fold changes its decisions.

## Rejected additions (what NOT to add)

| Candidate addition | Why not |
|--------------------|---------|
| `SqlModel.makeRepository` / `SqlResolver` (`effect/sql/SqlModel`) for candidate 7 | It generates only `insert`, `update`, `findById`, `delete` for a `Model.Class` with an id column and an optional soft-delete column, and is `@stability unstable`. The 16 record stores also need tenant stamping/confinement (`TenantScoped`), `StoreFailure` classification and transient retry (`SqlStore.write`), sealed columns, lease/claim updates, keyset listings, locks (`SqlStore.atomically`), and a memory twin under one contract suite. None of that is in the repository helper. The repo uses neither module today (grep: zero imports). Adopting it would add a second persistence idiom |
| Any FSM library (XState, `@effect/...` machines) for candidate 2 | A connection has a handful of states; `Data.taggedEnum` + `Match` makes illegal transitions a compile error, which is this project's core value |
| Keyset/pagination helper packages (`drizzle-orm` helpers, `@mikro-orm`, Relay cursor libs) | The module is ~one predicate builder plus a comparator; the wire codec per dialect is project-specific |
| `SqlStream` / `Statement.stream` for paging | Those turn a driver cursor into a `Stream` for large result sets; keyset paging is stateless query-per-page, which is `Stream.paginate` |
| A DI/composition library for test hosts | `Layer` plus the cucumber `shared`/`perScenario` tiers is the composition mechanism |
| `ts-pattern`, `zod`, `io-ts`, `lodash` | `Match`, `Schema`, `Order`, `Array` already cover them; `oxlint` and `knip` would flag the duplication |
| Splitting `@awthaq/test` into several packages for candidate 4 | Splits by concern happen inside the package; new packages mean new `exports`, `tsconfig` refs, `workspace:sync`, changesets and `package:smoke` entries for no consumer benefit |
| Upgrading Effect, vitest, TypeScript or oxlint | Nothing here needs it. `@effect/tsgo` and `typescript` are an exact pair (MM-003) and must move together if ever bumped |

## Tooling constraints the plans must respect

| Gate | Constraint on this milestone |
|------|------------------------------|
| `oxlint` (`.oxlintrc.json`) | No `as` / `as unknown as` in `packages/*/src` (`as const` allowed). `effect/no-import-from-barrel-package`: import `effect/Stream`, `effect/Order`, never `from "effect"`. `effect/no-js-extension-imports`: relative imports use `.ts`. Custom `effect/no-opaque-instance-fields` and `no-bigint-literals` rules live in `tools/oxc/` |
| `knip` 6.44 | Orphaned files and unused exports fail the run after a move or delete. `ConfigList.ts`, old per-file cursor types and the old World helpers must be removed in the same change that drops their last importer |
| `pnpm circular` | Madge runs with and without `import type`; a type-only cycle fails. Watch the new keyset module (ports vs sql) and the `TestAuth` split |
| `pnpm check:transactions`, `check:error-tags`, `check:contract-tests` | Record-store scaffolding touches all three: transactional helpers, `Data.TaggedError` tag conventions, and the requirement that every records module is covered by a contract suite |
| `spec:verify:strict` | New or moved behaviours need `BEH-EA-*` / `ADR-EA-*` traceability; a deleted `ConfigList` and a new keyset module both change cited file paths |
| `pnpm test:pg` | Required for keyset, connection-lifecycle and record-store changes that alter SQL |

## Installation

```bash
# Nothing to install. No package.json, catalog, or lockfile changes are expected.
# If a plan believes it needs one, it is almost certainly re-implementing something above.
```

## Confidence

| Claim | Level | Basis |
|-------|-------|-------|
| Repo runs `effect@4.1.2`, not rc.116 | HIGH | `pnpm-workspace.yaml`, `pnpm-lock.yaml` importers, `readlink` of `packages/core/node_modules/effect` |
| `Stream.paginate`, `Order.*`, `Layer.mock/fresh/build`, `Schema.fromJsonString/StringFromBase64Url/DateTimeUtcFromMillis` exist with the stated shapes | HIGH | Read in `effect@4.1.2/src` |
| `@effect-cucumber/vitest` 0.10.1 shared/perScenario/Rule semantics | HIGH for what the README states; MEDIUM for runtime behaviour, which this research did not execute |
| `SqlModel.makeRepository` is a poor fit | HIGH | Signature read; project requirements compared against `SqlStore.ts` and `WebhookRecords.ts` |
| No cursor/FSM library is warranted | MEDIUM | Judgement from the size of the problem; no library survey was run, deliberately |

## Gaps

- Not executed: nothing was run (`pnpm test`, `circular`, `knip`). Counts in the review report remain unverified grep counts.
- Not checked: whether `@awthaq/ports` or `@awthaq/sql` is the better home for the table catalogue; depends on how `core` and `cli` currently import tables, which is a design question for the phase.
- Not checked: the research-plan / classify-confidence seams were not run; findings come from installed source and repo files, which outrank any cached or web digest.

## Sources

- `/Users/mohammadalmechkor/Projects/Perso/awthaq/node_modules/.pnpm/effect@4.1.2/node_modules/effect/src/` (`Stream.ts`, `Layer.ts`, `Order.ts`, `Schema.ts`, `DateTime.ts`, `sql/Statement.ts`, `sql/SqlModel.ts`, `sql/SqlStream.ts`)
- `/Users/mohammadalmechkor/Projects/Perso/awthaq/node_modules/.pnpm/@effect-cucumber+vitest@0.10.1_@effect+platform-node@4.1.2*/node_modules/@effect-cucumber/vitest/README.md`
- `/Users/mohammadalmechkor/Projects/Perso/awthaq/pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.oxlintrc.json`, `knip.json`, `scripts/circular.mjs`
- Repo code: `packages/sql/src/{UserStoreSql,SqlStore,TenantScoped,Models}.ts`, `packages/admin/src/ImpersonationRecords.ts`, `packages/organization/src/OrganizationRecords.ts`, `packages/core/src/AuditLog.ts`, `packages/cli/src/{Output,ConfigList,Plugin,Cli}.ts`, `packages/server/src/Credentials.ts`, `packages/test/src/{index,TestAuth}.ts`, `features/step-definitions/DomainWorld.ts`
