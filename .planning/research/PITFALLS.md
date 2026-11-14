# Pitfalls Research

**Domain:** Architecture-deepening refactors on a brownfield Effect v4 auth monorepo (awthaq), milestone v1.0 batch 3
**Researched:** 2026-11-14
**Confidence:** HIGH for file-grounded findings (each cites a file read in this session). MEDIUM where marked "inferred" (a hazard derived by reading code, not reproduced). Postgres-only hazards could not be reproduced here: `docker` is not available and `AWTHAQ_POSTGRES_URL` is unset, so `pnpm test:pg` cannot run locally. CI's `check.yml` has a `postgres:16` service and is the only place those hazards fail.

Candidate ids used below: C1 keyset page, C2 connection lifecycle, C3 test-host composer, C4 split `TestAuth.ts`, C5 CLI views / `Output.report`, C6 table catalogue, C7 record-store scaffolding, C8 credential registry fold. "Phase" in this document means "the phase that delivers that candidate". The suggested order is in the mapping table at the end.

---

## Critical Pitfalls

### Pitfall 1 (C1): Two page-assembly contracts exist, and a half-adopted module applies `limit + 1` twice or never

**What goes wrong:**
The eight "keyset sites" do not share one return contract:
- `UserStore.listPage` takes `limit`, reads `limit + 1` itself and returns `{ items, next }` (`packages/ports/src/UserStore.ts:147-156`, `packages/sql/src/UserStoreSql.ts:473-492`).
- `OrganizationRecords.listPage` returns a bare array of at most `limit` rows, and the caller adds the `+ 1` (`packages/organization/src/OrganizationRecords.ts:93-100`, `packages/admin/src/AdminTenants.ts:199-212`).
- `ImpersonationRecords.list` reads `limit + 1` inside the store and returns `{ items, nextCursor }` (`packages/admin/src/ImpersonationRecords.ts:458-466`, `:768-784`).
- `SessionStore.listLive` is not a page at all. It drains 200-row pages until `limit + 1` rows are seen and returns `{ items, truncated }` (`packages/sql/src/SessionStoreSql.ts:555-575`, `packages/ports/src/SessionStore.ts:404-410`).

Migrate one adopter to a module that owns `+ 1` while its caller still adds one, and a page silently returns two extra rows or a cursor that never ends. The reverse leaves `next` always `None`.

**Why it happens:**
The review report treats the sites as one recipe. The `limit + 1` responsibility sits at different layers.

**How to avoid:**
Decide once where `+ 1` lives (the store primitive, as `UserStore` and `ImpersonationRecords` do) and change `OrganizationRecords.listPage` and `AdminTenants.listOrganizations` in the same commit. Treat `listLive` as out of scope or give it its own thin adapter. Do not force `truncated` into `nextCursor`.

**Warning signs:**
`AdminTenants` still computing `limit + 1`. A page test passing with `limit: 1` but failing with an exactly-full final page (the exact-full-page case is already asserted for users: `packages/test/src/internal/storeContract/users.ts:505-530`).

**Phase to address:** C1.

---

### Pitfall 2 (C1): Memory comparator uses UTF-16 code units; Postgres sorts `id` by the database collation

**What goes wrong:**
Every memory twin compares ids with JS `<`/`>` (`ImpersonationRecords.ts:202-205`, `OrganizationRecords.ts:211-232`, `UserStore.ts:183-186`). Every SQL keyset orders by bare `id` with no collation, while the one adapter that needs byte order says so explicitly: `AuditLogStoreSql.ts:120-135` and `RelayCursorStoreSql.ts:47` use `COLLATE "C"` on Postgres. Under an `en_US.UTF-8` database, ids like `B1`, `a1`, `_x` order differently from memory. Cursors still page consistently inside Postgres, so no row is lost, but the "memory pins the reference order" guarantee is false for non-UUID ids.

The existing keyset contract cases use single lowercase letters (`"b","c","a","z"`, `storeContract/users.ts:505-530`), which cannot tell the two orders apart. The prior plan accepted the gap because "ids are lowercase UUIDv7" (`.planning/40-residue/PLAN.md` section 1.B.1). That holds for ids the library mints. It does not hold for `migrate-*` imports or a host's custom `Ids`.

**Why it happens:**
The two obvious fixes both have a cost. Adding `COLLATE "C"` to `ORDER BY id` stops a default-collation `(createdAt, id)` index from serving the sort (the sessions index `sessions_user_created_live` exists for exactly this: `SessionStoreSql.ts:195-200`). Not adding it leaves the drift.

**How to avoid:**
Make an explicit, recorded decision (ADR note or BEH-EA-036 amendment) in C1. Either (a) state that keyset ids are collation-stable by construction, enforced by a `Ids` brand or contract, and add a mixed-case/punctuated-id parity case that only runs under `AWTHAQ_POSTGRES_URL`; or (b) switch to `COLLATE "C"` and migrate the indexes. Do not decide this implicitly by copying whichever existing SQL fragment the module author read first.

**Warning signs:**
A shared parity case that only uses lowercase single letters. A `COLLATE "C"` appearing in the module without an accompanying index migration.

**Phase to address:** C1 (decision), verified by `pnpm test:pg` in CI.

---

### Pitfall 3 (C1): Choosing the expanded `OR` form kills the composite index the sessions listing was built around

**What goes wrong:**
`UserStoreSql.ts:185-191` and `ImpersonationRecords.ts:699` spell the cursor as `a > x OR (a = x AND id > y)`. `OrganizationRecords.ts:422-426` and `SessionStoreSql.ts:195-206` use the row-value form `(createdAt, id) > (x, y)`. The sessions comment says the row-value form is what lets the partial index serve filter and order with no sort node (PPS-002, migration 19). A module that standardises on the `OR` spelling "because the first reader used it" regresses the sessions path to a sort. Row values need both columns in the same direction. `ImpersonationRecords` is `DESC, DESC`, which is fine. A future mixed-direction order would not work.

**How to avoid:**
The module's SQL fragment emits the row-value form for every same-direction order and refuses (type error or defect) a mixed-direction order. Keep `TenantScoped.predicate(sql, "tenantId", seen)` composable via `sql.and` (the impersonation list already does this, `ImpersonationRecords.ts:688-702`). SQLite supports row values since 3.15; libSQL is covered by the same contract run.

**Warning signs:**
An `EXPLAIN` showing a sort node on `listLive`. The fragment builder taking a free-form comparator.

**Phase to address:** C1.

---

### Pitfall 4 (C1): The admin per-row gate runs after paging; pulling it into the module changes pagination semantics

