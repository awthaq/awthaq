# Plan 24: Plugin record stores: one behaviour for memory and SQL (a parity contract by default; SQL over SQLite `:memory:` if the spike says go)

| Property | Value |
|---|---|
| Strength | **Speculative** (batch index). The candidate was "delete the ~3,800 lines of `Ref` adapters; the memory bundle becomes `records.sql` over SQLite `:memory:`". The evidence in §2 does not support that as the default. The drift that matters most is the SQL adapter being *weaker* than memory under Postgres concurrency, which SQLite cannot reproduce. So this plan's default (Track B) keeps the memory adapters and holds them to the SQL adapters with a differential parity contract, and fixes every drift found. Track A, the candidate's move, stays a spike-gated option with explicit go/no-go criteria |
| Dependency category | local-substitutable (each plugin records module's `layerMemory`/`layerSql` pair behind one `*Shape`) |
| Wave / order | After **plan 22** (which moves each table's DDL into the same records modules) and after plan 16 (which settles `StoreContract`'s shape for core). Independent of 11–15 and 17–21 apart from line shifts |
| Fixes live bugs | Four reachable memory/SQL drifts: `GET …/members?sortDirection=desc` returns ascending over SQL (**reproduced**), team listing order, OAuth- and SAML-connection `emailDomains` order. One conflict drift: a duplicate JWT `kid` silently overwrites the current key in memory but dies over SQL (`KeyRing.ts:241`). SQLite reports a primary-key clash as `ConstraintError`, so `orConflict` misses it there while Postgres maps it. Six wrong wire-visible `StoreUnavailable.operation` labels. Ten Postgres-only concurrency weaknesses where the SQL adapter is not atomic and the memory adapter is (§2.4) |
| New ADR | **ADR-EA-046** (reserved for this plan): "Plugin record stores keep a memory adapter held to the SQL adapter by a differential parity contract" (Track B), or its Track A counterpart if the spike says go. Both drafts are in §6.1 |
| Execution tickets | `.scratch/memory-records-over-sqlite/issues/NN-*.md`, one per phase |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Plan 22 lands first and adds a `migrations` group near the top of each records module, so re-check every line number before editing.

---

## 1. Summary, goals, non-goals

### Summary

Every plugin records module implements its `*Shape` twice: once as a `Ref` adapter and once over `SqlClient`. At `fc990c88` that is **24 modules with 3,462 lines of memory-adapter code** (§2.1). The pair is tested by a per-file `suite(name, layer)` that runs the same cases over both. Plan 05 added the tenant-isolation and sealed-column suites over both, and plan 08 added `records.memory`/`records.sql` bundles checked to provide the same stores (BEH-EA-334/336).

The pairs still drift. Reading every pair (§2.3, §2.4) found:

- **5 reachable behavioural drifts.** In one of them the SQL adapter ignores an API parameter outright.
- **10 places where the SQL adapter is not atomic** while its memory twin is. These are visible on Postgres only.
- **6 wrong operation labels**, and one dialect gap in `StoreFailure.orConflict`.
- Many harmless or unreachable differences.

The candidate proposal is the move plan 08 already made for `TestAuth`'s `"sql"` mode (verified: `TestAuth.ts:236-259` migrates core and the composition onto `TestSql.layer(suite)`, which is `SqliteClient.layer({ filename: ":memory:" })` unless `AWTHAQ_POSTGRES_URL` is set, `TestSql.ts:112-117`). Delete the `Ref` adapters, and let a "memory" composition be the SQL adapter over an in-process SQLite. That removes the ordering and representation drifts by deletion. But §2 shows three things against making it the default:

1. **It does not touch the drift that matters most.** All ten atomicity weaknesses are Postgres-only. `@effect/sql-sqlite-node` serialises every write behind a one-permit semaphore and `BEGIN IMMEDIATE` (`SqliteClient.ts:304-325` in rc.116), so a suite over SQLite can no more see a lost update or a cycle race than a suite over `Ref` can. The memory adapters are, today, the only executable statement of the intended atomic semantics. Deleting them deletes the reference model, and the bugs stay.
2. **It turns a SQL bug into "consistent" behaviour.** The membership `sortDirection` drift is a SQL adapter that ignores the parameter. With one adapter the parameter would simply never work, and nothing would notice.
3. **It forces a decision on core.** `TestAuth`'s memory mode pairs `Persistence.memory` with `SqlTransaction.layerNoop` (`TestAuth.ts:220-228`). Plugin SQL records under a no-op transaction lose the atomicity their `SqlTransaction.transactional` calls rely on, which is exactly the mis-wiring ADR-EA-041 decision 4 exists to prevent. So Track A is really "delete memory mode", core included (plan 02's `Ref` stores), and that reopens ADR-EA-041.

So this plan's **default is Track B**:

- Fix every drift found, choosing one canonical behaviour each.
- Add a **differential parity contract**: `TestAuth.runRecordsParity`, which drives random operation sequences through both adapters in lockstep and compares every result. A records interface with an unclassified method does not compile.
- Add **Postgres race cases** for the ten atomicity weaknesses, and fix them.

**Track A** stays on the table behind a Phase 0 spike with explicit, measurable go/no-go criteria (§4, Phase 0). Its phases are sketched (§4, Track A) so that a "go" is executable without a re-plan.

### Goals

1. Every drift in §2.3–§2.5 has one canonical behaviour, justified against a BEH/ADR id, and both adapters implement it. Each one is pinned by a test that ran red first.
2. **Parity is checked, not hoped for.** Every plugin records interface (24 shapes) is driven through both adapters by one generic differential harness. Adding a method without a parity classification is a compile error, the same technique as plan 05's tenant coverage map.
3. The SQL adapters are atomic wherever their memory twin is, and a Postgres race test pins each case (`pnpm test:pg`, CI).
4. The `StoreUnavailable.operation` label of every plugin SQL method names the method (ADR-EA-041 decision 7: labels are wire-visible). An outage test asserts the label.
5. ADR-EA-046 records the decision with the alternative ADR-EA-041 never weighed (SQL over SQLite as the memory adapter), with this plan's numbers.
6. Under a "go", Track A is executable from §4 without re-deriving anything.

### Non-goals

- **Core's store ports** (`@awthaq/ports` `Ref` adapters: `SessionStore`, `UserStore`, `AccountStore`, `VerificationStore`, `AuditLogStore`; 1,722 lines across `packages/ports/src/*Store.ts`). They already have what this plan builds for plugins: a data-driven contract with concurrency cases, run on `Ref`, SQLite `:memory:`, SQLite WAL and Postgres (ADR-EA-041 decision 6, `packages/test/src/StoreContract.ts:46-109`). They are the model, and they are out of scope for Track B. Under Track A they are forced into scope (G4 below), which is one reason Track A is not the default.
- Changing a records interface's shape beyond the canonical-behaviour fixes. Offset pagination on `MembershipRecords.listByOrganization` and `ScimRecords.list` contradicts BEH-EA-036 ("no repository interface MAY accept an offset", `spec/behaviors/05-persistence-stratum.md:89-100`). That predates this plan and is recorded as Q8, not fixed.
- RLS-only differences. A memory adapter cannot model Postgres row-level security. With `enableRls({ includeKeyed: true })`, SQL keyed reads are confined and memory reads are not. Plan 05's `runTenantIsolationTests` `rls` cases cover that on Postgres, and it is out of the parity contract by definition.
- The DDL. The Postgres passkey counter range (int4 against a uint32 `signCount`) is a memory/Postgres drift, but it is fixed by **plan 22** (its D2), because it is a column type.

---

## 2. Verified current state

### 2.1 Inventory: the 24 memory adapters

