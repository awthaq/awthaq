# Architecture Research: integrating the eight batch-3 deepenings

**Domain:** awthaq, an Effect v4 TypeScript auth monorepo (pre-1.0, unpublished). Subsequent milestone: v1.0 Architecture Deepening, batch 3.
**Researched:** 2026-11-14
**Confidence:** HIGH on dependency direction, file inventories, ADR text and existing seams (all read from the working tree at `efb5e653`). MEDIUM on the ownership recommendations for candidates 3, 6 and 7 (judgment calls; each has a named open decision). No external sources were needed, so the research-plan/fetch seam was not used.
**Method note:** the review report's counts were treated as unverified and re-checked. Seven of its claims are corrected below (section "Corrections to the review").
**Scope rule:** seams, adapters, dependency categories, ownership, ADR conflicts, new vs modified files, order. No interface signatures.

---

## 1. The architecture these changes must fit

### Strata and the import rule

`spec/overview.md`: "A stratum depends only on strata below it." Verified in each `package.json`:

```
api (1) <- ports (2) <- sql (3) <- core (4) <- server (5) <- qadi (6) <- plugins <- cli/test/features
```

| Package | `@awthaq/*` runtime dependencies (verified) |
|---|---|
| api | none |
| ports | api |
| sql | api, ports |
| core | api, ports, **sql** |
| server | api, core, ports, sql |
| organization | api, core, oauth, ports, sql (dev: test) |
| saml | api, core, **organization**, ports, server, sql |
| scim | api, core, **organization**, ports, sql |
| admin | api, core, organization, password, ports, server, sql |
| cli | api, client, core, device-authorization, migrate-*, password, ports, roles, server (sql is a **devDependency**, type-only use) |
| test | api, core, ports, server, sql, web (no plugin; `password` dev-only) |
| features | every package; not scanned by `pnpm circular` |

Three consequences used throughout:

1. "core imports sql" is **by design**, not a leak. ADR-EA-041 decision 3 puts "the SQL adapters ... in `@awthaq/sql` (stratum 3)" and "the domain services and the matched bundles ... in `@awthaq/core` (stratum 4)". Alternative (a) there was rejected because it "makes `@awthaq/sql` depend on core while core depends on sql: a package cycle that `tsc -b` refuses and `pnpm circular` flags."
2. `pnpm circular` (`scripts/circular.mjs`) globs `packages/*/src/**` only, runs madge twice (value cycles, then type-inclusive cycles) and fails on either. `features/`, `examples/` and `packages/*/test` are not scanned. A cycle that exists only through `import type` still fails the gate, so a shared module must be generic and never `import type` a protocol's own records.
3. A module that both a `ports` memory adapter and a `sql` adapter need can only live in `ports` (or below). A module that plugin memory twins and SQL adapters need but `ports` does not can live in `sql`. A module consumed by `saml` and `scim` that already depend on `organization` can live in `organization`.

### Existing seams the new modules attach to (do not duplicate them)

| Seam | Where | Adapters today | Rule that governs it |
|---|---|---|---|
| Core store ports | `ports/*Store.ts` | `Ref` adapter in ports, SQL adapter in sql (`*StoreSql`) | ADR-EA-041 decisions 1-8 |
| Plugin record store (`<pkg>/records/<Name>`) | each `*Records.ts` | `layerMemory`, `layerSql`, bundled as `records: { memory, sql }` | ADR-EA-041 decision 9; `RecordsContract` verdict per operation (`read`/`write`/`atomic` with a `race` case/`exempt`) |
| SQL adapter substrate | `sql/SqlStore.ts`, `StoreFailure.ts`, `TenantScoped.ts`, `SealedColumn.ts`, `Models.ts`, `SqlDdl.ts` | one implementation, used by 5 of 16 plugin records files so far | ADR-EA-041 decision 5 |
| Exposed domain service | `AuthPlugin.layer(Self, { exposes })` | `Organization.layer` exposes 8 services (`OrganizationSystem.services`), `Password` exposes `PasswordCredential` | ADR-EA-040 |
| Host composition | `AuthHost.layer` (server) | production host; `TestAuth.layer` is the same module over test ports | ADR-EA-044 decision 6 |
| `Output` | `cli/Output.ts` | `layerConsole`, `capture` (real two-adapter seam) | BEH-EA-225, BEH-EA-201 |
| Credential registry | `server/Credentials.ts` `CredentialResolvers` + `contribute` | `api-key` (2 contributions), `jwt` (1) | ADR-EA-012 (aggregating registry), ADR-EA-042 |

---

## 2. Candidate-by-candidate integration

Format per candidate: owner, dependency category, seam and adapters, ADRs, new vs modified, constraints and traps.

### Candidate 1: one keyset-page module

**Owner: two halves.**
- **Store/domain half in `@awthaq/ports`** (new module, plus a re-export line in `ports/src/index.ts`). Page assembly (the `limit + 1` probe, trim, next-position), the limit clamp, and the in-memory comparator. Why ports and not sql or admin: `ports/UserStore.ts` has its own `Ref` adapter that must page (`UserStore.ts:359`), and ports cannot import sql; `admin` cannot own it because `organization` (which admin depends on) also pages; `organization` cannot own it because `core/Users.ts` and `sql/UserStoreSql.ts` also page.
- **SQL half in `@awthaq/sql`** (new module beside `SqlStore.ts`). The predicate/order fragment builder over `sql.and`/`sql.or`, direction from a closed union. It imports the position type from ports (existing edge).
- **Wire half in `@awthaq/api`** (optional, recommended). Three near-identical opaque cursor codecs exist (`AdminApi.CursorSchema`, `AdminApi.UserCursorSchema`, `AdminTenantsApi.OrganizationCursorSchema`, each `base64url(JSON {startedAt|createdAt, id})`) and two copies of `MAX_PAGE_SIZE = 200` (`AdminApi.ts:160`, `WebhooksApi.ts:138`) plus a third clamp in `core/Users.ts:556` (`MAX_LIST_LIMIT = 200`) and one in `ImpersonationRecords.pageLimit` which `AdminTenants.ts:199` imports across modules. `@awthaq/api` is stratum 1, imported by every package, isomorphic and Schema-only, so a generic limit/cursor schema factory is safe there.