**What goes wrong:**
`Admin.list` pages first, then filters through `gate.visibleEpisodes`, and documents that "a page can hold fewer than `limit` visible rows while `nextCursor` still points onward" (`packages/admin/src/Admin.ts:983-991`). A generic page assembler that accepts a filter callback and re-fills the page changes both the number of rows read and the cursor.

**How to avoid:**
The module assembles pages from rows the store already filtered in SQL. Post-filters stay in the caller. Keep the contract case that asserts a short page with a non-`None` cursor.

**Phase to address:** C1.

---

### Pitfall 5 (C1): Scope inflation to non-keyset listings is a wire-contract change

**What goes wrong:**
The review lists `MembershipRecords.ts:212` as a keyset site. It is offset pagination (`applyPage` with `offset`, `MembershipRecords.ts:206-216`). `ScimRecords.list` is offset too, and plan 32 uses RFC 7644 `startIndex`/`count`. Plan 24 records the offset use as a known contradiction of BEH-EA-036 (Q8) and deliberately did not fix it. `AuditLogStore.pageAfter` is an id-only cursor with `COLLATE "C"` and an optional `eventTag`. Converting any of these changes request/response shapes.

**How to avoid:**
C1 scope is exactly users, organizations, impersonations (the three wire cursors: `CursorSchema`, `UserCursorSchema`, `OrganizationCursorSchema`) plus `SessionStore.listLive` only if it falls out cheaply. Write the exclusions into the C1 requirements.

**Phase to address:** C1 (requirements stage).

---

### Pitfall 6 (C1): Wire cursor bytes and OpenAPI drift when the three Schema codecs are merged

**What goes wrong:**
The cursor is `base64url(JSON({ createdAt|startedAt, id }))` and clients may hold one mid-traversal (`AdminApi.ts:151-173`, `AdminTenantsApi.ts:48`). A merged codec with a different key order or field name makes in-flight cursors decode to a 400. Key order is part of the bytes.

**How to avoid:**
Pin byte equality against today's three schemas in the module's first test (plan 40 section 3.B already specifies this). Keep field names per listing (`startedAt` for impersonations, `createdAt` otherwise). Regenerate and diff the OpenAPI output.

**Phase to address:** C1.

---

### Pitfall 7 (C1): Placement forces the SQL half into the wrong package

**What goes wrong:**
`@awthaq/ports` cannot depend on `@awthaq/sql` (sql depends on ports; ADR-EA-041 alternative (a) was rejected because it makes a package cycle that `tsc -b` refuses). The memory twins for users and sessions live in ports, so the order and follows-predicate must live in ports. The SQL fragment needs statement types and already-available `effect/sql` (ports imports `effect/sql` in `SqlTransaction.ts`). Plan 40 section 3.B settled on `packages/ports/src/Keyset.ts` for this reason. Putting it in `sql` or `admin` strands the `ports` memory adapters.

`pnpm circular` will not catch a wrong-direction package edge. It scans files under `packages/*/src` and (as run here, with no tsconfig/alias config) does not resolve `@awthaq/*` workspace specifiers. Only `tsc -b` project references catch it.

**How to avoid:**
Put the module in `packages/ports/src/Keyset.ts`. Add `export * as Keyset from "./Keyset.ts"` to `packages/ports/src/index.ts` and update the `<!-- surface:ports -->` block in `spec/overview.md` in the same commit. Drift check 13 (`spec/scripts/check-drift.mjs`) compares the block with the `export * as` names and fails otherwise.

**Phase to address:** C1.

---

### Pitfall 8 (C1): Page-limit rule lives in the wrong places and is imported sideways

**What goes wrong:**
`pageLimit`/`DEFAULT_PAGE_SIZE` live in `ImpersonationRecords.ts:108-114`, `AdminTenants.ts` imports it from there, and `ImpersonationRecords.ts` imports `MAX_PAGE_SIZE` from the wire module `AdminApi.ts:160`. `Users.list` uses a separate `listLimit` in core. Moving the rule leaves the old exports in place. They stay reachable through the package `index.ts`, so knip does not flag them (see Pitfall 27).

**How to avoid:**
Delete the old exports as part of the move; grep for `pageLimit`, `DEFAULT_PAGE_SIZE`, `listLimit`, `MAX_PAGE_SIZE` consumers in `packages`, `features` and `examples`.

**Phase to address:** C1.

---

### Pitfall 9 (C2): The claim-then-row order and the row-then-claim delete order take locks in opposite directions (inferred)

**What goes wrong:**
`DomainClaims.withClaim` runs `claims.claim(input)` and then the connection write in one transaction (`packages/organization/src/DomainClaims.ts:204-222`): owner row, claim rows, then the connection row. `withRelease` runs the connection `remove` first and `claims.release` second (`:225-239`): connection row, then claim rows. `SamlRecords` itself was ordered row-first on purpose "so an update racing a removal cannot deadlock on Postgres" (`SamlRecords.ts:813-817`, plan 25 ticket 22, spec `29-saml-sp.md` BEH-EA-318 text). The wrapper above it inverts that order. An update that holds claim rows and wants the connection row, racing a delete that holds the connection row and wants the claim rows, is a classic Postgres deadlock. I did not reproduce it; it is rare because it needs an update and a delete of the same connection.

**How to avoid:**
The lifecycle module owns a single lock order for create, update and remove and states it. Add a Postgres `race` case (update vs remove, 8-way) to the `RecordsContract` suites, as `SamlRecords` already does for `update`/`remove`. A deadlock surfaces as a `StoreUnavailable`, so assert on outcome counts, not on absence of errors.

**Phase to address:** C2.

---

### Pitfall 10 (C2): The memory twin has no rollback, so "one transaction" refactors pass SQL and break memory

**What goes wrong:**
`SqlTransaction.layerNoop` is the memory bundle's transaction (`packages/ports/src/SqlTransaction.ts`, `layerNoop` documents "atomicity holds per Ref only", INV-EA-017). `withClaim` therefore carries a compensating `Effect.onError` that releases the claim (create) or re-claims `previous` (update) (`DomainClaims.ts:215-221`). Dropping it, because "it is in a transaction now", leaves orphaned claims in every memory composition (`TestAuth`, BDD). Calling `SqlTransaction.transactional(sql)` or `sql.withTransaction` inside the new module instead of taking the `SqlTransaction` service also adds `SqlClient` to the memory bundle's requirements and fails `pnpm check:transactions` (ADR-EA-037: only `ports/src/SqlTransaction.ts` may call `sql.withTransaction`).

**How to avoid:**
Take `SqlTransaction.SqlTransaction` as a service, as `withClaim` does. Keep the compensation, and cover it with a memory-mode test that injects a failure in the row write and asserts the domain is claimable again by another organization.