Spans are the memory section of each module: its `layerMemory`/`memoryStore` declaration plus memory-only helpers, state types and `MemoryEnvelopes` seams. Shared codecs and sort/page helpers are excluded. They were measured by reading each file at `fc990c88`.

| Package | Module | Memory span | Lines | SQL span | Lines | Pair suite (cases × layers) | pg (`test-pg.sh`) |
|---|---|---|---|---|---|---|---|
| organization | `OrganizationRecords.ts` | 124-261 | 138 | 263-475 | 213 | 10 × 2 | yes |
| | `MembershipRecords.ts` | 145-277 (+`applySort` 120-129) | 143 | 279-503 | 225 | 9 × 2 | yes |
| | `InvitationRecords.ts` | 141-310 | 170 | 312-588 | 277 | 9 × 2 | yes |
| | `TeamRecords.ts` | 240-656 | 417 | 658-1231 | 574 | 14 × 2 (+5 SQL-only) | yes |
| | `OrgRoleRecords.ts` | 90-191 | 102 | 193-363 | 171 | 6 × 2 | yes |
| | `ActiveContextRecords.ts` | 107-221 | 115 | 223-419 | 197 | 8 × 2 | yes |
| | `ConnectionRecords.ts` | 186-387 | 202 | 401-700 | 300 | 5 × 2 (+sealed) | yes |
| | `DomainClaims.ts` | 83-137 | 55 | 139-199 | 61 | 5 × 2 | yes |
| webhooks | `WebhookRecords.ts` | 307-819 | 513 | 823-1347 | 525 | 9 × 2 (+isolation, sealed) | yes |
| scim | `ScimRecords.ts` | 181-467 | 287 | 471-802 | 332 | 6 × 2 | yes |
| saml | `SamlRecords.ts` | 252-266 + 293-528 | 251 | 532-925 | 394 | 7 × 2 (+sealed) | yes |
| admin | `ImpersonationRecords.ts` | 192-204 + 325-482 | 171 | 484-794 | 311 | 12 × 2 (+8 SQL-only tamper) | yes |
| api-key | `ApiKeyRecords.ts` | 75-121 | 47 | 123-241 | 119 | 23 × 2 (`ApiKey.test.ts`) | yes |
| | `ApiKeyClientRecords.ts` | 67-114 | 48 | 116-232 | 117 | (same suite) | yes |
| device-authorization | `DeviceGrantRecords.ts` | 121-222 | 102 | 224-423 | 200 | 34 × 2 | yes |
| | `DeviceClientRecords.ts` | 53-86 | 34 | 88-171 | 84 | (same suite) | yes |
| jwt | `SigningKeyRecords.ts` | 158-293 | 136 | 295-483 | 189 | `KeyRing.test.ts` suite × 2 | yes |
| | `RevocationStore.ts` | 60-92 | 33 | 94-156 | 63 | 5 × 2 | yes |
| passkey | `ChallengeStore.ts` | 116-170 | 55 | 172-276 | 105 | suite × 3 (memory, SQL, cookie) | yes |
| | `PasskeyCredentials.ts` | 128-263 | 136 | 265-505 | 241 | 9 × 2 | yes |
| | `PasskeyUserHandles.ts` | 56-81 | 26 | 83-138 | 56 | 3 × 2 | yes |
| two-factor | `TwoFactorStore.ts` (two stores) | 131-333 | 203 | 335-591 | 257 | 7 × 2 (+SQL atomicity) | yes |
| roles | `RoleAssignments.ts` | 50-104 | 55 | 106-188 | 83 | **not a pair suite**: `RolesSql.test.ts` (SQL, 11) and `Roles.test.ts` (memory, 15, not in `test-pg.sh`) | partly |
| qadi | `UserClaims.ts` | 156-178 | 23 | 180-252 | 73 | 8 × 2 | yes |
| **total** | **24 modules** | | **3,462** | | **5,167** | | |
| (template) | `examples/plugin-template/src/Template.ts` | 104-134 | 31 | 136-202 | 67 | `recordModes` loop | yes |

Corrections to the candidate description:

- **Count:** 24 modules, not 22.
- **Size:** 3,462 lines, not ~3,800. Webhooks is 513, not ~525. Team is 417, not ~456. SCIM is 287, not ~306. The 8 organization stores total 1,342, not ~1,500.
- **The `listByUser` "tenant grant bug" (`MembershipRecords.ts:199`) is not a bug.** `organization_membership` is declared `keyed("organizationId")` (`Organization.ts:114`), so it has no ambient predicate to mirror. The SQL `listByUser` (`:437-442`) uses its `CrossTenant` grant only for `TenantScoped.liftOn`, which is a no-op outside an RLS transaction (`sql/src/TenantScoped.ts:117-144`). A memory adapter ignoring the grant is exact parity. The same holds for every `_grant` ignored by a memory adapter in organization, SCIM and SAML.
- **The `TeamRecords` "parent walk versus closure table" claim is an implementation difference, not a drift.** Memory's `ancestorsIn`/`descendantsIn` (`:287-317`) and SQL's closure queries (`:750-760`) return the same rows in the same order (nearest-first ancestors; descendants by depth, then `createdAt`, then `id`) for UUIDv7 ids. The cycle check gives the same errors in the same order (`:370-372` against `:977-983`). The real `TeamRecords` drifts are the listing order (T1) and two Postgres races (§2.4).
- **TRBS-005 does not say "memory compositions need no driver".** It is the label of ADR-EA-014's paragraph "Memory layers are single-process" (`spec/decisions/014-session-storage-backend-neutrality.md:40`, revision 1.1): per-process state, test-grade, a multi-instance deployment MUST use SQL. The driver-free property comes from ADR-EA-041 decision 3 (the `Ref` adapters live in `@awthaq/ports`, stratum 2) and from `packages/sql/README.md:28` ("no driver is a runtime dependency").
- **ADR-EA-041's Alternatives** (`spec/decisions/041-domain-store-ports.md`, "Alternatives considered") list (a) ports in core, (b) everything in `@awthaq/sql`, (c) the chosen placement, a shared helper module, and transactional memory (`TxRef`). **SQL over an in-process SQLite as the memory adapter was never weighed.** Confirmed.

### 2.2 Runtimes and drivers

- **Plugin packages have no driver dependency.** They take `SqlClient` abstractly. The drivers are `@effect/sql-sqlite-node`, `@effect/sql-pg` and `@effect/sql-libsql` (`pnpm-workspace.yaml:19-21`), as `dependencies` only of `@awthaq/cli`, `@awthaq/test` and `examples/sql-server`, and as `devDependencies` of `core`, `sql` and `migrate-better-auth`.
- **`@effect/sql-sqlite-node` runs on the built-in `node:sqlite`** (`SqliteClient.ts:2`, `:33`), with no native addon. Running it on Node 22.22.0 here printed `ExperimentalWarning: SQLite is an experimental feature`. Every package declares `engines.node >=22.12.0`. Whether `node:sqlite` needs a flag at exactly 22.12.0 is **not verified** (spike item G5).
- **Edge/browser:** nothing composes records there. The only edge entry is `@awthaq/next/edge` (`packages/next/src/edge.ts:16-25`, stateless JWT verification). `packages/{next,web,client,server}/src` never reference `records.memory` or `layerMemory`. `packages/sql/README.md:30-39` already documents edge-capable SQLite (libSQL, exercised by `sql/test/Repositories.libsql.test.ts`) and lists `@effect/sql-pglite` (in-process WASM Postgres) and `@effect/sql-sqlite-wasm`/`-do`/`-d1` (`../effect/packages/sql/` at 4.0.1). Whether rc.116 builds of the WASM drivers exist is spike item G5.
- **Production use of `records.memory`:** only `examples/memory-server/app.ts:106`, `:142`, `:150-151` (a Node example, plan 08 Q6). Everything else is tests: 77 test or step files reference a memory adapter or bundle, and `TestAuth.layer`'s default mode is memory (BEH-EA-193). Of the plugin test files, 16 use `records: "sql"`.