**Dependency category:** in-process (pure), with the SQL half sitting at the existing local-substitutable store seam (memory adapter + SQL adapter, held together by `StoreContract`/`RecordsContract`).

**Real sites (verified, differ from the review):**

| Site | File | Shape today | Notes |
|---|---|---|---|
| Users list | `core/Users.ts:816`, `ports/UserStore.ts:359`, `sql/UserStoreSql.ts:176,473` | asc; port returns `{items, next}`; SQL reads `limit+1` | expanded `OR` predicate |
| Impersonation history | `admin/ImpersonationRecords.ts:79-215,458,682,768` | **desc**; `{items, nextCursor}`; `limit+1` | clamp `pageLimit`; "spelled out for both dialects" |
| Tenant list | `admin/AdminTenants.ts:196`, `organization/OrganizationDirectory.ts:67`, `organization/OrganizationRecords.ts:211,414` | asc; **store returns raw `limit` rows, the caller passes `limit+1` and trims** | assembly is split across two packages; SQL uses row-value `(a,b) > (?,?)` |
| Live sessions | `ports/SessionStore.ts:410`, `sql/SessionStoreSql.ts:540-578` | not a client cursor: `{items, truncated}`; SQL drains internal pages of `PAGE` | a different primitive; do not force it into the cursor page |
| Webhook deliveries | `webhooks/Webhooks.ts:750`, `WebhookRecords.ts:1101` | `before` = exclusive uuidv7 id, single key | single-key keyset |
| Members | `organization/MembershipRecords.ts:212` | **offset/limit**, not keyset | out of scope unless the milestone also changes the contract |

**ADRs:** ADR-EA-004 ("keyset pagination only (PRD section 12)") is the only mention and does not constrain placement. ADR-EA-041 decisions 2 and 6: every store operation carries a verdict; `listPage`-style operations are `read`. The memory/SQL ordering parity the review wants "one test suite" for **already has its bar**: `StoreContract` (core ports) and `RecordsContract` (plugins) run each case on both adapters. The new coverage is cases inside those suites, not a new harness. ADR-EA-024 (read replica): `listLive` carries `consistency`; the page module must not hide that option. ADR-EA-034: a changed cursor wire shape or removed export needs a changeset `Migration:` line.

**New files:** `ports/src/<KeysetPage>.ts`; `sql/src/<KeysetPredicate>.ts` (name free); optionally `api/src/<Page>.ts`; tests in each. **Modified:** `ports/src/index.ts` and **`spec/overview.md` `<!-- surface:ports -->` block** (check 13 of `spec/scripts/check-drift.mjs` fails otherwise); `UserStore.ts`, `UserStoreSql.ts`, `Users.ts`, `ImpersonationRecords.ts`, `OrganizationRecords.ts`, `OrganizationDirectory.ts`, `AdminTenants.ts`, `AdminApi.ts`, `AdminTenantsApi.ts`, `WebhooksApi.ts`; `test/StoreContract.ts` and the admin/organization contract suites gain page-order cases.

**Traps:**
- Wire compatibility: the impersonation cursor field is `startedAt`, the others `createdAt`. A generic cursor changes one of them. Outstanding cursors are opaque and the project is unpublished, but it is a wire break to announce (changeset), or keep per-site field names.
- Dialect: `models.wire.nullableDateTime` exists because SQLite binds ISO strings and pg binds `Date` (ADR-EA-004 revision 1.1, TS-001). Keep the existing wire codec in the request schemas; prove with SQLite suite plus `pnpm test:pg`.
- Oxlint forbids type assertions in `packages/*/src`, so the module takes accessor functions, not column-name strings.

---

### Candidate 2: one connection-lifecycle module (SAML, organization OIDC, SCIM)

**Owner: `@awthaq/organization`**, as an **exposed system service** (ADR-EA-040), protocol-neutral. `saml` and `scim` already depend on `organization`; `DomainClaims` and `OrganizationDirectory` (the active-organization gate) already live there; `SqlTransaction` is a ports port already required.

**What is genuinely shared (verified):**

| Concern | OIDC (`OrganizationConnections.ts`) | SAML (`SamlConnections.ts`) | SCIM (`ScimConnections.ts`, `Scim.ts`) |
|---|---|---|---|
| claim domains + row in one transaction, claim first (BEH-EA-317) | `claimed(...)` -> `DomainClaims.withClaim` (L430-443) | identical `claimed(...)` (L211-231) | **none** (SCIM has no domains) |
| release on delete in one transaction | `withRelease` (L578) | `withRelease` (L512) | none |
| active-organization gate at create | `requireActiveOrganization` via `directory.findActive` (L446) | `directory.find` (L331), **not** `findActive` | **none at create**; `findActive` only at bearer authentication (`ScimConnections.ts:143`) |
| `normalizeDomains` + `DOMAIN` regex | `OrganizationConnections.ts:336-349` | byte-identical copy `SamlConnections.ts:91-100` | n/a |
| gate at authentication ("unknown or suspended organization authenticates nothing", BEH-EA-237) | `findActive` | `usableConnection` (`Saml.ts:826-840`) | `ScimAuthenticationLive` |
| organization-deletion contribution | `connectionsOnOrganizationDelete` | `samlOrganizationDeletion` (`Saml.ts:723`) | `scimOrganizationDeletion` (`Scim.ts:612`) |

So the review's "SCIM is a third adapter" is only half true. SCIM shares the active-organization gate (create and authenticate) and the deletion contribution, not the claim. The module therefore has three protocol adapters at the **protocol seam** (what a connection validates and which record store it writes), with SCIM using a strict subset.