**Phase to address:** C2.

---

### Pitfall 11 (C2): Unifying the "active organization" gate changes SAML behaviour for suspended organizations

**What goes wrong:**
OIDC create calls `directory.findActive` (`OrganizationConnections.ts` `requireActiveOrganization`, comment: "worded as the SAML store words it"). SAML create calls `directory.find`, which does not exclude suspended organizations (`SamlConnections.ts:330-333`). The review reads these as duplicates. They are not equal. BEH-EA-237 scopes suspension to "organization-scoped operations of the organization plugin"; SAML is another plugin with its own admin gate (BEH-EA-347). Folding both into one gate silently starts refusing SAML connection creation for a suspended organization (or starts allowing OIDC).

**How to avoid:**
Choose the semantic explicitly in the C2 requirements, then change it with a failing test first, a BEH-EA-237/318 amendment and a changeset `Migration:` line if behaviour changes. If the answer is "keep both", the shared module takes the gate as a parameter.

**Phase to address:** C2.

---

### Pitfall 12 (C2): "Delete the two error-constructor wrappers" changes wire-visible tags

**What goes wrong:**
`SamlDomainTaken` and `ConnectionDomainTaken` are `Data.TaggedError`s that SAML admin and the organization API map (`SamlAdmin.ts:237,322,370`; `OrganizationConnections.ts:288-299,442`). Each protocol table also keeps its own unique constraint as defence in depth: `SamlRecords.claimDomains` translates a unique violation into `SamlDomainTaken` (`SamlRecords.ts:759-775`). Removing the wrappers without a mapping leaves the unique-violation path raising a different tag, and `SamlConnections.ts:488` has `catchTag("SamlDomainTaken", Effect.die)` that would stop matching.

**How to avoid:**
The module takes `onTaken` (as `withClaim` already does) and the protocol error classes stay. Check `pnpm check:error-tags` and the admin HTTP mapping tests.

**Phase to address:** C2.

---

### Pitfall 13 (C2): Forcing SCIM into the lifecycle shape is speculative

**What goes wrong:**
`ScimConnections.ts` has `create`, `list`, `revoke` (a token, no email domains, no delete, no `DomainClaims`). Its only shared lifecycle piece is the `OrganizationDeletion.contribute` hook (`Scim.ts:612`), the same hook SAML (`Saml.ts:723-745`) and OIDC (`OrganizationConnections.ts:626-642`) use with different bodies: SAML releases per connection, OIDC uses `removeAllForOrganization` plus `releaseAllForOrganization`. A single "lifecycle" abstraction that includes SCIM adds an option bag nobody calls.

**How to avoid:**
Include SCIM only if a real second caller needs shared behaviour (the deletion contribution). Preserve each protocol's deletion semantics, and cover with the organization-deletion cascade tests.

**Phase to address:** C2.

---

### Pitfall 14 (C2): Emitting events inside the transaction publishes state that can roll back

**What goes wrong:**
`OrganizationConnections` calls `map.invalidate` and `events.emit` after `withClaim`/`withRelease` returns (lines ~560-590). Moving them into the unit with `emit` before COMMIT delivers `OrganizationConnectionCreated` for a row that may roll back (ADR-EA-037). The unit of work gives `SqlTransaction.onCommit`/`afterUnit` for exactly this.

**How to avoid:**
Keep emit and cache invalidation outside the write unit, or use `onCommit`. Add a rollback-case test (a taken domain emits nothing).

**Phase to address:** C2.

---

### Pitfall 15 (C3): Some Worlds are hand-wired on purpose, and the composer must not absorb them

**What goes wrong:**
`TenancyWorld.ts:1-5` states: "Hand-wired on purpose: the identity stack (SQL `Users`/`Sessions` with no plugin) and the connection stack (the store alone) are not `Auth.make` compositions ... plan 08 exemption". `QadiBridgeWorld.ts:419-432` builds `CoreLive` from individual `Layer.provideMerge` calls to test the bridge beneath plugins. A composer that takes only a plugin list and returns `AuthHost` cannot express these. Migrating them forces a change in what is under test, usually by hiding the layer the scenario was meant to exercise.

**How to avoid:**
Classify the 25 Worlds first: plugin compositions (migrate), strata beneath plugins (leave, keep `TestAuth.buildContext`). Do not widen the composer to cover the latter. A composer must reuse `TestAuth.layer` (ADR-EA-044: "TestAuth.layer is AuthHost.layer over the test ports"), not copy the test ports. `shared/Harness.ts:19-36` already duplicates `TestHasher` as `cheapArgon2id`; a second copy is how drift starts.

**Phase to address:** C3.

---

### Pitfall 16 (C3): Leak guard, memo map and clock semantics are per-scenario behaviour the composer must preserve

**What goes wrong:**
`features/step-definitions/shared/LeakGuard.ts` fails a feature file when `TestAuth.openApps()` or `TestSql.openClients()` is above zero. A composer that builds apps by another path (not through `serve`/`withApp`) leaks past the guard or double-counts. `buildContext` uses its own memo map and the real clock; module-level `...Live` layers are memoised by reference, which is why `AuthHost.layer` wraps each middleware in `Layer.fresh` (`packages/server/src/AuthHost.ts:155-190`). A composer that caches a host across scenarios shares state. The compile-time World files (`CompileTimeGates.ts:268`) rely on exact types, which a widened generic composer erases.

**How to avoid:**
Route every app through the existing counters. Build per scenario. Keep a compile-time test that a missing plugin in the composer's input is still a type error (the project's core value). Run BDD under `AWTHAQ_POSTGRES_URL` in CI; `awaitStable` and `awaitCondition` (`Harness.ts:55-100`) only take real ticks there.

**Phase to address:** C3.

---

### Pitfall 17 (C4): The `TestAuth.*` namespace is the public surface; a split must keep every name reachable

**What goes wrong:**
`packages/test/src/index.ts` exports `export * as TestAuth from "./TestAuth.ts"`. Consumers use `TestAuth.withoutRequest` (681 uses), `layer` (356), `serve` (118), `runPluginContractTests` (58), `openApps` (24, used by `LeakGuard.ts`), `AppNeeds`, `TableCase`, `recordModes`, and about 25 more names. 21 test files import `"../src/TestAuth.ts"` directly and two import `"./TestAuth.ts"`. `docs/plugin-authoring.md` and `spec/behaviors/25-testing-harness.md` name `TestAuth.runPluginContractTests`, `TestAuth.runTenantIsolationTests` and `TestAuth.recordModes`.