### 2.3 Reachable behavioural drifts (each pinned in Phase 0)

| # | Module · method | Memory | SQL | Repro | Reachable through | Tested today |
|---|---|---|---|---|---|---|
| R1 | `MembershipRecords.listByOrganization` | applies `sortDirection` (`:196` via `applySort` `:120-129`) | `ORDER BY "createdAt" ASC` hard-coded (`:341`), and `applyPage` without sort (`:433`) | **Reproduced** (scratch test, `fc990c88`): create a, then b 5 s later; `listByOrganization("o", { sortDirection: "desc" })` → memory `[b, a]`, SQL `[a, b]` | `GET /organizations/:id/members?sortDirection=desc` (`OrganizationApi.ts:143`, `OrganizationHandlers.ts:239-243`, `OrganizationMembers.ts:194`) | no (`MembershipRecords.test.ts:91` asserts only the default order) |
| R2 | `MembershipRecords.listByOrganization` ties | stable sort over HashMap order, and `desc` reverses ties (`:125-128`) | no tie-break column: SQLite rowid order, Postgres undefined | two members created in one millisecond | same endpoint, paging over ties | no (the test adjusts the clock to avoid ties, `:95`) |
| R3 | `TeamRecords.listTeamsByOrganization` | HashMap order (`:401-408`) | `ORDER BY "createdAt" ASC` (`:816`) | create T1, T2, T3 → SQL `[T1, T2, T3]`, memory hash order | `OrganizationTeams.ts:345` → `listTeams` handler (`OrganizationHandlers.ts:478`) | no (`TeamRecords.test.ts:57` asserts length only) |
| R4 | `ConnectionRecords` `emailDomains` | input order everywhere | reads `ORDER BY domain` (`:522`); `create`/`update` echo input order (`:593`), so SQL disagrees with itself | create with `["b.example", "a.example"]`; `findById` → memory `[b, a]`, SQL `[a, b]` | `OrganizationConnections.ts:409` (the connection view) | hidden (`ConnectionRecords.test.ts:126`, `:138` use `sameMembers`) |
| R5 | `SamlRecords` `emailDomains` | input order (`:363`, `applyPatch` `:278`) | `withDomains` reads `ORDER BY domain` (`:673`); `create` echoes input (`:799`) | create `["z.example", "a.example"]`; `findById` → memory `[z, a]`, SQL `[a, z]` | `SamlAdmin.ts:182` (admin API returns the array) | hidden (`SamlRecords.test.ts:95` sorts before comparing) |
| R6 | `SigningKeyRecords.create`, duplicate `kid` | `HashMap.set` overwrites, including the current key and its sealed private JWK (`:219-225`) | PK violation: without `rotated`, `orConflict` maps *any* unique violation to `CurrentKeyConflict` (`:443-451`); with `rotated`, `StoreUnavailable` | `registerRemoteKey({ kid: "k" })` twice (a host registering at every boot). Memory: ok. SQL: `CurrentKeyConflict` → `Effect.die` (`KeyRing.ts:236-241`). Or `importKey({ kid: <current kid> })`: memory replaces the current key | `KeyRing.registerRemoteKey` (`jwt/src/KeyRing.ts:216-245`), `importKey` (`:256-290`), host-supplied kid | no |

### 2.4 The SQL adapter is weaker than memory under concurrency (Postgres only)

In each row the memory adapter does the read-modify-write in one `Ref.modify`, and the SQL adapter does it in several statements without the lock or single statement that would make it atomic. On SQLite every writer is serialised (semaphore of 1 plus `BEGIN IMMEDIATE`), so only Postgres shows these. None of them is tested.

| # | Module · method | SQL (file:line) | Race | Effect |
|---|---|---|---|---|
| C1 | `TeamRecords.moveTeam` | `:962-1005` (check-then-write in a READ COMMITTED tx) | concurrent `move(A under B)` and `move(B under A)` | both commit, leaving a **cycle** in the closure table. Memory refuses the second |
| C2 | `TeamRecords.createTeam` vs `removeTeam` | `:927-947` vs `:1078` | create a child of P while P is removed | orphaned child |
| C3 | `TeamRecords.removeUserFromOrganizationTeams` / `removeUserFromAllTeams` | `:1165-1186` (list, then delete + decrement each, no check that the delete removed a row; `adjustMemberCount` has no floor `:916`) | concurrent `removeTeamMember` | `memberCount` decremented twice and can go negative. Memory floors at 0 (`:553`, `:582`, `:600`) |
| C4 | `OrganizationRecords.update` | `:372-402` (read, then write every column back) | two admins patch different fields | lost update |
| C5 | `ActiveContextRecords.writeOrganization`/`writeTeam` | `:315-357` (read, then INSERT or UPDATE, no upsert) | concurrent first writes for a new session | PK violation → `StoreUnavailable`; a `deleteAllByUser` in between hits `Option.getOrThrow` (`:333`, `:356`) → **defect** |
| C6 | `ConnectionRecords.update` | `:652` (`findStored`) then `write` = `INSERT … ON CONFLICT (id) DO UPDATE` (`:480`) | `update` racing `remove` | the removed connection **comes back** with its domains |
| C7 | `UserClaims.modify` (qadi) | `:232-248` (read, apply, upsert in a tx without `FOR UPDATE`) | `merge(u, {a:1})` ‖ `merge(u, {b:1})` | one key lost, both `claimsUpdated` events published |
| C8 | `WebhookRecords.setDisabled` / `updateEndpoint` | `:1226-1241`, `:1185-1209` (read, write back) | admin PATCH ‖ worker `bumpDead` | `consecutiveDead` rolled back |
| C9 | `WebhookRecords.deleteEndpoint` | `:1255-1262` (two DELETEs, no tx; caller `Webhooks.ts:698` opens none) | failure between them | orphan deliveries, never pruned |
| C10 | `SamlRecords.saveSession` / `update` / `remove` | `:899-903` (DELETE then INSERT), `:810-824`, `:877-882` | two saves of one `sessionId` | PK violation → `StoreUnavailable` on the SAML ACS path (`Saml.ts:1123`). `create`/`update` are wrapped by `DomainClaims.withClaim` (`SamlConnections.ts:220-232`); `saveSession` is not |

### 2.5 Other findings

- **`StoreFailure.orConflict` misses SQLite primary-key clashes.** Effect rc.116 classifies `SQLITE_CONSTRAINT_UNIQUE` as `UniqueViolation` but any other `SQLITE_CONSTRAINT*`, including `SQLITE_CONSTRAINT_PRIMARYKEY`, as `ConstraintError` (`effect/src/unstable/sql/SqlError.ts:525-537`). `orConflict` matches only `UniqueViolation` (`sql/src/StoreFailure.ts:80-91`). Postgres reports a primary-key clash as 23505, a `UniqueViolation`. So `ScimRecords.link` of an existing `(connection, kind, resourceId)` gives three outcomes: memory appends a duplicate row (`:289-294`, `:329`), Postgres gives `ScimLinkConflict { field: "name" }` (`:705`, `conflictField` `:639-648`), and SQLite gives `StoreUnavailable`. The organization schema already works around it ("`domain` is `UNIQUE`, not the primary key: SQLite reports a primary-key clash as a generic constraint error", `OrganizationMigrations.ts:392-394`). That is unreachable today, because callers link freshly created resources, but it is a dialect drift in the shared substrate.
- **Wrong operation labels** (SQL only, visible in the 503 body, `api/src/Api.ts:128-132`):
  - `ApiKeyClientRecords.ts:219` `"previousExpiresAt"` (insert)
  - `DeviceGrantRecords.ts:389` `"amr"` (insert)
  - `PasskeyCredentials.ts:431` `"name"` (create)
  - `PasskeyCredentials.ts:482` `"rename"` (delete)
  - `TeamRecords.ts:1178` `"rows"` (`removeUserFromOrganizationTeams`)
  - `ScimRecords.ts:685` `"row"` (`revokeConnection`)

  `device-authorization/test/StoreOutage.test.ts:24-50` is titled "naming the operation" but asserts only `_tag`. The same is true of `api-key/test/StoreOutage.test.ts:23`.