**Seams and categories:** in-process policy (gate order, claim-then-row ordering, release-with-delete) plus ports and adapters at `SqlTransaction` (`layerSql` real transaction, `layerNoop` for memory; this is exactly why `withClaim` carries compensation code for the no-op case). `DomainClaims` is a local-substitutable record store (memory + sql, in the organization records bundle). The protocol-specific part (validation, the row, the `*DomainTaken` error constructor via the existing `onTaken` parameter, the event) stays in the protocol package.

**ADRs.**
- ADR-EA-040 is the placement rule and is currently bent in letter. Decision 5: "SCIM, SAML and AdminTenants require them through the Layer type and never the records." Yet `organization/src/records.ts` lists "organization_domain_owner / _claim: OrganizationConnectionStore and SamlConnectionStore (BEH-EA-317)" as co-writers, and `DomainClaims` (a records store) is exported from the organization **root** and imported by `saml` (`SamlConnections.ts:26`, `Saml.ts`). `test/RecordsBoundary.test.ts` only refuses names matching `/\w*Records$/`, so `DomainClaims` slips through. Folding fixes this: the exposed module owns the claim tables and `DomainClaims` leaves the root export (breaking, changeset). **This is an ADR-EA-040 revision (new revision line), not a contradiction of its decisions.**
- ADR-EA-040 decision 3: a dependent that requires an exposed service must list the exposer in `dependsOn` (`ExposerNotDependedOn`). `saml` and `scim` already do. The key must be `awthaq/plugin/organization/<name>`; add it to `OrganizationSystem.services` and `.layer`.
- ADR-EA-041 decision 9: an invariant "a row and its ledger link" must be enforced by the primitive that writes. Claim+row atomicity is currently provided by a transaction around two stores (`DomainClaims.claim` is itself atomic through its owner-row primary key). Keep that argument intact; do not move it into the module's own check ("the module's own check only orders errors").
- ADR-EA-049 (plugins own event definitions): events stay with the protocol. Note the drift: OIDC emits `OrganizationConnection*Event` inside its store; SAML emits `auth.saml.connection*` at the admin layer. The lifecycle module must not centralize events.
- ADR-EA-028: `StoreUnavailable` mapping stays `StoreFailure.storeUnavailable(op)`.
- ADR-EA-023: SAML and SCIM are separate packages that sit on organization; this strengthens, not changes, that.

**Behaviour changes that unification forces (need explicit user decisions and BEH revisions):**
1. SAML `create` uses `directory.find` (a **suspended** organization may register a SAML connection) while OIDC uses `findActive` (refuses). BEH-EA-237 says a suspended organization refuses organization-scoped access. Unifying on `findActive` changes SAML.
2. SCIM `createConnection` checks nothing; a nonexistent organization produces an orphan connection that can never authenticate.
3. OIDC `update` gates on active organization; SAML `update` and both `remove`s do not.
4. The OIDC gate message "the organization does not exist" is also returned for a *suspended* organization.
Each is a spec revision (`29-saml-sp.md` BEH-EA-318, `30-scim.md`, `35-organization.md`) plus a BDD scenario.

**New files:** one module in `organization/src/` (+ a unit test with in-memory `DomainClaims`). **Modified:** `OrganizationSystem.ts` (services and layer), `OrganizationConnections.ts`, `DomainClaims.ts` (`withClaim`/`withRelease` move behind the module; the existing `DomainClaims.test`), `index.ts` (drop `DomainClaims` root export), `records.ts` header comment, `saml/SamlConnections.ts`, `saml/Saml.ts` (`samlOrganizationDeletion`, `usableConnection`), `scim/ScimConnections.ts`, `scim/Scim.ts`; possibly `SamlRecords.ts`/`ConnectionRecords.ts` if the per-protocol `*DomainTaken` plumbing changes (this is why 2 precedes 7).

**Circularity:** `saml`/`scim` -> `organization` exists. The module must be generic over the protocol's records and error type; any `import type` of `SamlRecords` into organization would be a type-level cycle that `pnpm circular` rejects.

---

### Candidate 3: test-host composer for the BDD Worlds

**Premise correction.** ADR-EA-044 decision 6 is already honoured: "`TestAuth.layer` is this module over the test ports". 37 `features/step-definitions` files call `TestAuth.layer`, 22 call `TestAuth.serve`, 12 hold a `TestAuth.lazyApp` cell (`features/STYLE.md`: "A World that serves an `Auth.make` composition holds exactly one `TestAuth.lazyApp` cell, named after the World"). The Worlds that "re-assemble layers by hand" are the five that carry an explicit header exemption ("Hand-wired on purpose", "plan 08 exemption"): `QadiBridgeWorld`, `AuthenticationWorld`, `TenancyWorld`, `ContractStratumWorld`, `CsrfWorld`. Those test pieces beneath composition and must stay out of scope.

What actually repeats across the 37 (read in Saml, Scim, Admin, Jwt, Organization): a `buildLive` that wraps `TestAuth.layer(built, { services, ... })`, then `provideMerge` of a log-capture `Logger.layer`, a `TestClock.setTime` layer (29 files touch `TestClock`), `RequestContext.RequestContextLive` (5), then `TestAuth.serve`, an `AppHandle { run }` shaped the same way, and the `lazyApp(options, build, { name })` wiring.

**Owner (recommended): `features/step-definitions/shared/`**, built **only on the public `@awthaq/test` barrel**, preserving the one-lazyApp-cell convention and `LeakGuard`. Reason: it carries BDD conventions (World name, observation capture, option Refs); `@awthaq/test` is deliberately plugin-agnostic (its header says it "does not depend on `roles` (or any other plugin package)"). **Open decision:** package suites in `packages/*/test` (organization 21 files, saml 14, password 14, ...) repeat the layer+serve pattern too. If the same shape is wanted there, the generic half (layer + serve + clock + capture + run handle) belongs in `@awthaq/test`, and only the World-lifetime half stays in `features/shared`. Decide before building; the safe default is features-only first.

**Dependency category:** local-substitutable (the in-memory host is the substitute for the production host).