**How to avoid:**
Keep `TestAuth.ts` as a facade of `export { ... } from "./internal/..."` (and `export type`), so no consumer or doc changes. Do not rename names. Check the full export list before and after with a script (`grep '^export'` diff). `layer` is an overloaded function: re-export it with `export { layer } from` rather than re-declaring.

**Warning signs:**
Any change to a file outside `packages/test` for a purely internal split.

**Phase to address:** C4.

---

### Pitfall 18 (C4): Module-level state, declaration emit and type-level cycles bite when a 1869-line file is split

**What goes wrong:**
- `let openAppCount` (`TestAuth.ts:626-627, 662, 760`) and `TestSql.openClients` are module-level counters read by `LeakGuard`. The increment and decrement must stay in the same module as `serve`/`openApps`.
- The file has comments like "Named so the foundations' inferred types can be emitted (declaration emit needs the namespace in scope)" (`TestAuth.ts:147-160`). Moving an exported const with an inferred Layer type to a file that does not import the types it mentions gives TS2742. `IMPLEMENTING.md` forbids return annotations on new Effect/Layer consts, so the fix is to export the named type aliases, not to annotate.
- `TestFramework.ts:3` exists "so the conformance suites and `TestAuth` can share it without importing each other". `SealedConformance` and `TenantConformance` are re-exported from `TestAuth.ts`. A new internal module that imports the facade is a type-level cycle that only `pnpm circular`'s second pass (type-inclusive) reports.
- `examples/plugin-template` is a test-exercised template and `pnpm check:contract-tests` asserts `@awthaq/test` is not imported from any `src` outside `packages/test`.

**How to avoid:**
Split along the existing dependency order (foundation, then composition, then app harness, then contract runner), and let internal modules import only downward. Run `tsc -b` (declaration emit) after each extraction, not at the end. `pnpm package:smoke` and `pnpm circular` after the last one.

**Phase to address:** C4.

---

### Pitfall 19 (C5): `Output.report` only honours the global `--json`, not `plugin list --format json`

**What goes wrong:**
`Plugin.show` chooses JSON on `options.format === "json" || out.json` and has a third format, `dot`, that applies only to the graph path; `--hooks`, `--rules` and `--events` ignore `dot` and print text (`packages/cli/src/Plugin.ts:255-288`). `Output.report` (`Output.ts:77-80`) reads only `out.json`. Replacing the three branches with `Output.report` silently stops `plugin list --hooks --format json` from printing JSON unless `--json` is also passed. `Inspection.test.ts:93-126, 237, 295` cover each, and `spec/behaviors/26-cli.md:61` states "`--format json|dot` MUST ...".

Also, `Output` states it "never receives a `Redacted`" and prints only already-redacted values (BEH-EA-201). A richer view module that is handed manifest objects (hook taps, rule descriptors) must not start carrying values a descriptor marks sensitive.

**How to avoid:**
The view takes the resolved format (flag or global) and returns lines or a document. Keep `dot` semantics exactly (graph only) unless a spec amendment says otherwise. Add a test for each of text, `--format json`, `--json`, `dot` for each of the four plugin modes before the refactor, then refactor.

**Phase to address:** C5.

---

### Pitfall 20 (C5): `ConfigList` is exported from the package index, imported by a test, and cited in the spec

**What goes wrong:**
`export * as ConfigList` is in `packages/cli/src/index.ts:12`, `Cli.ts:152` calls it, `Doctor.test.ts:24,237` imports it, and `spec/behaviors/26-cli.md:46,398` cite `ConfigList.ts` (also `packages/cli/test/Doctor.test.ts`). The CLI workspace has `ignoreExportsUsedInFile`; knip does not catch references in prose. Deleting the module without updating the spec leaves stale file references (BEH docs are not covered by drift check 10, which scans only `invariants.md` and `traceability.md`). Removing a package export needs a changeset.

**How to avoid:**
Inline `renderText` and `show` into `Cli.ts` or `Doctor.ts`; move the `Doctor.test.ts` case to the new location; update 26-cli.md and its Document Control revision; write a changeset noting the removed export (`Migration:` line).

**Phase to address:** C5.

---

### Pitfall 21 (C6): The "single table catalogue" is three lists with three different meanings, and moving it to `core` is a package cycle

**What goes wrong:**
- `TenantScope.partitionedTables` (4) and `directoryTables` (2) in `packages/sql/src/TenantScope.ts:45-53` drive `enableRls` coverage.
- `coreTables` in `packages/core/src/Auth.ts:779-782` is the same six, used only to accept a core table as a `Derived` parent (`Auth.ts:886`).
- `coreTables` in `packages/test/src/LaggingReplica.ts:31-38` is the same six again, meaning "tables the replica mirrors".
- `CoreMigrations` creates more tables than any list: `auth_relay_cursor` (`CoreMigrations.ts:607`) and `rate_limit_buckets` (`RateLimiterStoreSql.ts:49`, its own out-of-band DDL).

A catalogue that makes all of them "core tables" widens RLS coverage (an `enableRls` over a table with no `"tenantId"` column fails at DDL), widens which tables a plugin may declare `Derived` from, and changes what `LaggingReplica` mirrors. Placing the catalogue in `core` and having `sql` read it creates `sql -> core` (core already depends on sql: `packages/core/package.json:30`); `tsc -b` refuses the cycle. ADR-EA-041 alternative (a) rejected exactly that.

The premise "core stops importing `@awthaq/sql`" cannot be met by the catalogue alone. Core imports sql in `Errors.ts` (`StoreFailure`), `Migrations.ts` (`CoreMigrations`, `SqlDdl`), `Persistence.ts` (`CoreStoresSql`), `AuthPlugin.ts` and `Auth.ts` (`SealedColumn`, `TenantScoped`, `TenantScope`) and `internal/erasureClearance.ts`. This is intentional layering (ADR-EA-041 decision 3), not an accident.

**How to avoid:**
Home the catalogue in `@awthaq/sql` (next to `CoreSealedColumns` and `TenantScope`) or in `@awthaq/ports` if core and sql both must read it without sql. Give each entry explicit attributes (`tenancy`, `sealed`, `replicated`, `parentable`) so each current list is a projection, not a merge. Pin each projection with a test (`packages/sql/test/TenantScoped.test.ts:167-170` already asserts the coverage lists). State in the requirements that the `core -> sql` edge stays.

**Warning signs:**
`tsc -b` reporting a circular project reference; `enableRls` failing on a core table without a tenant column; `LaggingReplica` tests changing.

**Phase to address:** C6.

---

### Pitfall 22 (C6/C7): Sealed columns and tenancy declarations are checked by suites that key on the exact declaration shape