- **Unreachable or harmless** differences: duplicate caller-minted ids (memory overwrites or appends, SQL refuses), tie-break collation against `localeCompare` (equal for lowercase UUIDv7), unordered listings in both, `seq` gaps in Postgres `SERIAL`, aliasing of arrays and objects in memory, `claimDue` returning the pre-lease `nextAttemptAt` in memory (`WebhookRecords.ts:507-522` against `RETURNING *` `:1081-1084`; no caller reads it), `UserClaims` corrupt-row decoding, and `ChallengeStore.issue`'s sweep outside the upsert. The parity harness (§3.2) treats each by declaring the comparison (`unordered`, a projection) or by canonicalising, so they stop being silent.

### 2.6 Measured cost of the SQLite alternative (this machine, warm, `fc990c88`)

- **Records-suite case** (MembershipRecords: 20 `create` + 1 list), 200 iterations: memory **0.19 ms**, SQLite `:memory:` **1.94 ms**, of which migration alone (21 organization migrations) is 1.14 ms.
- **Full `TestAuth.layer` build** (`Auth.make([Organization])`, core plus organization migrations), 40 iterations: memory **2.90 ms**, SQLite **8.52 ms**.
- About **1,367** `it` calls in the twelve plugin packages' tests, and `pnpm test` is 42–70 s warm (plan 08 follow-up table). If every plugin case paid the composition delta, that adds about 7.7 s of CPU across the workers, roughly +5 to +15 % wall time. The spike measures the real figure.

---

## 3. Target design

### 3.1 Canonical behaviour per drift (Track B, Phase 1)