**ADRs:** ADR-EA-044 (extended, not contradicted: the composer must be `TestAuth.layer` and not a second derivation); ADR-EA-054 (the base provides `TestMailbox`; a composer must not re-provide `Mailer`/`SmsSender` or expose `sent`; port observation is `TestMailbox.Mailbox`); ADR-EA-010 (ports are host-provided: a composer must keep a missing port a compile error rather than defaulting). `pnpm circular` does not see `features/`; the gate for this change is `pnpm test:bdd` plus `pnpm --filter @awthaq/features typecheck`, and `@awthaq/features` `tsconfig.json` `paths` already map every package.

**New files:** one module in `features/step-definitions/shared/`. **Modified:** up to 37 World files (mechanical, one at a time), `shared/Harness.ts` (it already holds `cheapArgon2id`, `awaitCondition`, named registry). No spec change; `features/traceability.md` untouched unless a scenario moves.

---

### Candidate 4: split `packages/test/src/TestAuth.ts` by concern

**Owner: `@awthaq/test`, internal.** Public surface unchanged: `packages/test/src/index.ts` keeps `export * as TestAuth from "./TestAuth.ts"`, and `TestAuth.ts` becomes the barrel that re-exports sibling modules. The package has a single `.` export, so no `exports` map change. `src/internal/` already exists (`foundation.ts` exists precisely so "`TestAuth` and `RecordsContract` [share it] without either importing the other").

**Concern map of the 1869 lines (verified with `grep` of top-level declarations):**

| Concern | Lines | Contents |
|---|---|---|
| composition | 138-428 | `layer` (3 overloads), `testPorts`, `makeLayer`, `CommonOptions`, `withRequest`, `withoutRequest`, `TestCsrfConfig`, `recordModes` |
| session and CSRF minting | 430-540 | `signInAs`, `sessionSetCookie`, `csrfToken`, `csrfSetCookie` |
| app harness | 541-935 | `App`, `serve`, `listen`, `withApp`, `lazyApp`, `openApps`, `buildContext` |
| small doubles | 940-995 | `encryption`, `httpClient`, `throwingFramework` |
| contract runner | 996-1861 | `runPluginContractTests` (~440 lines), `migratedSchema`, `applyMigrations*`, `declarationProblems`, `ownershipViolations`, `recordsParityProblems`, re-exports of `runSealedColumnTests`/`runTenantIsolationTests` |

**No existing back-edge:** nothing imports `TestAuth.ts` from `RecordsContract`, `StoreContract`, `SealedConformance`, `TenantConformance`, `TestSql`, `RedactionGuard`, `LaggingReplica`, `Rendezvous`, `SignInProbe` or `TestMailbox`. The legal DAG is: composition <- minting, composition <- app harness, {composition, app harness} <- contract runner; `TestSql` and `RecordsContract` stay below. The contract runner must not be imported by composition (keep `foundation.ts` as the shared floor).

**Overlap to resolve:** `migratedSchema`/`applyMigrationsOn` (`TestAuth.ts:1113-1185`) call `TestSql.schemaOf` (`TestSql.ts:349`) and add the ledger ritual. The split should leave `schemaOf` as the structural reader and keep only the apply-twice logic in the contract-runner module.

**Prune candidates (single-user exports):** `buildContext` and `openApps`; grep before deleting (knip is configured; `features` is an entry). `TestAuth.app` is documented as "a deprecated adapter until plan 34 ticket 21".

**ADRs:** ADR-EA-044 decision 6 and ADR-EA-054 (TestMailbox provided by the base) are untouched. BEH-EA-193-200, 331-333, 336, 342, 351-354, 357 name `packages/test/src/TestAuth.ts` as their implementation in `spec/behaviors/25-testing-harness.md` (L313, 336, 356, 372) and `spec/traceability.md` (L51, 336-338). Check 10 of `check-drift.mjs` requires cited test paths to exist, so **keep the test file names** (`TestAuthLifetime.test.ts`, `TestAuthLazy.test.ts`, `TestAuthListen.test.ts`, `TestAuthHost.test.ts`); update only the implementation cells.

**New files:** 4-5 modules under `packages/test/src/` or `internal/`. **Modified:** `TestAuth.ts` (barrel), the two spec files above. **Consumers unaffected:** 103 files import `TestAuth.<name>`.

---

### Candidate 5: CLI plugin views behind `Output.report`, delete `ConfigList`

**Owner: `@awthaq/cli`, internal.** No other package depends on cli.

**State (verified):** `Output.report(value, render)` handles only `--json` (L80-85). `Plugin.show` (`Plugin.ts:255-288`) re-implements the json/text split four times (hooks, rules, events, graph) with `out.document` / `Effect.forEach(render, out.line)` and adds `dot`. The `format` choice is a **per-command** flag (`Cli.ts:187`, `text | json | dot`) that `Plugin.show` ORs with the global `out.json` (`options.format === "json" || out.json`). That OR is the real leak: `Output.json` and `--format json` are two ways to say the same thing.

**ConfigList:** 28 lines (`ConfigList.ts`), `show` = `Doctor.configContext` + `EffectiveConfig.read` + `Output.report`. It is **publicly exported** (`cli/src/index.ts:12`, `export * as ConfigList`), used once in `Cli.ts:152` and once in `cli/test/Doctor.test.ts:237`. Deleting it is a breaking export change (ADR-EA-034 pre-1.0: allowed, needs a changeset with a `Migration:` section). Spec references to update: `spec/behaviors/26-cli.md` L46 and L398 ("`@awthaq/cli` `ConfigList.ts`").

**Seam:** `Output` is a genuine two-adapter seam (`layerConsole`, `capture`), and the existing `Inspection.test.ts` already pins every `Plugin.show` mode through `capture`. Recommended end state: the global/`--format` resolution happens once where `Output` is bound (`Cli.ts` `withOutput`), so `Output.json` is the single truth, and `dot` is the one view-specific format owned by the graph view. Each view is `{ value, render [, dot] }` data plus one report call.