**What goes wrong:**
`CoreSealedColumns` AADs are `<table>:<rowKey>:<column>` and `adoptPlaintext` is per column (`CoreSealedColumns.ts:1-40`). `SealedColumn.Deployed` and `sweepDeployed` read these declarations. `ConnectionRecords.ts:9-12,146-160,194-230` keeps a legacy AAD (`organization-oauth-connection:`) and a memory-only test seam (`MemoryEnvelopes`) that `runSealedColumnTests` uses to read and plant what is "at rest". A catalogue or scaffold that regenerates declarations changes an AAD and makes every existing ciphertext unopenable (`sealedColumn.readable` defect), or drops the memory seam so the sealed suite no longer compiles. `TenantConformance` requires each declared table to have a case unless `Global` (`RecordsContract.ts:75-97`).

**How to avoid:**
Generate nothing: derive from the existing `SealedColumn.column(...)` values; add a test that compares the full serialised declaration list (table, column, key, AAD template, `adoptPlaintext`) before and after. Keep the memory envelope seam exported.

**Phase to address:** C6 and C7.

---

### Pitfall 23 (C7): The memory twin is the reference model; sharing its scaffold with SQL removes the oracle

**What goes wrong:**
Plan 24 rejected "delete the memory adapters" because "the memory adapters are, today, the only executable statement of the intended atomic semantics" and SQLite cannot reproduce Postgres races (`.planning/24-memory-records-over-sqlite/PLAN.md` section 1). A scaffold whose generic "memory table" is also the logic used by SQL helpers correlates their bugs. A generic memory table built from independent `Ref`s per table also loses single-step atomicity: multi-row primitives (membership + team `memberCount`, TeamRecords closure, invitation caps) are one `Ref.modify` over one state. A scaffold that gives each entity its own `Ref` forces two steps and breaks the `atomic`/`race` verdicts that `RecordsContract` requires (ADR-EA-041 decision 9).

Also, the shared part may be thin: the review itself says "bodies are domain-specific, so the shared part may be thin" and "Do candidate 1 first". Real shared units already exist (`SealedColumn`, `SqlModels`, `SqlStore`, `TenantScoped`).

**How to avoid:**
Extract only what is provably identical across files: tenant visibility filter plumbing, `unavailable(operation)` labelling, `pageLimit`/keyset (C1), dialect wire row helpers. Do not extract "memory table CRUD". Keep every `layerMemory` a single `Ref<State>` per store. Count candidates by grepping first, and abandon the abstraction if fewer than about five files share a helper after C1 and C6.

**Phase to address:** C7 (after C1 and C6, with a no-go gate).

---

### Pitfall 24 (C7): Lock keys and verdict maps are contracts, and the SQL twin labels are wire-visible

**What goes wrong:**
`SqlStore.atomically(sql, key)` keys are `<table>:<scope>:<id>` and are hashed into the advisory lock (`SqlStore.ts:65-76`). Two stores guarding one invariant must produce the same key text (`MembershipRecords.ts:678` uses `organization_membership:org:<id>`, `TeamRecords.ts:1014` uses `organization_team:org:<id>`). A scaffold that "normalises" key construction stops serialising them. `StoreUnavailable.operation` labels (`<Records>.<method>`) are wire-visible (ADR-EA-041 decision 7), and `Operations<Shape>` verdicts do not compile without one per method. Changing a store's shape to fit the scaffold breaks 16 contract suites at compile time.

**How to avoid:**
Do not change any `*Shape`. Keep key strings and labels byte-identical (pin them with a grep or test). Run the whole `RecordsContract` set after each file moves, not at the end.

**Phase to address:** C7.

---

### Pitfall 25 (C8): The credential registry is a cross-package contribution seam, not internal structure

**What goes wrong:**
`CredentialResolvers`, `contribute`, `CredentialResolversLive`, `presented`, `Source` and `fromRequest` are used by other packages: `api-key/src/ApiKey.ts:605-662`, `jwt/src/Jwt.ts:436-453`, `qadi/src/SubjectExtractor.ts:68`, `packages/test/src/TestAuth.ts`, `packages/web/src/Session.ts`. The registry is an ADR-EA-012 aggregating registry that freezes at first read, is a per-composition service, and is provided through `Layer.provide(Layer.succeed(Credentials.CredentialResolvers, registry))` (`ApiKey.ts:662`). "Move registry internal behind `make`" breaks plugin contribution at layer-build time, or changes its lifetime (per request instead of per composition). ADR-EA-042 (revision 1.2, 2026-11-10) lists this module as the single seam and the review says "Park unless it bites".

**How to avoid:**
Treat C8 as an internal file split only: keep every `Credentials.*` export reachable, same names, same service key `awthaq/server/CredentialResolvers`. If a cleaner end state needs a changed export, revise ADR-EA-042 explicitly (the project rule is not to contradict an ADR silently) and add a changeset with `Migration:` for `@awthaq/server`. Run `packages/server/test/Credentials.test.ts` (T1-T23 table) and `Authentication.test.ts` parity tests first.

**Phase to address:** C8 (last, with an explicit go/no-go).

---

## Moderate Pitfalls

### Pitfall 26 (cross-cutting): Cross-package tests run against built `lib/`, which is gitignored and goes stale

**What goes wrong:**
`packages/*/package.json` exports `"import": "./lib/index.js"` (and `"bun": "./src/index.ts"`), and the vitest configs set no alias (`packages/organization/vitest.config.ts`). A test in `admin` that imports `@awthaq/ports` or `@awthaq/sql` runs the built output. After editing `ports` or `sql` source, `npx vitest run packages/admin` can be green against stale code. `packages/*/lib` is ignored by git.

**Prevention:** Run `npx tsc -b tsconfig.json` (as `IMPLEMENTING.md` recommends) before every cross-package test run, not only before the typecheck gate. This matters most for C1, C2, C6 (edits in ports/sql/organization, consumers elsewhere).

**Phase:** all.

### Pitfall 27 (cross-cutting): The knip baseline is not clean in the way `IMPLEMENTING.md` says

`pnpm knip` currently fails with: Unused files (140) and Unlisted dependencies (3). The files are `.reports/*`, and now also untracked `.claude/**` (the GSD install). The three unlisted dependencies are real: `packages/sql/test/fixtures/readme-quickstart.ts` imports `@awthaq/core`, `@awthaq/password`, `@awthaq/server`, none of which `@awthaq/sql` lists. `IMPLEMENTING.md` says "treat knip as passing if every reported unused file is under `.reports/`", which is stale on both counts.