| # | Canonical behaviour | Justification | Change |
|---|---|---|---|
| R1, R2 | `listByOrganization` orders by `("createdAt", id)` in `sortDirection` (default `asc`), and pages after ordering | the API declares `sortDirection` (`OrganizationApi.ts:143`); BEH-EA-036's `(createdAt, id)` key | SQL: `ORDER BY "createdAt" <dir>, id <dir>` with `LIMIT`/`OFFSET` in SQL (drop the JS `applyPage` over the whole table). Memory: `applySort` adds the `id` tie-break |
| R3 | `listTeamsByOrganization` orders by `("createdAt", id)` ascending | matches SQL today; `listTeams` is user-visible | memory sorts; SQL adds `, id` |
| R4, R5 | `emailDomains` is returned sorted ascending everywhere (create, update, reads) | SQL reads already do it; input order cannot be preserved without a position column (Q2) | memory sorts on write; SQL `create`/`update` return the sorted set |
| R6 | a `create` whose `kid` exists fails `SigningKeyRecords.KidTaken` in both; the single-current violation stays `CurrentKeyConflict`, told apart by constraint name (`jwt_signing_key_single_current`, as SCIM's `conflictField` does) | a kid identifies a key forever (ADR-EA-017); overwriting the current key's private JWK silently is the worst outcome | memory checks the key; SQL `orConflict`'s `onUnique` inspects the constraint; `KeyRing.registerRemoteKey`/`importKey` surface `KidTaken` as a typed error instead of `Effect.die` (Q3) |
| §2.5 PK | `orConflict` treats a SQLite primary-key `ConstraintError` as a unique violation | Postgres already does (23505); dialect parity of the shared substrate | `StoreFailure.isUniqueViolation(error)`: `UniqueViolation`, or `ConstraintError` whose cause code is `SQLITE_CONSTRAINT_PRIMARYKEY` (`errcode` 1555); used by `orConflict` |
| SCIM link | linking an existing `(connection, kind, resourceId)` fails `ScimLinkConflict` in all adapters | follows from the row above | memory checks the full key; SQL already maps on Postgres |
| labels | each `StoreUnavailable.operation` names the records method | ADR-EA-041 decision 7 | six one-word fixes; both `StoreOutage` tests assert the label |
| W-1 | `claimDue` returns the leased row (`nextAttemptAt = leasedUntil`) in both | SQL `RETURNING *` | memory returns the updated rows |

### 3.2 The differential parity contract (`@awthaq/test`, Phase 2)

`TestAuth.runRecordsParity` is the plugin-records counterpart of core's `StoreContract`. Where `StoreContract` states each port's cases as data, this harness needs no hand-written cases. Each module declares how to *call* every method and how to *compare* results, and the harness generates operation sequences and runs them on both adapters in lockstep.

```ts
// packages/test/src/RecordsParity.ts
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { TestFramework } from "./TestFramework.ts";

/** What an earlier step produced, so a later step can refer to it (an id it created, a user it linked). */
export interface History {
  readonly values: ReadonlyArray<unknown>;
}

/** How two results of one method compare. */
export type Comparison<A> =
  | "exact"
  /** A listing whose order the interface does not promise: compared as a multiset. */
  | "unordered"
  /** A projection both sides are compared through (drop a `seq`, a hash-order field). */
  | { readonly through: (value: A) => unknown };

type Method = (...args: never) => Effect.Effect<unknown, unknown>;
type ArgsOf<F> = F extends (...args: infer P) => unknown ? P : never;
type SuccessOf<F> = F extends (...args: never) => Effect.Effect<infer A, unknown> ? A : never;

export type Operation<F> =
  | {
      /** Arguments for one call, drawn against what the sequence has produced so far. */
      readonly args: (history: History) => Arbitrary.Arbitrary<ArgsOf<F>>;
      readonly compare: Comparison<SuccessOf<F>>;
    }
  /** Not driven by the harness: the reason is printed in the report and reviewed. */
  | { readonly skip: string };

/** Every method of the shape, classified: a new method without an entry does not compile (plan 05's coverage-map technique). */
export type Operations<S> = { readonly [K in keyof S]: S[K] extends Method ? Operation<S[K]> : never };

export interface ParityOptions<I, S> {
  readonly name: string;
  readonly tag: Context.Key<I, S>;
  /** Built fresh per sequence. Both get the same seeded `Crypto` and `TestClock`, so minted ids and timestamps coincide. */
  readonly memory: Layer.Layer<I, unknown>;
  /** Over a freshly migrated database (`TestSql.layer` + the plugin's `Migrations.run`): SQLite, or Postgres under `test:pg`. */
  readonly sql: Layer.Layer<I, unknown>;
  readonly operations: Operations<S>;
  /** Also interleaved: `TestClock.adjust` by a drawn duration, so expiry and ordering by time are exercised. */
  readonly advanceClock?: boolean;
  /** Default 50 sequences of up to 25 steps; a fixed seed in CI (`AWTHAQ_PARITY_SEED`), random locally and printed. */
  readonly runs?: number;
  readonly steps?: number;
}

export const run = <I, S>(framework: TestFramework, options: ParityOptions<I, S>) => {
  /* For each sequence: build both layers; for each step pick a method (weighted towards writes early),
     draw its args from the shared History, run it on both, and compare:
       - both succeed → compare the values with the method's Comparison;
       - both fail → compare the failures' `_tag` (and `operation` for StoreUnavailable);
       - one succeeds, one fails → a parity failure.
     A failure reports the shrunk sequence as runnable TypeScript, so the fix starts from a repro. */
};
```

Notes for the executor:

- **Determinism.** Both adapters must mint the same ids. Add `TestCrypto.seeded(seed)` to `@awthaq/test`: `Crypto.make({ randomBytes, digest })` over a seeded PRNG, with `digest` from `NodeCrypto` (`effect/Crypto.ts:230-237` takes exactly these two). Provide it to both layers. Timestamps come from one `TestClock` per adapter, adjusted identically.
- **No `as`.** `Operations<S>` is a mapped type, and `args` returns a typed `Arbitrary`. The harness calls `(service[key])(...args)` through a guard that narrows `S[K]` to `Method` (`typeof value === "function"`). If `tsgo` cannot apply a tuple of `ArgsOf` to the narrowed method, the harness stores each operation as a closure: `call: (service: S, history) => Arbitrary<Effect<…>>`. That is a generic argument, not an assertion. The executor picks the form that compiles.
- **Shrinking.** Use `effect/unstable/arbitrary` (already used by `organization/test/PermissionEngine.property.test.ts:25-34`, with `@effect/vitest`'s `it.prop`). If the effectful lockstep does not fit `it.prop`, generate the sequence with `Arbitrary` inside one `it.effect`, and implement shrinking as "drop steps from the end, then from the front" until the failure disappears. That is enough for a repro.
- **Canonical comparisons are declarations.** For example, `MembershipRecords.listByOrganization` is `"exact"` after R1, and `listByUser` is `"unordered"` (no order promised, `:347`). The harness does not let a test hide order with `sameMembers` without the module *declaring* the method unordered.
- **Where it runs.** Each records module's existing test file calls `TestAuth.runRecordsParity(vitestFramework, { … })` beside its `suite(…)` calls. It runs on SQLite in `pnpm test` and on Postgres under `test:pg` (where `sql` is built over `TestSql.layer`).

### 3.3 Postgres race cases and fixes (Phase 4)

`runRecordsParity` cannot see races. Each §2.4 row gets a pg-only case in the module's test file using `StoreContract`'s `race` helper (`packages/test/src/StoreContract.ts:46-62`, `CONCURRENCY = 8`). The case asserts the canonical outcome (no cycle, `memberCount` never negative, both patched fields kept, …), and the same case runs over memory and SQLite as a smoke test. The fixes:

| # | Fix |
|---|---|
| C1, C2 | `moveTeam`/`createTeam`/`removeTeam` take a per-organization advisory lock in their transaction on Postgres (`pg_advisory_xact_lock(hashtext('awthaq.team:' \|\| organizationId))`, the same pattern as `ImpersonationRecords`' `CHAIN_LOCK_KEY` `:536`), so check-then-write is serialised per organization; SQLite is already serialised |
| C3 | `DELETE … RETURNING "teamId"` and decrement only the returned teams; `adjustMemberCount` floors at 0 (`GREATEST("memberCount" - 1, 0)` on pg, `MAX(…)` on SQLite) |
| C4 | one `UPDATE … SET col = COALESCE(${patch.col}, col)` per patched column, `RETURNING *`; no read-before-write |
| C5 | `INSERT … ON CONFLICT ("sessionId") DO UPDATE SET …` (both dialects support it); no `getOrThrow` |
| C6 | `update` is `UPDATE … WHERE id = … RETURNING *`; `None` is `ConnectionNotFound`; domains replaced in the same transaction |
| C7 | `SELECT … FOR UPDATE` inside the transaction on Postgres (`only` pg; SQLite's `BEGIN IMMEDIATE` already serialises) |
| C8 | single-statement `UPDATE`s for the fields each operation changes |
| C9 | both DELETEs in one `SqlTransaction.transactional(sql)` |
| C10 | `saveSession` is `INSERT … ON CONFLICT ("sessionId") DO UPDATE`; `update`/`remove` in one transaction |

### 3.4 Track A sketch (only if the spike says go)

```ts
// AuthPlugin.Service options: `records` becomes one SQL layer, no memory twin.
records: ImpersonationRecords.layerSql,

// TestAuth: one record mode; "memory" means an in-process database, chosen by the host/test.
export const recordModes = ["sqlite"] as const;   // + Postgres under AWTHAQ_POSTGRES_URL, as today
```

- `AuthPlugin`'s `RecordsLegal`/`RecordsComplete` pairing (plan 08, BEH-EA-334/336) collapses to "`records` provides every `/records/` store the layer requires".
- `TestAuth.layer` without `records` builds the SQL base over `TestSql.layer(<auto suite name>)`. `Persistence.memory` leaves `TestAuth` (G4), and `SqlTransaction.layerSql` is always matched.
- The 24 memory sections are deleted, along with the `MemoryEnvelopes` seams (`WebhookRecords`, `SamlRecords`, `TwoFactorStore`, `ConnectionRecords`). Their BDD and sealed-suite users plant through SQL (`runSealedColumnTests` already takes a SQL `plant`).
- `examples/memory-server` composes `SqliteClient.layer({ filename: ":memory:" })` (Q6). The plugin packages stay driver-free: the host provides the client, as `packages/sql/README.md:28` promises.
- The parity harness is not needed. Phase 1's canonical fixes and Phase 4's race fixes are needed **either way**, because they are SQL adapter bugs.

---

## 4. Phased migration

Phase gate: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`, plus `pnpm test:pg` from Phase 1 on (SQL adapters change). Plan gate: `pnpm check && pnpm test:pg`. Preconditions: plan 22 is merged (DDL is in the records modules), and §2.1's spans are re-measured.

### Phase 0: pin the drifts, run the spike, decide

1. **Failing tests**, each in the module's existing pair suite so it runs on both layers. The name cites the canonical behaviour:
   - `MembershipRecords.test.ts`: "R1: listByOrganization honours sortDirection desc (createdAt, id)". Use the scratch repro of §2.3: it fails on SQL.
   - "R2: equal createdAt orders by id in both directions". Use `TestClock` frozen, three creates.
   - `TeamRecords.test.ts`: "R3: listTeamsByOrganization orders by (createdAt, id)". Fails on memory.
   - `ConnectionRecords.test.ts` and `SamlRecords.test.ts`: "R4/R5: emailDomains is sorted on create, update and every read". Replace the `sameMembers` (`ConnectionRecords.test.ts:126`, `:138`) and the `.sort()` (`SamlRecords.test.ts:95`) with exact assertions. Fails on both.
   - `KeyRing.test.ts` suite: "R6: create with an existing kid fails KidTaken and keeps the existing key". Fails on both, with a different failure each.
   - `sql/test/StoreFailure.test.ts`: "orConflict maps a SQLite primary-key clash like Postgres does". Fails on SQLite.
   - `StoreOutage.test.ts` (api-key, device-authorization) plus new outage cases for passkey, team and SCIM: assert `operation` for the six labels. Fails.
2. **The spike** runs on a throwaway branch and is **never merged**. Results go to `.scratch/memory-records-over-sqlite/issues/00-spike.md`:
   - **S1:** make `TestAuth.layer`'s memory mode use `sqlBase` (`TestAuth.ts:236-259`) with an auto suite name, so every memory-mode suite runs on SQLite `:memory:`. Run `pnpm test` three times warm and take the median against `main`. Record the suites that fail, and why: real SQL bugs, or tests that relied on memory-only behaviour.
   - **S2:** for every row of §2.3–§2.4, record whether Track A removes it, Track B's harness or race test catches it, or neither does.
   - **S3:** run the suite on Node **22.12.0** exactly (the engines floor) and on the current LTS. Does `node:sqlite` load without a flag?
   - **S4:** check whether `@effect/sql-pglite` and `@effect/sql-sqlite-wasm` exist at `4.0.0-rc.116` (`pnpm view`). If yes, run `MembershipRecords.test.ts`'s SQL suite over pglite once. That would be an in-process **Postgres** as the "memory" adapter, and it could also surface C-class bugs.
   - **S5:** list every composition outside tests that uses `records.memory` or `Persistence.memory` (expected: `examples/memory-server` only), and every documented promise of a driver-free composition (`docs/`, READMEs, BEH-EA-193).
3. **Go/no-go for Track A.** Go only if **all** of these hold. Otherwise Track B, which is the expected outcome given §2:
   - **G1:** S1's median `pnpm test` wall time is within **+20 %** of `main`, and `pnpm test:bdd` within +20 %.
   - **G2:** every S1 failure is either a real SQL bug (fixed in Phase 1 or 4 anyway) or a test asserting memory-only behaviour that has no spec basis.
   - **G3:** S2 shows Track A catches **at least** what Track B catches for the R-class and C-class rows, which means S4's pglite works. Without pglite, Track A cannot see C1–C10, and G3 fails by construction.
   - **G4:** the user approves taking core's `Persistence.memory` out of `TestAuth` too (Q5), since a mixed memory-core/SQLite-plugins composition is the mis-wiring ADR-EA-041 decision 4 forbids.
   - **G5:** S3 passes on the engines floor, or the floor is raised (a separate decision).
4. Write ADR-EA-046 with the decision and the spike's numbers (§6.1).

Gate: phase gate, with the red tests marked `it.fails` (never skipped) until Phase 1.

### Phase 1: canonical fixes (both tracks)

1. `MembershipRecords.ts`: R1/R2 (SQL `ORDER BY` + `LIMIT`/`OFFSET`; memory `applySort` with the `id` tie-break, `:120-129`).
2. `TeamRecords.ts`: R3 (memory sort `:401-408`; SQL `, id` at `:816`). Label `:1178`.
3. `ConnectionRecords.ts`, `SamlRecords.ts`: R4/R5 (memory sorts on write; SQL `create`/`update` return sorted).
4. `SigningKeyRecords.ts` + `KeyRing.ts`: R6 (`KidTaken`; constraint-name discrimination; `KeyRing.ts:241`'s `Effect.die` becomes a typed error on `registerRemoteKey`/`importKey`; `jwt` API error if the admin endpoint exposes import; check `JwtApi`).
5. `packages/sql/src/StoreFailure.ts`: `isUniqueViolation` covering SQLite primary-key `ConstraintError`; `orConflict` uses it. Then `ScimRecords.link`'s memory check of the full key.
6. The six labels (§2.5). `WebhookRecords` memory `claimDue` returns leased rows (W-1).
7. Remove `it.fails` from every Phase 0 test.
8. Changeset `.changeset/records-canonical-behaviour.md` (§6.4).

### Phase 2: the parity harness (Track B)

1. `packages/test/src/RecordsParity.ts` (§3.2), `packages/test/src/TestCrypto.ts` (`seeded`). Export them from `packages/test/src/index.ts` as `TestAuth.runRecordsParity` (on the `TestAuth` namespace, like `runTenantIsolationTests`) and `TestCrypto`.
2. `packages/test/test/RecordsParity.test.ts`: the harness against a toy records shape with two deliberately drifting adapters. One drift in order, one in conflict, one where one side succeeds and the other fails. Assert that each is found, shrunk and reported as a sequence, and that a matched pair passes. Add a type test: an `Operations` missing a method does not compile (`// @ts-expect-error`).
3. Changeset `.changeset/records-parity-harness.md` (`@awthaq/test` minor).

### Phase 3: adopt the harness, package by package (Track B)

One ticket per package, in this order (largest drift surface first):

1. organization (8 modules)
2. webhooks
3. SAML
4. SCIM
5. admin
6. passkey (3)
7. device-authorization (2)
8. api-key (2)
9. jwt (2)
10. two-factor
11. qadi
12. roles
13. the template

For each:

1. Add `runRecordsParity` to the module's test file, with an `Operations` classifying every method (`compare` or `skip` with a reason). The reviewer checks every `skip` and every `"unordered"` against the interface's doc comment. An undocumented order is a doc fix in the same commit.
2. Fix any parity failure the harness finds the same way Phase 1 did: canonical behaviour, test, fix. Record each new finding in the package ticket and in §2's table at the end ("Decisions taken").
3. **Roles**: `RoleAssignments` has no pair suite (§2.1). Merge `Roles.test.ts`' store cases and `RolesSql.test.ts` into one `suite(name, layer)` over both adapters. That is replace, don't layer: the memory-only and SQL-only copies of the same cases are deleted. Add `Roles.test.ts`'s pair to `scripts/test-pg.sh`.
4. **Replace, don't layer:** delete any existing case that only compared the two adapters' outputs for one fixed input. The harness subsumes it. Keep every case that asserts a behaviour against an expected value.

### Phase 4: Postgres atomicity (both tracks)

One commit per module for C1–C10 (§3.3). Each pg race case is written first, and red on `test:pg`. Then the fix. Gate: `pnpm test:pg` (in CI if Docker is unavailable locally; the PR does not merge until CI's `test:pg` is green).

### Phase 5: spec, docs, template

1. `docs/plugin-authoring.md` "Record stores and bundles" (`:193-211`) and "Testing a plugin" (`:213-232`): a records module ships both adapters and calls `TestAuth.runRecordsParity`; every listing method documents its order; a read-modify-write is one statement or a locked transaction in SQL. Checklist (`:240-251`) gains the parity item.
2. `examples/plugin-template/test/Template.test.ts`: `runRecordsParity` over `NoteRecords`.
3. Spec, ADR, traceability: §6.

### Track A (replaces Phases 2, 3 and 5's harness items, only on "go")

- **A1:** `TestAuth` single record mode (§3.4). `recordModes` becomes `["sqlite"]`. BEH-EA-193/332 are rewritten. `Persistence.memory` leaves `TestAuth`, which needs plan 02's owner and Q5.
- **A2:** `AuthPlugin.Service`'s `records` option becomes one layer. Rework `RecordsLegal`/`RecordsComplete` (`core/src/AuthPlugin.ts`). `runPluginContractTests`' matched-pair check (BEH-EA-336) becomes "records builds over a migrated SQLite".
- **A3:** delete the 24 memory sections and the 4 `MemoryEnvelopes` seams, package by package, in Phase 3's order. Move BDD steps that read envelopes to SQL reads.
- **A4:** `examples/memory-server` runs on `SqliteClient` `:memory:` (Q6). Update its README and `docs/` mentions of driver-free memory compositions.

Each step is gated by the phase gate. A1 and A2 are breaking for third-party plugins (changeset `Migration:` lines).

---

## 5. Test plan

| Test | Where | Adapters | Proves |
|---|---|---|---|
| R1–R6, SCIM link, PK-on-SQLite, labels (Phase 0, red first) | the module's pair suite; `sql/test/StoreFailure.test.ts`; `StoreOutage.test.ts` | memory, SQLite, pg | §3.1 |
| Harness self-test: finds an order drift, a conflict drift, a success/failure split; shrinks; passes a matched pair; incomplete `Operations` does not compile | `packages/test/test/RecordsParity.test.ts` | toy adapters | §3.2 |
| `runRecordsParity` per records module (24 + template) | each module's test file | memory vs SQLite (vs pg under `test:pg`) | goal 2 |
| C1–C10 race cases | each module's test file, pg-only block (+ memory/SQLite smoke) | pg | goal 3 |
| Track A only: the S1 suite run over SQLite | spike branch, not merged | SQLite | G1/G2 |

**Replace, don't layer.**

- **Deleted:** the memory-only `Roles.test.ts` store cases and the SQL-only `RolesSql.test.ts` duplicates. Both are merged into one pair suite.
- **Deleted:** any fixed-input "both adapters return the same" cases that the harness subsumes (listed per package in its ticket).
- **Strengthened:** `sameMembers`/`.sort()` assertions that hid R4/R5, which become exact.
- **Kept:** the SQL-only tamper suite (`ImpersonationRecords.test.ts:339-575`), `TeamRecords`' SQL atomicity tests (`:310-368`), and plan 05's isolation and sealed suites. They test what the harness cannot (raw-row tampering, triggers, RLS, sealing).

**BDD.** One scenario under BEH-EA-336's feature ("A plugin's records are held to one behaviour over memory and SQL"). It calls `runRecordsParity` against a deliberately drifting fixture records pair and expects the failure. Use the next free REQ id (above `REQ-EA-1306` at `fc990c88`; re-check).

---

## 6. Spec, ADR, traceability and changesets

### 6.1 ADR-EA-046 (new; `spec/decisions/046-plugin-record-store-parity.md`, plus an `index.yaml` entry)

**Track B draft** (the default). Title: "Plugin Record Stores Keep a Memory Adapter Held to the SQL Adapter by a Differential Parity Contract".

- **Context:** §1 Summary, with the §2.1 inventory, the §2.3–§2.5 drift catalogue and the §2.6 measurements.
- **Decision:**
  1. Every plugin records module ships a `Ref` adapter and a SQL adapter behind one `*Shape`.
  2. `TestAuth.runRecordsParity` drives both in lockstep, and every method is classified at compile time.
  3. Every listing method documents and implements one order, with `(createdAt, id)` as the default key.
  4. A SQL read-modify-write is one statement, or a transaction that locks what it reads on Postgres.
  5. `StoreUnavailable.operation` names the records method.
  6. `orConflict` treats a SQLite primary-key clash as a unique violation.
- **Alternatives considered:**
  - (a) **SQL over an in-process SQLite as the memory adapter** (Track A), with the spike's numbers. Rejected because SQLite serialises writers, so it cannot exhibit the Postgres atomicity class. Deleting the `Ref` adapters removes the executable statement of intended semantics. And a matched memory composition would require core's `Persistence.memory` to leave `TestAuth` too (ADR-EA-041 decision 4).
  - (b) SQL over in-process Postgres (pglite), with S4's result.
  - (c) Keep the per-file pair suites only. Rejected: §2.3's drifts passed them.
  - (d) A shared helper module per plugin. Rejected for the reason ADR-EA-041 gives: the drift is in the I/O sequencing.
- **Consequences:** a new records method needs one `Operations` entry, the harness costs about N ms per module per run (measured in Phase 3), and every pg race fix adds a lock or a single-statement rewrite.

**Track A draft** (on "go"). Title: "Plugin Record Stores Have One Adapter; an In-Process Database Is the Memory Composition". It records G1–G5's measured values, the deleted surface, the `TestAuth` mode change and the core decision (Q5). Alternatives: Track B, with its cost.

**ADR-EA-041 → revision 1.2** (plan 16 also revises ADR-EA-041 decision 3; take the next free revision). Add to Alternatives: "**SQL over an in-process SQLite as the memory adapter.** Weighed for plugin record stores in ADR-EA-046; the same reasoning applies to core's ports, whose `StoreContract` already holds the `Ref` adapters to the SQL ones."

**ADR-EA-014 → revision 1.4**, TRBS-005 paragraph (`:40`): add "Plugin record stores' memory adapters are held to their SQL adapters by `runRecordsParity` (ADR-EA-046)." Under Track A, rewrite the paragraph instead: "memory compositions are an in-process database".

### 6.2 Behaviours (each with a Document Control revision and a change-history line)

- `spec/behaviors/25-testing-harness.md` → next revision (1.5 at `fc990c88`; plan 22 also bumps it). New **BEH-EA-<next free>** "Every plugin records interface is held to one behaviour over its memory and SQL adapters", with the REQUIREMENT text of §3.2 (lockstep, compile-time classification, declared comparisons, a seeded run in CI). BEH-EA-336 gains a pointer to it.
- `spec/behaviors/35-organization.md` → 1.8. The member listing orders by `(createdAt, id)` in `sortDirection`. Teams list by `(createdAt, id)`. A connection's `emailDomains` are sorted. Note the C1/C3 guarantees (no cycle under concurrent moves, `memberCount` never negative) in the teams BEH.
- `spec/behaviors/29-saml-sp.md` → 1.9: `emailDomains` sorted; a session save is an upsert.
- `spec/behaviors/36-jwt.md` → 1.2: a `kid` identifies one key forever, and registering or importing an existing kid fails `KidTaken` (R6, Q3).
- `spec/behaviors/05-persistence-stratum.md` (BEH-EA-325, plugin records fail with `StoreUnavailable`): add "naming the records method (ADR-EA-041 decision 7)" and the SQLite primary-key conflict mapping.
- `spec/behaviors/30-scim.md`, `34-webhooks.md`, `21-qadi-resolvers-obligations.md` (claims): one "As shipped" line each for C7/C8/C9 and the SCIM link conflict, only where the BEH states the operation's atomicity or conflict outcome. Otherwise none.

### 6.3 Traceability

`spec/traceability.md`: the new BEH row (`packages/test/test/RecordsParity.test.ts` plus each module's parity call), the ADR-EA-046 row, and the updated rows for the touched module tests. `features/traceability.md`: the new REQ (§5).

### 6.4 Changesets (ADR-EA-034; all packages are in the fixed group)

- Phase 1, `.changeset/records-canonical-behaviour.md` (`@awthaq/organization`, `@awthaq/saml`, `@awthaq/jwt`, `@awthaq/sql`, `@awthaq/scim`, `@awthaq/api-key`, `@awthaq/device-authorization`, `@awthaq/passkey`, `@awthaq/webhooks`; minor for organization/jwt/saml, patch otherwise):
  > Members list in the requested `sortDirection` over SQL too (it was always ascending); teams list by creation; a connection's `emailDomains` are returned sorted; registering or importing a signing key whose `kid` exists fails `KidTaken` instead of overwriting it (memory) or dying (SQL); a primary-key clash on SQLite is a typed conflict as on Postgres; `StoreUnavailable.operation` names the records method in six places it did not (ADR-EA-046).
  >
  > Migration: a client relying on `emailDomains` input order sees them sorted. A host that re-registers the same remote key at every boot must catch `KidTaken` (or check `KeyRing` first).
- Phase 2, `.changeset/records-parity-harness.md` (`@awthaq/test` minor): `TestAuth.runRecordsParity`, `TestCrypto.seeded`. Migration: none. Third-party plugins are encouraged to call it.
- Phase 4, `.changeset/records-postgres-atomicity.md` (organization, qadi, webhooks, saml; patch):
  > Concurrent team moves cannot form a cycle; `memberCount` never goes negative; concurrent organization and connection updates no longer lose or resurrect data; claims merges no longer lose a key; webhook endpoint deletion is atomic; SAML session saves are upserts (Postgres).
  >
  > Migration: none.
- Track A replaces the Phase 2 changeset with a breaking `@awthaq/core`/`@awthaq/test` major-in-0.x changeset. `Migration:` replace `records: { memory, sql }` with `records: layerSql`, and provide an in-process `SqlClient` where you composed `records.memory`.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| The harness is flaky (nondeterministic ids, clocks, HashMap order) | A seeded `Crypto` and one `TestClock` per adapter; listings without a promised order must be declared `"unordered"`; a fixed seed in CI, printed seed locally |
| The harness reports differences nobody can rank | Every failure is a shrunk, runnable sequence; the fix procedure is Phase 1's: pick a canonical behaviour with a spec id, test, fix |
| `Operations` boilerplate per module | About 3–6 lines per method (24 shapes, roughly 180 methods). That is less than the memory adapter, and it is the only place a module states its comparison semantics |
| Canonical ordering changes what clients see (R4/R5 sorted domains, R1 desc) | Changeset `Migration:` lines; Q2 for the domain order |
| R6 makes a host's boot-time re-registration fail | Q3 offers the idempotent variant (same kid and same public JWK is a no-op) |
| pg race fixes add lock contention (advisory lock per organization on team writes) | The lock is per organization, held for one short transaction; team writes are admin-rate |
| The spike's numbers are machine-dependent | Three warm runs, median, recorded with the machine and Node version; G1's threshold is relative |
| Docker unavailable locally (as in plans 05, 07, 08) | Phase 4 and the pg harness runs are verified in CI's Postgres service before merge; the executor states "not run locally" |

**Rollback.** Phase 1 reverts per module, except that the R4/R5 order and R6 error are client-visible, so revert before a release. Phase 2 is additive. Phase 3 reverts per package: delete the parity call. Phase 4 reverts per module. Track A's A1/A2 are the irreversible-in-practice steps once third parties adopt the single-adapter shape, which is why they sit behind G1–G5 and Q5.

---

## 8. Interactions with other plans

- **22 (table DDL locality).** Lands first, because both edit the same 24 records modules: 22 adds the `migrations` group at the top of each, and 24 edits both adapters. The passkey counter range (int4 against uint32) is 22's D2: it is a memory/Postgres drift, but it is a column type. The parity harness migrates through the plugin `Migrations.ledger` that 22 introduces. 22's pg/SQLite logical-schema parity check complements this plan's adapter parity. Under Track A it becomes the main guard, since almost every test would run on SQLite.
- **16 (sql-store-adapters).** 16 makes core's `Persistence.sql()` one bundle with one `StoreContract`. `RecordsParity` sits beside `StoreContract` in `@awthaq/test` and reuses its `TestFramework` injection and `race` helper. Both plans revise ADR-EA-041, so take consecutive revisions. 16 touches `StoreFailure` (housekeeping). Coordinate the `isUniqueViolation` change in Phase 1 with whichever lands second.
- **23 (relay-cursor-store).** 23 adds a `RelayCursorStore` port with memory and SQL adapters and puts it under `StoreContract` (core-side, so out of this plan's scope). Under Track B, nothing changes. Under Track A, 23's new memory adapter contradicts the direction, so a "go" here should be decided before 23 executes (or 23's memory adapter is accepted as core-side, consistent with Q5's answer).
- **15 (host-composition).** Derives the servable layer from `Auth.make`, including records bundles. Track A changes the bundle shape (A2), so if Track A goes, 15 must read `records` as one layer.
- **12 (passkey-ceremony), 13 (admin-gate), 04 (done).** Line shifts in `PasskeyCredentials`, `ImpersonationRecords` and the organization records. Rebase.
- **05 (done).** The isolation and sealed suites stay and run beside the parity harness. The `MemoryEnvelopes` seams stay under Track B and go under Track A.
- **08 (done).** `TestAuth.recordModes`, `RecordsLegal`/`RecordsComplete` and BEH-EA-334/336 are unchanged under Track B and reworked under Track A (A1, A2).
- **02 (done).** Core's `Ref` stores are out of scope under Track B. Under Track A, G4/Q5 decide them.

---

## 9. Acceptance checklist

- [ ] Phase 0's spike is recorded (`.scratch/memory-records-over-sqlite/issues/00-spike.md`) with G1–G5 measured, and the go/no-go and ADR-EA-046 are written accordingly.
- [ ] R1–R6, the SCIM link conflict, the SQLite PK mapping and the six labels have red-first tests, now green on memory, SQLite and Postgres.
- [ ] **Track B:** `TestAuth.runRecordsParity` exists with its self-test. All 24 records modules and the template call it. Every `Operations` is complete (compiles). Every `skip` and `"unordered"` is justified by the interface's doc comment.
- [ ] Roles has one pair suite (in `test-pg.sh`); no memory-only or SQL-only duplicate store cases remain.
- [ ] C1–C10 each have a pg race case (red first in CI) and a fix.
- [ ] **Track A (only on go):** A1–A4 done; no `layerMemory` in any plugin records module; `examples/memory-server` runs on an in-process `SqlClient`.
- [ ] No `as` (other than `as const`), no return-type annotations on new Effect/Layer consts.
- [ ] ADR-EA-046 added and indexed; ADR-EA-041 and ADR-EA-014 revised; BEH entries revised; traceability updated; `pnpm spec:verify:strict` green.
- [ ] Changesets with `Migration:` lines.
- [ ] `pnpm check` green; `pnpm test:pg` green in CI.

---

## 10. Open questions only the user can answer

1. **The decision rule.** Accept G1–G5 as the go/no-go for Track A, with Track B as the default when any of them fails? *Recommended: yes. §2's evidence already predicts G3 fails without pglite and G4 needs your approval, so expect Track B.*
2. **`emailDomains` order.** Sorted ascending (no schema change, matches SQL reads) or the administrator's input order (needs a position column and a migration in both organization and SAML)? *Recommended: sorted.*
3. **Re-registering a signing key.** Should `KeyRing.registerRemoteKey` with an existing `kid` and the *same* public JWK be an idempotent no-op (a host registering at every boot keeps working), with a *different* JWK failing `KidTaken`? Or should any existing kid fail? *Recommended: idempotent for the identical key, `KidTaken` otherwise.*
4. **Scope of the Postgres atomicity fixes.** Fix C1–C10 in this plan (Phase 4), or split them into per-plugin tickets outside it? *Recommended: in this plan. The parity work is what found them, and their tests share the harness's fixtures.*
5. **Core under Track A.** If Track A goes, take core's `Persistence.memory` out of `TestAuth` as well, so memory compositions are matched? Or keep core on `Ref` stores and accept a composition where plugin records run over SQLite beside a no-op transaction? *Recommended: if Track A goes, core goes too. The mixed form is ADR-EA-041 decision 4's forbidden mis-wiring.*
6. **`examples/memory-server` under Track A.** An in-process SQLite `:memory:` (state lost on restart, as today), or a file (`./memory-server.sqlite`)? *Recommended: `:memory:`, unchanged semantics.*
7. **Harness cost budget.** The default is 50 sequences × 25 steps per module in `pnpm test`. A heavier nightly run is not planned, because there is no caller for a nightly job yet. Raise or lower the default after Phase 3 measures it? *Recommended: keep 50 × 25 if a module's parity run stays under 2 s on SQLite; otherwise 20 × 25.*
8. **Offset pagination.** `MembershipRecords.listByOrganization` and `ScimRecords.list` accept an offset, against BEH-EA-036 ("no repository interface MAY accept an offset"). SCIM needs `startIndex` by RFC 7644. Amend BEH-EA-036 to allow it for those two, or move membership listing to a keyset cursor (an API change)? *Recommended: amend BEH-EA-036 for both, with a reason each. Out of this plan's code changes.*