**ADRs:** ADR-EA-027 (CLI on `effect/unstable/cli`: commands stay `Command.make`, unchanged); BEH-EA-201/225 (no secret values; one JSON document; a failure document has the same `_tag` and exit code); BEH-EA-208 class 1 (manifest-only commands never build a layer). None is contradicted. `plugin list` (no flags) prints `order. id` lines in text but the full `GraphNode[]` in JSON; that asymmetry is observable and must survive.

**New files:** a views module in `cli/src/`. **Modified:** `Plugin.ts` (render/format branches out), `Output.ts` (only if `report` gains view/format awareness), `Cli.ts` (3 inline lines replace `ConfigList.show`; format resolved at `withOutput`), `index.ts` (drop `ConfigList`), `Doctor.ts` (export shape of `configContext`/`descriptorsOf` unchanged), `test/Doctor.test.ts`. **Deleted:** `ConfigList.ts`.

---

### Candidate 6: a single table catalogue

**Premise correction.** The review says core "rebuilds `coreTables`" and cli "re-maps tenancy". Verified:
- `core/Auth.ts:779` builds `coreTables` as the concatenation of `TenantScope.partitionedTables` and `TenantScope.directoryTables` (imported from sql). That is consumption, not re-derivation.
- `cli/Plugin.ts:57-68` `describeTenancy` is a **presentation formatter** for a plugin's `TableDeclaration`; cli imports `TenantScoped` as a type only (sql is a cli devDependency). It does not know core tables.
- The one true hand-copy is `test/src/LaggingReplica.ts:31` (`coreTables`, a six-name list with the comment "The core tables `@awthaq/sql`'s `CoreMigrations` creates").
- The catalogue is **incomplete**, which is the real defect: `CoreMigrations` also creates `auth_relay_cursor`, and `RateLimiterStoreSql` creates `rate_limit_buckets`; neither is in `partitionedTables`/`directoryTables`, so `Auth.checkTenancy` refuses a plugin `Derived` table whose parent is either one (`UnknownParent`, `Auth.ts:886`), and nothing states their tenancy. `CoreSealedColumns` (six columns on `users`/`sessions`/`accounts`) is a second per-table list, and `SealedColumn.Deployed` (three vs six with `encryptPii`, ADR-EA-019 revision 1.3) a third.

**Owner: `@awthaq/sql`** (stratum 3), next to `CoreMigrations`, `TenantScope` and `CoreSealedColumns`. This is the only stratum that (a) owns the DDL, (b) is importable by `core` (permitted direction), (c) is importable by `test` (existing dependency), and (d) does not require `sql` to import `core`. Putting it in core would make `sql/TenantScope.enableRls` unable to read it (sql must not import core: the cycle ADR-EA-041 (a) rejected). cli should receive it through core's `Auth.Built`/manifest, **not** by promoting `@awthaq/sql` from devDependency to dependency (a `package.json` and `pnpm workspace:check` change that buys nothing).

**Dependency category:** in-process (static data plus pure checks).

**ADRs and the boundary that matters:**
- **ADR-EA-004** retired a bespoke "schema intermediate representation (IR) ... a closed `ColumnType` union with per-dialect rendering". A catalogue must stay a list of **table identity, owner, tenancy kind and sealed columns**, and must not grow column types or DDL rendering, or it reintroduces the rejected design. State this as an explicit rule in the plan.
- ADR-EA-018 decision 4: `users` and `accounts` are the global identity directory (RLS opt-in via `includeDirectory`); decision 5: RLS is opt-in; decision 10: plugin tables declare tenancy as Partitioned/Keyed/Derived/Global. The catalogue must reuse `TenantScoped.Tenancy`/`TableDeclaration`, so core tables and plugin tables are declared in the same vocabulary. Expect `TenantScope.DeclaredTable` (an RLS-module type that `core/Auth.ts` already treats as the declaration type) to move to the catalogue.
- ADR-EA-019 revision 1.3 (`Deployed` is built from the same options that choose the repositories).
- ADR-EA-041 decision 5 (adapters stamp tenant through `Tenant.stamp`, seal through `SealedColumn`): the catalogue records *what*, the adapters keep *how*.

**Relationship to candidate 5:** only a file-level one (`cli/Plugin.ts`). Do 5 first; leave `describeTenancy` in the cli view as presentation. No catalogue-to-cli dependency is required.

**Relationship to candidate 7:** none required. A plugin's table declaration still comes from `AuthPlugin`'s `tables` option; the memory/SQL scaffold consumes `TenantScoped.visibility/predicate/stamp`, not the catalogue.

**New files:** one module in `sql/src/` (+ `sql/src/index.ts` export). **Modified:** `TenantScope.ts` (`partitionedTables`/`directoryTables` derive from it; `coverage` reads it), `CoreSealedColumns.ts`, `core/Auth.ts` (`coreTables` and the `UnknownParent` check), `test/src/LaggingReplica.ts`, `spec/overview.md` stratum 3 row, ADR-EA-018/019 revision notes. Tests: `sql/test/TenantScoped.test.ts:167-170` pins both lists.

---

### Candidate 7: shared record-store scaffolding (16 `*Records.ts`)

**Verified inventory:** 16 files, 10,575 lines, 55 `layerMemory` references (several files hold more than one store: `jwt` 9, `saml` 8, `webhooks` 7). Only **5 of 16** have started the ADR-EA-041 decision 5 `SqlStore` shape (`InvitationRecords`, `MembershipRecords` (3 uses), `OrgRoleRecords`, `TeamRecords`, `WebhookRecords`); the other 11 still pipe each method through `StoreFailure.orStoreUnavailable`, which ADR-EA-041 describes as "the same classification without the retry". So the SQL substrate (`SqlStore`, `StoreFailure`, `TenantScoped`, `SealedColumn`, `Models`, `SqlDdl`) **is already shared scaffolding**. What is missing is the memory twin and the per-dialect row/DDL glue.