Also, knip reports unused exports only for modules not reachable from a package entry. Exports reachable through `export * as X` in a package `index.ts` are public API and are not flagged. So knip will not catch stale leftovers such as `pageLimit`, `isBeforeCursor`, an old `ConfigList` export, or duplicated helpers (MEDIUM: inferred from the current output showing zero unused exports despite 20+ hand-copied helpers; I did not run a deliberate experiment). Do the dead-export grep yourself.

**Prevention:** Record the baseline before C1 (the 3 unlisted deps and the file categories). Gate on "no new categories or entries outside `.reports/` and `.claude/`". Do not "fix" the sql fixture by adding `@awthaq/core` to sql (that is the cycle in Pitfall 21).

### Pitfall 28 (cross-cutting): `pnpm spec:verify:strict` has more checks than "traceability rows"

`spec/scripts/check-drift.mjs` fails on: a `packages/...`, `examples/...` or `features/...` path cited in backticks in `spec/invariants.md` or `spec/traceability.md` that no longer exists (check 10; deleted and renamed tests are the usual cause, for example `packages/organization/test/DomainClaims.test.ts`, `packages/saml/test/SamlDomainClaims.test.ts`, `packages/sql/test/UserStoreSql.test.ts`, `packages/server/test/Credentials.test.ts`, `packages/test/test/TestAuth*.test.ts` are all cited in `spec/traceability.md`); the ports inventory block in `spec/overview.md` versus `packages/ports/src/index.ts` (check 13); a Document Control `Revision` that does not equal the newest Change History version (check 14); duplicate ADR/INV/URS ids (16); `spec/README.md`'s `BEH-EA-001`-`357` range versus the highest defined id (17). The bash driver additionally rejects gaps in BEH ids ("catalog ended at BEH-EA-354 and strict verify rejects gaps", `.planning/README.md` Numbers), relative link and anchor breaks, and unmatched `@REQ-EA` manifest rows (check 4a, `features/traceability.md`).

**Prevention:** Per candidate, list every spec/traceability file it touches in the plan and bump `Revision` and `Change History` together in the same edit. Take the lowest free BEH/ADR/REQ number at landing time, not a reserved one. "Replace-don't-layer tests" means deleting test files, so grep `spec/traceability.md` for the path before deleting.

### Pitfall 29 (cross-cutting): Changesets use a `fixed` group; any package change bumps all 29

`.changeset/config.json` lists every package under one `fixed` group. CI's `changeset` job runs `changeset status --since=origin/<base>` on PRs (`check.yml`). A breaking change needs a `Migration:` line (`IMPLEMENTING.md`). Pre-1.0 convention: nothing is published, so removals are `minor`, not `major` (commit a4d75fa1). C5 (removed `ConfigList` export), C1 (module moves), C6, C8 each need one.

**Prevention:** One changeset per candidate in the commit that changes the export surface. Package manifests under `packages/*/package.json` appeared modified (private flag removed, `repository` added) while `scripts/package-smoke.mjs` was running in another process, then reverted. Do not stage manifests while a gate runs, and stage by explicit path (`.reports/`, `.claude/`, `.scratch/` are never staged).

### Pitfall 30 (cross-cutting): Coverage floors fail the repository gate after a deduplication

`vitest.config.ts` sets global thresholds (statements 89, branches 83, functions 84, lines 90) and per-package floors (core 93/83/92/94, jwt, password, server). Deleting duplicated, well-tested code and adding a module with defensive branches that no test reaches can drop a floor. `packages/test/src/TestSql.ts` is the only exclusion. `pnpm coverage` is in `pnpm check` and CI.

**Prevention:** Run `pnpm coverage` at the end of each phase. New modules are written test-first so branches exist only if a test reaches them (project TDD convention).

### Pitfall 31 (C1/C2/C7): Postgres-only behaviour has no local gate

`docker` is not installed and `AWTHAQ_POSTGRES_URL` is unset in this environment. Collation, advisory locks, deadlocks, `TIMESTAMPTZ` row-value comparison and RLS only run in CI (`check.yml` Postgres service) or in `pnpm test:pg`. `IMPLEMENTING.md` says to "say so if you cannot run it".

**Prevention:** Make each of C1, C2, C7 land as a branch/PR that CI exercises before the next depends on it. Record "not run locally" in each phase report.

### Pitfall 32 (C1): Cursor precision across dialects

SQLite stores `createdAt` as ISO text via `DateTimeUtcFromString` (millisecond `Z` format); Postgres uses `TIMESTAMPTZ` through `DateTimeUtcFromDate` (`Models.ts:134-136, 160-161, 181-200`). Rows are timestamped application-side (`DateTime.now`), so the cursor round-trips exactly. A row inserted with sub-millisecond precision (a hand-written import, a DB default) would compare unequal to its own truncated cursor and either repeat or be skipped at a page boundary. Low likelihood, silent when it happens. A contract case that inserts a microsecond timestamp under `test:pg` covers it.

---

## Minor Pitfalls

### Pitfall 33: Stale process doc
`.planning/IMPLEMENTING.md` names `/Users/.../effect-auth` and branch `architecture/deepening-plans`. The repository is `awthaq`, on `main`. Follow the conventions (no `as`, replace-don't-layer, gate list), not the paths.

### Pitfall 34: `RecordsBoundary` scans names, not intent
`packages/organization/test/RecordsBoundary.test.ts` fails any other package whose `src` imports a name matching `/\w*Records$/` from `@awthaq/organization`, or any import of `@awthaq/organization/records`. A new lifecycle module exported from the organization root must not end in `Records`. Saml already imports `DomainClaims` from the root without tripping it.

### Pitfall 35: `examples/plugin-template` and `docs/plugin-authoring.md` are tested documentation
The template runs in the root vitest projects and the docs name `layerMemory`/`layerSql` and `TestAuth.*` entry points. If C7 or C4 changes a recommended pattern, both must change in the same phase.

### Pitfall 36: Commit message convention
Every commit needs the boxed ASCII PROBLEM/SOLUTION/BEFORE-AFTER explanation and the `Co-Authored-By` footer (`IMPLEMENTING.md`). Forgetting is cheap to fix but easy to forget across 8 phases.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keep `TestAuth.ts` as a facade re-exporting internal modules | No consumer or doc changes across 100+ files | One extra indirection | Always (C4 default) |
| Standardise on the `OR` cursor form in the keyset module | Matches `UserStoreSql` and impersonation SQL | Loses the row-value index plan on sessions (PPS-002) | Never |
| Add `COLLATE "C"` to every keyset `ORDER BY id` | Matches memory's code-unit order | Needs index migrations; default-collation indexes stop serving the sort | Only with the index migration in the same phase |
| Delete the compensating `onError` in `withClaim` | Less code | Orphaned claims in every memory composition | Never |
| A generic memory "table" helper for 16 stores | Fewer lines | Loses single-`Ref.modify` atomicity and the independent reference model | Never for multi-row primitives; single-row CRUD only if more than ~5 files share it |
| Make the composer take any `Layer` | Covers hand-wired Worlds | Erases compile-time gates; hides the layer under test | Never |
| Leave stale `pageLimit`-style exports because knip is quiet | Smaller diff | Silent duplicates (namespace exports are not flagged) | Never |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `SqlTransaction` port | Calling `SqlTransaction.transactional(sql)` in code the memory bundle also builds | Take the `SqlTransaction` service; `layerNoop` supplies the memory behaviour |
| Unit of work (ADR-EA-037) | Emitting events inside the write | Emit after commit, or `SqlTransaction.onCommit` |
| `TenantScoped` / `CrossTenant` witness | A keyset fragment that bypasses `liftOn(sql, grant)` | Compose the fragment inside the existing `sql.and(conditions)` and keep `liftOn` on the outer effect |
| `SealedColumn` codec | Changing AAD or row key when moving a record store | Reuse the declared `SealedColumn.column` value; assert the declaration list is unchanged |
| `RecordsContract` | Changing a `*Shape` method set | Shapes are frozen; the verdict map does not compile otherwise |
| Package `lib/` | Testing a cross-package edit without rebuilding | `tsc -b` before `vitest` |
| Changesets | A single changeset for the whole milestone | One per candidate, with `Migration:` for surface changes |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `OR`-form cursor on a large sessions/user table | Sort node in `EXPLAIN`; slow `listLive` and admin user list | Row-value form for same-direction orders | Tens of thousands of rows per user/tenant |
| `COLLATE "C"` on `id` without a matching index | Seq scan + sort per page | Index migration in the same phase, or leave the collation alone | Large `users`/`organization_org` tables |
| Drain loop `listLive` forced into a keyset page API | Extra round trips or a changed `truncated` semantic | Leave `listLive`'s `PAGE = 200` drain alone | Users with many sessions |
| Claim DELETE/INSERT per update | Lock waits on `organization_domain_claim` | Keep it one statement set inside the transaction; one lock order | Concurrent connection edits (administrative rate; low) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Domain claim and connection row not atomic, or released before the row is removed | A domain routes SSO sign-ins to the wrong organization's IdP (the BEH-EA-317 takeover scenario) | Keep claim-first refusal, one transaction, tests for a taken domain rolling back the row, on memory and SQL |
| Active-org gate unification letting a suspended organization create a SAML connection (or blocking OIDC) | Suspension semantics diverge from BEH-EA-237 | Decide explicitly, test, amend the spec |
| Changing a sealed-column AAD in a scaffold or catalogue | Unopenable provider secrets and SP private keys | Compare declarations before and after; keep legacy AAD handling in `ConnectionRecords` |
| `enableRls` over a table lacking a tenant column or over `users`/`accounts` by default | Fail-closed or fail-open surprises (`directoryTables` are RLS-on-request only, DRS-005) | Keep catalogue attributes explicit; pin coverage lists with the existing `TenantScoped.test.ts` assertions |
| CLI view receiving manifest objects instead of rendered strings | A sensitive config value printed (BEH-EA-201) | Views take already-redacted data; keep the redaction tests in `Doctor.test.ts` |
| Credential registry made per-request or hidden | A plugin's claim silently stops resolving, falling through to session resolution | Keep `CredentialResolvers` per composition, contribution-time registration, frozen at first read |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| `plugin list --format json` printing text after the `Output.report` swap | A CI job scraping JSON gets prose | Pin all four formats per mode before refactoring |
| `awthaq config list` losing `<redacted>` rendering | Secret exposure in terminal output | Keep `EffectiveConfig.read` rendering upstream of `Output` |
| Wire cursor shape change | Clients mid-traversal get 400 | Byte-identical cursors; test against today's three schemas |
| Plugin-author docs showing a removed pattern | Template and docs drift from the code | Update `docs/plugin-authoring.md` and the template with the phase |

## "Looks Done But Isn't" Checklist

- [ ] **C1 module:** adopters removed their own `limit + 1`, comparator and limit clamp. Verify with a grep for `limit + 1`, `isBeforeCursor`, `pageLimit` in `packages/*/src`.
- [ ] **C1 parity:** a Postgres run (`pnpm test:pg` or CI) of a mixed-case/punctuated-id and a microsecond-timestamp keyset case.
- [ ] **C2:** a memory-mode failed-write test shows the claim is released; a Postgres update-vs-remove race case exists; the active-org semantic is stated per protocol.
- [ ] **C3:** every World is classified (migrated or "hand-wired on purpose" with reason); `LeakGuard` still passes; a missing plugin remains a compile error.
- [ ] **C4:** the exported name set of `TestAuth` is identical before and after; `tsc -b` declaration emit is clean; no file outside `packages/test` changed.
- [ ] **C5:** each plugin-list mode x (text, `--format json`, `--json`, `dot`) is asserted; spec 26-cli.md and its revision updated; changeset written for the removed export.
- [ ] **C6:** each of the three current lists (RLS coverage, derived-parent, lagging-replica) is a projection pinned by a test; no `sql -> core` edge (`tsc -b` green).
- [ ] **C7:** no `*Shape` changed; lock-key strings and operation labels unchanged; memory twins still single-`Ref` per store; `pnpm check:contract-tests` green.
- [ ] **C8:** every `Credentials.*` name used by api-key, jwt, qadi, web, test still resolves; ADR-EA-042 revised if the surface changed.
- [ ] **Gates:** `pnpm test`, `pnpm test:bdd`, `pnpm circular`, `pnpm spec:verify:strict`, `pnpm knip` (baseline-relative), `pnpm check:transactions`, `pnpm check:error-tags`, `pnpm check:readmes`, `pnpm package:smoke` (when exports change), `pnpm coverage`, CI Postgres job.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Double `limit + 1` found late (C1) | LOW | Fix the adopter, add the exact-full-page case to its contract suite |
| Collation drift found on Postgres (C1) | MEDIUM | Choose option (a) or (b) from Pitfall 2; if (b), ship the index migration as a new migration, never edit an applied one |
| Deadlock in claim/remove (C2) | MEDIUM | Reorder to row-first in `withClaim`/`withRelease`; add the race case; no data repair needed |
| Orphaned domain claims after a bad refactor (C2) | MEDIUM | `DELETE FROM organization_domain_claim` for connections that no longer exist; recompute `organization_domain_owner` (`dropOrphanOwners` logic) |
| Facade missing a `TestAuth` name (C4) | LOW | Re-export it; compare export lists |
| Wrong-direction package import (C6) | LOW | `tsc -b` shows it immediately; move the module down |
| Sealed AAD changed (C6/C7) | HIGH | Revert; ciphertexts written under the new AAD must be re-sealed (the `adoptPlaintext`/re-seal-on-read path covers only legacy plaintext and old keys) |
| Registry lifetime changed (C8) | MEDIUM | Revert to per-composition provision; plugins contribute again |

## Pitfall-to-Phase Mapping

Suggested ordering (dependencies read from the code, not from the review's ranking): C4 and C5 are independent and low-risk starters; C1 before C7; C6 before C7; C2 after C1 (shared page/limit helpers are untouched but both edit `organization`); C3 after C4 (the composer should target the settled `TestAuth` facade); C8 last with a go/no-go.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 `limit + 1` responsibility | C1 | Exact-full-page and short-page cases pass for all adopters on memory, SQLite, Postgres |
| 2 collation | C1 | Mixed-case id parity case under `test:pg`; recorded decision |
| 3 row-value vs `OR` | C1 | Fragment test emits row-value; `EXPLAIN` on sessions listing |
| 4 post-page gate | C1 | Case: short page with non-empty `nextCursor` remains |
| 5 scope inflation | C1 | Requirements list the three listings plus explicit exclusions |
| 6 cursor bytes / OpenAPI | C1 | Byte-equality test for three schemas; OpenAPI diff empty |
| 7 placement | C1 | `tsc -b` green; `check-drift` check 13 green |
| 8 limit rule imports | C1 | Grep finds no `pageLimit`/`MAX_PAGE_SIZE` from `AdminApi` in records |
| 9 lock order | C2 | Postgres `race` case update vs remove |
| 10 memory rollback | C2 | Memory failed-write test; `check:transactions` green |
| 11 active-org gate | C2 | Explicit test per protocol; BEH-EA-237/318 amended if changed |
| 12 error tags | C2 | `check:error-tags`; admin HTTP mapping tests |
| 13 SCIM scope | C2 | Requirements name the SCIM piece (deletion contribution only) or exclude it |
| 14 events in unit | C2 | Rolled-back claim emits no event |
| 15 hand-wired Worlds | C3 | Per-World classification table in the plan |
| 16 leak guard / memo map | C3 | `pnpm test:bdd` plus CI Postgres BDD |
| 17 facade names | C4 | Export-list diff empty; 103 consumers unchanged |
| 18 module state, emit, cycles | C4 | `tsc -b`, `pnpm circular`, `pnpm package:smoke` |
| 19 `--format` vs `--json` | C5 | Mode x format matrix test |
| 20 `ConfigList` removal | C5 | Spec revision bumped; changeset; `Doctor.test.ts` moved |
| 21 catalogue lists and cycle | C6 | Per-projection tests; no core import added to sql |
| 22 sealed/tenancy declarations | C6, C7 | Declaration-list snapshot; `runSealedColumnTests` |
| 23 reference model | C7 | Go/no-go on shared count; memory twins stay single-`Ref` |
| 24 lock keys / labels | C7 | Grep of key strings and labels identical |
| 25 registry seam | C8 | Plugins' `Credentials.contribute` calls compile unchanged |
| 26 stale `lib/` | all | `tsc -b` precedes every cross-package test run |
| 27 knip baseline | all | Baseline recorded before C1 |
| 28 spec drift | all | `pnpm spec:verify:strict`, cited paths grep |
| 29 changesets | all | `changeset status --since=main` |
| 30 coverage | all | `pnpm coverage` per phase |
| 31 no local Postgres | C1, C2, C7 | CI result recorded in the phase report |

## Sources

- Source files read this session (all under `/Users/mohammadalmechkor/Projects/Perso/awthaq`): `packages/admin/src/{ImpersonationRecords,AdminTenants,AdminApi,Admin}.ts`, `packages/organization/src/{OrganizationRecords,MembershipRecords,DomainClaims,OrganizationConnections,records}.ts`, `packages/organization/test/RecordsBoundary.test.ts`, `packages/ports/src/{UserStore,SessionStore,AuditLogStore,SqlTransaction}.ts`, `packages/sql/src/{UserStoreSql,SessionStoreSql,AuditLogStoreSql,TenantScope,CoreSealedColumns,SqlStore,Models}.ts`, `packages/saml/src/{SamlRecords,SamlConnections,Saml}.ts`, `packages/scim/src/ScimConnections.ts`, `packages/core/src/{Auth,Migrations,Users}.ts`, `packages/core/package.json`, `packages/test/src/{index,TestAuth,LaggingReplica,RecordsContract}.ts`, `packages/test/package.json`, `packages/cli/src/{Output,Plugin,ConfigList,index}.ts`, `packages/server/src/{Credentials,AuthHttp}.ts`, `features/step-definitions/{TenancyWorld,QadiBridgeWorld}.ts`, `features/step-definitions/shared/{Harness,FirstPartyComposition,LeakGuard}.ts`.
- Process and gates: `.planning/{PROJECT,IMPLEMENTING,README}.md`, `.planning/40-residue/PLAN.md` (sections 1.B, 3.B), `.planning/24-memory-records-over-sqlite/PLAN.md`, `package.json` scripts, `scripts/{circular,check-transactions,check-contract-tests,check-error-tags,package-smoke}.mjs`, `spec/scripts/{check-drift.mjs,verify-traceability.sh}`, `knip.json`, `vitest.config.ts`, `features/vitest.config.ts`, `.changeset/config.json`, `.github/workflows/check.yml`.
- Spec: `spec/decisions/041-domain-store-ports.md`, `042-credential-resolution-module.md`, `054-test-observation-off-the-ports.md`, `spec/behaviors/{05-persistence-stratum,25-testing-harness,26-cli,28-tenancy,29-saml-sp}.md`, `spec/traceability.md`, `spec/invariants.md`, `docs/plugin-authoring.md`.
- Executed here: `pnpm knip` (result in Pitfall 27) and `pnpm circular` (passes); `docker info` (unavailable). The architecture review report (`.../scratchpad/architecture-review-20261114.html`) was read for the candidate definitions; its counts are unverified grep counts and two of its claimed sites (Membership offset pagination, SessionStore drain) do not match the keyset recipe.

---
*Pitfalls research for: architecture-deepening refactors on awthaq (Effect v4 TypeScript auth monorepo)*
*Researched: 2026-11-14*