**Owner:**
- Memory-side scaffolding (a keyed in-memory table with tenant visibility and ordered listing, over `Ref`): **`@awthaq/ports`**, because `ports` is where ADR-EA-041 decision 3 puts every `Ref` adapter and it is below `sql`. It builds directly on candidate 1's page assembly and comparator.
- SQL-side scaffolding (the remaining pieces of the adapter recipe, e.g. a dialect row helper, bringing the 11 stragglers onto `SqlStore.make`): **`@awthaq/sql`**, extending `SqlStore.ts`/`Models.ts`. Do not create a "memory helper" in sql: ADR-EA-041 alternative (b) rejected "a KV backend would depend on a package named `sql`".
- Contract runner: stays `@awthaq/test` `RecordsContract` (already shared; nothing to extract).

**Dependency category:** local-substitutable (each store's `layerMemory`/`layerSql` pair behind one `*Shape`).

**ADRs that constrain the design (all quoted from the ADR text):**
- ADR-EA-041 decision 9: "An invariant a system module relies on across rows or across a read ... is enforced by the primitive that writes: one `Ref.modify`, or one conditional statement ... or one transaction holding `SqlStore.atomically(sql, key)`." A memory scaffold that offers `get` then `set` as separate effects would silently break the memory twin's role as the executable statement of atomicity. The scaffold must expose a single read-modify-write primitive over the `Ref` and must not let a domain body compose two.
- ADR-EA-041 decision 9 also: every operation carries a `RecordsContract` verdict, "an operation without a verdict does not compile." The scaffold cannot generate operations; bodies and verdicts stay per store.
- ADR-EA-040: records are not a public module; `organization/records` subpath and `RecordsBoundary.test.ts` stay.
- ADR-EA-054 decision 1 ("A port's interface holds only what a production adapter implements and production code calls") applies by analogy: a memory scaffold must not grow a test-only `snapshot`/`rows` on the record `Shape`. Test observation belongs in `@awthaq/test`. Existing precedent for a test seam in a bundle: `MemoryEnvelopes`, which the bundle projects away.
- ADR-EA-004 revision 1.3: "`SqlModel.makeRepository` and `SqlSchema` are used inside each store and record adapter; no repository is a public module."
- **Plan 24 Track A is still an unresolved option.** `.planning/24-memory-records-over-sqlite/PLAN.md` keeps a spike "SQL over SQLite `:memory:` as the memory adapter", which would delete every `Ref` twin; its Track B was subsumed by plan 25 and ADR-EA-041 decision 9 states each plugin store "keeps its two adapters". Building memory scaffolding presupposes Track A is dead. ADR-EA-046 is reserved for it. **Resolve this explicitly before starting candidate 7** (record "Track A closed" in a decision or an ADR-EA-041 revision note), otherwise the work can be invalidated.

**Honesty about the payoff:** the review's own risk ("bodies are domain-specific, so the shared part may be thin") holds. Read of `MembershipRecords`, `OrganizationRecords`, `ImpersonationRecords`: the repeated memory parts are the `HashMap` state, tenant visibility filtering, sort-and-page, not-found `Result` plumbing; the invariants (last owner, quotas, team forest) are exactly the parts that must stay hand-written. Expect to migrate stores in tickets of one file each and stop where the scaffold stops paying.

**Files:** new modules in `ports/src/` and `sql/src/`; modified: all 16 `*Records.ts` (incrementally), `ports/src/index.ts` and the overview `surface:ports` block, `docs/plugin-authoring.md` ("Record stores and bundles", the checklist items 4 and 10), and the working template `examples/plugin-template/` (`Template.ts` ships `layerMemory`/`layerSql`, exercised by tests).

---

### Candidate 8: fold the credential registry / source parsing in `server/Credentials.ts`

**Owner: `@awthaq/server`, internal.** `Credentials` is already the single module ADR-EA-042 decision 1 requires ("One module, `Credentials`, in `@awthaq/server`"); the work is physical, not an interface change.

**Verified structure (678 lines):** resolver (45-110), claimed-credential registry (117-260), source/carrier parsing (265-320), tiers (325-345), the `Scope` seam (346-400), `make` (442-587), the two scopes (588-678).

**Constraint that limits "internal":** the registry is **not** internal. `@awthaq/api-key` (`ApiKey.ts:605-662`, two contributions) and `@awthaq/jwt` (`Jwt.ts:436-453`) `yield* Credentials.CredentialResolvers` and call `Credentials.contribute(carrier, ...)`; `AuthHost.ts:131` provides `CredentialResolversLive`. That is ADR-EA-012's aggregating-registry seam: "any number of plugins add a credential type with `contribute` and a Layer alone, without editing `@awthaq/api` or this package." Its public surface (`CredentialResolvers`, `contribute`, `CredentialResolversLive`, `ClaimCarrier`, `CredentialResolverContribution`, the two errors) must stay on the `Credentials` namespace. What can go internal is the registry **implementation** (the freeze/duplicate/order bookkeeping), `findClaim`/`resolveClaimed`, the `bearerCredential` parser and the memo plumbing. Actually-used public names from tests and adapters (grep): `fromRequest` 21, `userTier` 19, `make` 19, `httpScope` 19, `contribute` 13, `machineTier` 9, `CredentialResolversLive` 9, `resolve` 4, `presented` 3, `collecting` 3.

**ADRs:** ADR-EA-042 stays valid as written (decisions 1-9). Decision 3 (Path A keeps one handler per declared scheme and calls `step`; the optional tier, Path B and the web adapter call `resolve`), decision 6 (claimed credentials join the per-request memo), decision 8 (cookie naming lives in `@awthaq/api`) are behaviour that tests pin (`Credentials.test.ts` 23 request shapes x 3 tiers, `CredentialResolvers.test.ts`, `Authentication.test.ts`). The review itself says "ADR-EA-042 just landed; reopening it needs real friction." The honest framing: this is a locality move with the same pattern as candidate 4 (public barrel preserved, parts under `internal/`; `server/src/internal/` already holds `BrowserPage.ts`, `SessionCookie.ts`, `SessionDto.ts`). Update ADR-EA-042 only if the file layout is cited (it names `Authentication.ts`, not `Credentials.ts` internals).

**New files:** 3-4 under `server/src/internal/` (registry, source, memo/scope). **Modified:** `Credentials.ts` (barrel), spec cells that cite `Credentials.ts` as an implementation. No other package changes. `pnpm circular`: server-internal only; the existing `Authentication.ts -> Credentials.ts` edge remains one-way.

---

## 3. Dependencies between candidates

```
                     4 (TestAuth split) ───────► 3 (Worlds composer)       soft, ordering only (see below)
                     5 (CLI views) ───────────► 6 (catalogue)               file overlap cli/Plugin.ts only
   1 (keyset) ───────────────────────────────► 7 (record scaffolding)       hard: 7's memory half builds on 1
   2 (connection lifecycle) ─────────────────► 7                            ordering: both edit SamlRecords/ConnectionRecords/ScimRecords
   8 (Credentials split)                                                    independent
   6 (catalogue)                                                            independent of 7 (no shared file)
```

| Pair | Relationship | Evidence |
|---|---|---|
| 7 on 1 | **Hard.** 7's memory table needs the comparator and page assembly; 1 decides the ports-level home (pure module, `surface:ports` update) that 7 extends. Also 1 edits `ImpersonationRecords` and `OrganizationRecords`, two of 7's 16 files. | review: "Do candidate 1 first; it is the clearest slice of this." |
| 7 on 2 | **Ordering.** 2 may change `*DomainTaken` plumbing in `SamlRecords`/`ConnectionRecords` and removes the `DomainClaims` root export; 7 later rewrites those files' memory sections. Doing 7 first means redoing the merge. | `SamlRecords.ts:145,379-409`; `ConnectionRecords.ts:101` |
| 7 on plan 24 Track A | **Gate.** Track A would delete the memory twins that 7 scaffolds. | `.planning/24-memory-records-over-sqlite/PLAN.md` |
| 3 on 4 | **Soft.** The barrel is stable, so 3 compiles against today's `TestAuth`. But 4 prunes `buildContext`/`openApps`, resolves `migratedSchema` vs `TestSql.schemaOf`, and decides which half (if any) of the composer is generic, so 3 should consume the settled surface. | `TestAuth.ts` section map |
| 6 on 5 | **File-level only.** Both touch `cli/Plugin.ts`. 6 does not need cli at all if `describeTenancy` stays a presentation concern. 5 first. | `cli/Plugin.ts:57-68`, cli `package.json` (sql is dev-only) |
| 6 on 7 | None. | |
| 8 on anything | None. | |
| 2 on 1 | None, but 2's SCIM/SAML list endpoints (if any page) should use 1's module when it exists; not a blocker. | |

---

## 4. Suggested build order

Gate for every phase (from `.planning/README.md` and PROJECT.md): `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; plus `pnpm test:bdd`, `pnpm spec:verify:strict`, and `pnpm test:pg` when a SQL adapter changes (1, 2, 6, 7). Each package-visible change carries a changeset with a `Migration:` section (ADR-EA-034).

**Wave A: locality moves with a preserved barrel (file-disjoint, may run in parallel).**
1. **Candidate 8** (server `Credentials` split). Lowest risk; establishes the "barrel plus `internal/`" pattern.
2. **Candidate 4** (`TestAuth` split). Same pattern; unblocks 3.
3. **Candidate 5** (CLI views, delete `ConfigList`). cli only.

**Wave B: pure shared modules at the low strata.**
4. **Candidate 1** (keyset). Touches ports, sql, api, core, admin, organization, webhooks; adds cases to `StoreContract`/`RecordsContract`. Needs `pnpm test:pg`.
5. **Candidate 3** (Worlds composer), after 4. Pure `features/`, so it can also run beside Wave B.

**Wave C: behaviour-bearing consolidation.**
6. **Candidate 6** (catalogue), after 5. Touches sql, core, test, spec.
7. **Candidate 2** (connection lifecycle). Needs the four explicit behaviour decisions in section 2 before coding; revises ADR-EA-040 (note) and three behaviour files.

**Wave D: the largest, last.**
8. **Candidate 7** (record scaffolding), after 1 and 2, and only after the Plan 24 Track A closure is recorded. Migrate store by store; the template and `docs/plugin-authoring.md` last.

Rationale: waves A and B put the reusable primitives and the tooling in place before the high-fanout work; 2 precedes 7 to avoid double-editing the connection records; 7 is last because it has the thinnest guaranteed payoff, the broadest blast radius (16 files, 5 packages, the public template) and a recorded dependency on an undecided plan.

Alternative worth considering: run 3 last so the Worlds are recomposed once after 2 changes SAML/SCIM/organization behaviour. Cost of that ordering: 2 and 7 edit the larger, uncomposed Worlds.

---

## 5. ADR impact summary

| ADR | Candidates | Constrains | Revised or contradicted? |
|---|---|---|---|
| ADR-EA-004 | 1, 6, 7 | "keyset pagination only"; no bespoke schema IR; "no repository is a public module" | Not contradicted. **Boundary for 6:** the catalogue may not become an IR (no column types, no DDL). Add revision note only if wording changes. |
| ADR-EA-040 | 2 (also 7) | exposed services under `awthaq/plugin/<id>/<name>`, `ExposerNotDependedOn`, "never the records" | **Revise (new revision line):** `DomainClaims` is a records store reached by `saml` through the organization root export and listed as co-written in `records.ts`; the lifecycle module becomes the exposed owner. |
| ADR-EA-041 | 1, 6, 7 | decision 3 (placement of ports/adapters/services), 5 (adapter shape), 9 (atomic primitives + verdicts) | **Revise (note):** record that plan 24 Track A is closed (7), and that the keyset/memory-table scaffolding in ports follows decision 3's placement rule. Decision 9 constrains the scaffold design but is not contradicted. |
| ADR-EA-042 | 8 | one `Credentials` module in server, `Scope` seam | Not contradicted; spec text that cites file internals updated. |
| ADR-EA-044 | 3, 4 | `TestAuth.layer` is `AuthHost.layer` over test ports | Not contradicted; extended to the BDD composer. |
| ADR-EA-045 | none | review already rejected touching the session-cookie split | Out of scope. |
| ADR-EA-054 | 3, 4, 7 | test observation off the ports; `TestMailbox` provided by the `TestAuth.layer` base | Not contradicted. Applies to the composer (do not re-provide mailer ports) and to the memory scaffold (no test-only members on a record Shape). |
| ADR-EA-018 / 019 | 6 (and 7 via `TenantScoped`/`SealedColumn`) | tenancy kinds and the six sealed columns | Revision notes when the catalogue becomes their single list. |
| ADR-EA-012 | 8 | registries aggregate, freeze at first read | Constraint: the `contribute` seam must remain public. |
| ADR-EA-034 | all | every package-visible change: changeset with `Migration:` section; fixed group | Process constraint. Breaking exports: `ConfigList` (5), `DomainClaims` root export (2), cursor wire shape (1). |
| ADR-EA-049 | 2 | plugins own their event definitions | Constraint: lifecycle module must not centralize events. |
| ADR-EA-023 | 2 | SAML and SCIM are separate packages above organization | Supported. |
| ADR-EA-046 | 7 | reserved for plan 24, not present in `spec/decisions/` | Decide use or release before 7. |

New ADR numbers: 046 (reserved), 050-053, 055, 056, 058, 059 are referenced by existing plans (some "released unused"); the highest file is 057. Take the next unreserved number only after checking `.planning/README.md` reservations and `spec/decisions/index.yaml`; check 16 of `check-drift.mjs` fails on a duplicate id.

---

## 6. Corrections to the review report (verified against the tree)

1. **Candidate 1:** `MembershipRecords.applyPage` is offset/limit, not keyset. `SessionStore.listLive` is a bounded "truncated" listing, not a cursor page. `OrganizationRecords.listPage` returns `limit` rows and the caller adds the `+1`, so assembly is split across packages. The three admin cursor codecs and three limit clamps are the duplication the review missed.
2. **Candidate 2:** `DomainClaims.withClaim/withRelease` already exist and are shared; the remaining duplication is the active-organization gate, `normalizeDomains` (byte-identical regex), the wrapper closure, and the three deletion contributions. SCIM has no domain claim. The SAML gate is `find`, not `findActive`: a behavioural difference, not only a copy.
3. **Candidate 3:** `TestAuth.layer` is already used by 37 of 55 TestAuth-importing step files. Five Worlds are exempt on purpose. The repeating part is the capture-logger, clock, request-context, `serve`, `AppHandle` and `lazyApp` wiring around it.
4. **Candidate 5:** `ConfigList` is publicly exported from `@awthaq/cli`, so deletion is a breaking export (changeset), and the `--format json` vs `--json` OR is the deeper leak.
5. **Candidate 6:** core consumes sql's lists rather than re-deriving them, and cli only formats. The real defects are the hand copy in `LaggingReplica`, the omission of `auth_relay_cursor` and `rate_limit_buckets`, and the sealed-column list living apart.
6. **Candidate 7:** 11 of 16 records files have not yet adopted `SqlStore`; the SQL substrate is already the shared part. The Plan 24 Track A spike is an open threat to the memory half.
7. **Candidate 8:** the registry cannot go internal; `api-key` and `jwt` consume it by design (ADR-EA-012).

## 7. Anti-patterns to avoid

| Anti-pattern | Why bad | Instead |
|---|---|---|
| Putting the keyset module in `admin` or `organization` | `ports/UserStore` and `core/Users` need it; ports cannot import upward | `ports` (+ `sql` predicate, `api` wire) |
| Putting the table catalogue in `core` | `sql/TenantScope.enableRls` must read it; sql cannot import core (cycle, ADR-EA-041 (a)) | `sql` |
| A generic scaffold method that performs get-then-set | breaks ADR-EA-041 decision 9; hides races that only Postgres exposes | one read-modify-write primitive; keep bodies hand-written |
| Moving `CredentialResolvers`/`contribute` out of the public `Credentials` namespace | `api-key` and `jwt` contribute through it (ADR-EA-012) | split files, keep the namespace |
| Re-deriving host composition in the BDD composer | forks ADR-EA-044 decision 6 | compose `TestAuth.layer`, never `AuthHost` directly |
| Importing a protocol's records type into the organization lifecycle module | type-level cycle, `pnpm circular` fails | generic over the protocol's records and error |
| Promoting `@awthaq/sql` to a cli runtime dependency for the catalogue | package.json, workspace check, no benefit | pass through core's manifest |

## Sources

All HIGH confidence, read from this repository at `efb5e653`:
- `spec/decisions/` ADR-EA-004, 010, 012, 018, 019, 023, 024, 027, 028, 034, 040, 041, 042, 044, 045, 049, 054 (decision text quoted above)
- `spec/overview.md` (strata table, `surface:ports` block), `spec/scripts/check-drift.mjs` (checks 10, 13, 16), `scripts/circular.mjs`
- `.planning/README.md`, `.planning/24-memory-records-over-sqlite/PLAN.md`, `.planning/25-record-store-contract/PLAN.md`, `.planning/research/STACK.md` (sibling research; not modified)
- `docs/plugin-authoring.md`, `features/STYLE.md`, `examples/plugin-template/`
- Source files named inline, and each package's `package.json` for dependency direction
- Review report (unverified counts; corrected in section 6): `/private/tmp/claude-502/-Users-mohammadalmechkor-Projects-Perso-awthaq/77238ac1-76b0-4bb3-a3a7-ec012e7983a4/scratchpad/architecture-review-20261114.html`
