# Feature Research

**Domain:** internal architecture deepening of an Effect v4 auth monorepo (awthaq). "Features" here are behaviors to preserve (table stakes), improvements the deepening can carry (differentiators), and scope traps (anti-features), per candidate.
**Researched:** 2026-11-14
**Confidence:** HIGH for the code verification (every site read), MEDIUM for BEH/feature mapping (grep of spec and traceability, not every scenario read)

Method: each candidate's evidence in the review report was re-read against the tree. Counts are re-counted by grep and marked as such. "Holds" means the cited code exists and says what the report says.

## Evidence verification (read this first)

| # | Candidate | Verdict | What does not hold |
|---|-----------|---------|--------------------|
| 1 | Keyset-page module | **Partly holds** | 4 keyset families, not "8+ sites". `MembershipRecords.ts:212` is offset/limit paging, not keyset. `SessionStore.ts:410` and `SessionStoreSql.ts:578` are `listLive`, a bounded list returning `{items, truncated}` with no caller-visible cursor. The 3 keyset contracts have 3 different shapes (below). |
| 2 | Connection lifecycle | **Partly holds** | The claim wrapper is already shared (`DomainClaims.withClaim` / `withRelease`); only a 10-line `claimed` adapter per store is duplicated. SCIM is not a parallel claim/row store: it has no domains, no claim, no transaction, and no create-time org gate. "Copy of requireActiveOrganization" is wrong in substance: SAML create calls `directory.find` (exists), OIDC calls `directory.findActive` (exists and not suspended). |
| 3 | Test-host composer | **Does not hold as stated** | `TestAuth.layer(Auth.make([...]))` already is the test host (BEH-EA-342: `AuthHost.layer` over the test ports; plan 08 migrated the Worlds). 28 of 31 `*World.ts` files already use `@awthaq/test`; there are 101 `TestAuth.layer` calls in step-definitions. 5 Worlds carry an explicit `// Hand-wired on purpose ... (plan 08 exemption)` header. Worlds are 121-1040 lines (only 6 are 600+), not "600-1040 each". |
| 4 | Split TestAuth.ts | **Holds, with 3 corrections** | 1869 lines confirmed. (a) `buildContext` is not single-user: 3 call sites (TwoFactorWorld x2, TenancyWorld), a test, README and CHANGELOG. (b) `migratedSchema` does not overlap `TestSql.schemaOf`; it calls it (line 1152). (c) Counts: 135 files use `TestAuth.layer` (report: 103), 25 files use `TestAuth.runPluginContractTests` (report: 41). |
| 5 | CLI views / ConfigList | **Holds** | Plugin.show has the json/text branch 3 times (hooks, rules, events) plus a 4th for the graph. ConfigList is 28 lines but it is not "3 lines": it exports `renderText` and `show`, is a public barrel export (`index.ts:12`), has a test (`Doctor.test.ts:237`) and is cited in spec 26-cli (BEH-EA-229 and the doctor section). Missed by the report: `--format json` also forces JSON when `--json` is off, which `Output.report` does not know; `Migration.ts:88-117` and `Openapi.ts:34` also bypass `Output.report`. |
| 6 | Table catalogue | **Mostly does not hold** | `core/Auth.ts` `coreTables` is a 3-line concat of `TenantScope.partitionedTables` and `directoryTables`, used once (`Auth.ts:886`, parent-table check). core importing sql is the layering ADR-EA-041 decision 3 prescribes (sql stratum 3, core stratum 4; `core/package.json` depends on sql). `cli/Plugin.ts:57-69` `describeTenancy` is a display formatter, not a re-derived catalogue. The one real duplicate is `test/src/LaggingReplica.ts:31` (`coreTables`, 6 hand-copied names). |
| 7 | Record-store scaffolding | **Holds, evidence thin** | 16 files, 10,575 lines confirmed. "55 layerMemory sites": grep finds 116 `layerMemory` references in `packages/*/src` (different counting, same conclusion). Memory twins are all hand-written `Ref<HashMap>`. But memory/SQL parity is already enforced by `RecordsContract` (plan 25, ADR-EA-041 decision 9); the duplication is structural, not behavioral. Only 4 of 16 files use the plain `Ref.make(HashMap.empty)` shape. |
| 8 | Credentials.ts | **Holds** | 678 lines, sections at the cited lines. Corrections: `make` is 442-587 (~146 lines, not ~200); 588-678 are the two scopes. `AuthHttp.ts:163-188` only consumes `PrincipalResolverLive`; it is not part of the registry. |

Not confirmed by grep (carry to the roadmap as "re-scope" items): candidate 3 (premise false), candidate 6 (premise mostly false), candidate 2's SCIM leg, candidate 1's Membership and `listLive` legs, candidate 4's `buildContext` prune.

## Candidate 1: One keyset-page module

**Real sites (verified):**
- `UserStore` memory adapter `ports/src/UserStore.ts:360-380` (ASC `(createdAt,id)`, takes `limit`, builds `next`); SQL `sql/src/UserStoreSql.ts:176-191,471-490` (passes `limit`, SQL adds `+1`).
- `ImpersonationRecords` memory `admin/src/ImpersonationRecords.ts:196-215,457-466` and SQL `:682-702,768-780` (DESC `(startedAt,id)`, `toPage` assembles).
- `OrganizationRecords.listPage` memory `organization/src/OrganizationRecords.ts:211-232`, SQL `:414-437` (ASC `(createdAt,id)`). It returns raw rows; the page is assembled by the caller `AdminTenants.listOrganizations` (`admin/src/AdminTenants.ts:196-212`, which asks for `limit + 1`).
- Limit clamp is written twice: `ImpersonationRecords.pageLimit` (`:111`, imported by `AdminTenants`) and `core/src/Users.ts:558` `listLimit`; wire bound `AdminApi.MAX_PAGE_SIZE = 200`.
- Three wire cursor schemas: `CursorSchema`, `UserCursorSchema`, `OrganizationCursorSchema` (base64url JSON).
- Contract divergence: `UserStore.listPage(limit)` returns `{items,next}` and applies `+1` inside the adapter; `OrganizationRecords.listPage(limit)` expects the caller to have added `+1` and returns rows; `ImpersonationRecords.list` returns a page. A shared module must pick one contract.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| Keyset-only: no store port accepts an offset; cursor from `(createdAt,id)`, next cursor returned with the page | BEH-EA-036 (`05-persistence-stratum.md:97`) | `features/features/01-contract-and-persistence/05-persistence-stratum.feature` (REQ-EA-093..095), type gate `keyset-only-no-offset` in `PersistenceTypeGates.ts` | LOW (must stay a compile error) |
| Never read more than `limit + 1` rows; an exactly-full final page invents no cursor | BEH-EA-036, BEH-EA-221 (impersonation list, `27-admin-impersonation.md:295`), BEH-EA-222 (`listUsers`) | `core/test/Users.test.ts`, `admin/test/AdminUsers.test.ts`, `admin/test/AdminTenants.test.ts`, `sql/test/UserStoreSql.test.ts` | LOW |
| Limit rule: truncate, clamp 1..200, default 50 when absent or non-finite; wire refuses outside 1..200 first | BEH-EA-036 "As shipped (limit rule)" | `core/test/Users.test.ts`, admin tests | LOW |
| Order per listing: users and organizations ASC `(createdAt,id)`; impersonation DESC `(startedAt,id)`; ties broken by id | BEH-EA-036, BEH-EA-221/222; REQ-EA-095 | `packages/test/src/internal/storeContract/users.ts`, `admin/test/contract/ImpersonationRecords.ts`, `organization/test/contract/OrganizationRecords.ts` | MEDIUM (memory comparators must keep matching each SQL `ORDER BY`) |
| Opaque cursor on the wire; malformed cursor is a 400 (REQ-EA-704); tenant visibility filter applied before paging (impersonation `TenantScoped.matches`) | BEH-EA-222, ESS-006 | `27-admin-impersonation.feature` (REQ-EA-703..705), `features/step-definitions/AdminSteps.ts`, `TenancyWorld.ts` | MEDIUM (tenant filter must run inside the module's input rows, not after paging) |
| Session listing: row-value cursor `("createdAt", id) > (?, ?)` served by `sessions_user_created_live`; `listLive` drains at fixed page size 200 and reports `truncated` | BEH-EA-036 refinements PPS-002 and ESR-010; BEH-EA-054 (`07-sessions.md`) | `sql/test/SessionStoreSql.test.ts`, `storeContract/sessions.ts`, `core/test/Sessions.test.ts` | MEDIUM (keep out of the page module or treat as a drain helper; see anti-features) |
| Public exports consumers use: `ImpersonationRecords.pageLimit`/`DEFAULT_PAGE_SIZE`, `UserStore.byCreation`, `SessionStore.byCreation`, the cursor types in `Users`, `Admin`, `AdminTenants` | `ports/src/UserStore.ts:184`, `ports/src/SessionStore.ts:264` | grep of consumers | LOW |

### Differentiators (the deepening can carry)

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| One memory comparator derived from the declared order, so a memory/SQL ordering mismatch is one test, not 4 | locality, closes the drift class | MEDIUM | The 4 hand comparators plus 7 more `toEpochMillis(a)-toEpochMillis(b)` sorts in records modules (DeviceClientRecords, MembershipRecords, ConnectionRecords, SamlRecords, ScimRecords, WebhookRecords, AccountStore) are the shared slice with candidate 7. |
| Pin id collation. The spec says "Memory adapters compare ids by code unit, as SQL does", but Postgres keyset sites compare `id` with no `COLLATE "C"`; only `AuditLogStoreSql.ts:132` and `RelayCursorStoreSql.ts:47` do | memory/SQL parity on Postgres for non-UUID ids | MEDIUM | UNVERIFIED as a live bug: uuid ids order identically under most collations. Needs `pnpm test:pg` to confirm; flag as a real finding to verify, not assume. |
| One limit clamp (`Users.listLimit` and `ImpersonationRecords.pageLimit` collapse; `AdminTenants` stops importing from `ImpersonationRecords`) | removes a cross-module import that exists only for the clamp | LOW | Lives naturally in `ports`. |
| One page contract (`{items, next}` built once) so `OrganizationRecords.listPage` stops pushing `+1` onto its caller | consistent port semantics | MEDIUM | Changes the `OrganizationRecordsShape.listPage` signature, covered by the organization records contract suite. |
| One cursor-schema factory for the 3 wire cursors | less schema boilerplate | LOW | Wire format must remain byte-identical. |

### Anti-features (do not do)

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Fold `MembershipRecords` paging in | It is offset/limit (`MembershipRecords.ts:209-213,493`); BEH-EA-036 says store ports must not take offsets, so this is a pre-existing spec tension, not a keyset site | Decide separately: either convert `members` to keyset (a wire change) or amend BEH-EA-036 to say "store ports" excludes plugin record stores |
| Fold SCIM list paging in | RFC 7644 mandates `startIndex`/`count`; `ScimRecords` offset-pages on purpose (BEH-EA-252, BEH-EA-349) | Leave it |
| Fold `SessionStore.listLive` in as a keyset page | It returns `{items, truncated}`, has no caller cursor, and its ordering rides a partial index | Share only the comparator, or leave it |
| Change cursor wire encoding or the 1..200 bound | Public wire contract (REQ-EA-703..705) | Keep byte-identical; add a golden test |

**Dependencies:** `ports` (UserStore, SessionStore memory adapters), `sql` (UserStoreSql, SessionStoreSql), `admin`, `organization`, `core/Users.ts`. No ADR blocks it; ADR-EA-041 decision 9 governs `RecordsContract`. Do this first (also seeds candidates 7's comparator slice). Overall complexity MEDIUM.

## Candidate 2: Connection-lifecycle module (SAML, organization/OIDC, SCIM)

**Real duplication (verified):** `claimed` wrapper in `SamlConnections.ts:211-231` and `OrganizationConnections.ts:423-443` (each only supplies the `onTaken` constructor); the active-organization gate; create/update/remove orchestration (claim-then-row on create and on update-with-domains; `withRelease` on remove). `DomainClaims.withClaim`/`withRelease` (`organization/src/DomainClaims.ts:210-239`) already own the transaction and the compensating release for the memory twin.

**Verified behavior differences between the two stores (decide, do not silently normalize):**

| Aspect | SAML | OIDC (organization) |
|--------|------|---------------------|
| Org gate on create | `directory.find` (a suspended org is accepted) | `directory.findActive` (suspended refused) |
| Org gate on update | none | `requireActiveOrganization` |
| Org gate on remove | none (`get` first) | none |
| Suspension handled | at login time (`Saml.ts:825` `findActive`) | at create, update and login |
| SCIM | n/a: `ScimConnections` has no domains, claims, transaction or update; login-time `findActive` only (`:143`) | |

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| An email domain belongs to one organization over any protocol; a clash is refused as that protocol's own domain-taken error (`SamlDomainTaken`, `ConnectionDomainTaken`) and changes nothing; the owner may route one domain over both protocols; a claim lives and dies with its connection and its organization | BEH-EA-317 (`29-saml-sp.md:270`) | `29-saml-sp.feature` (REQ-EA-1235..1237, 1306; scenario outline "Another organization cannot claim a domain", ~line 612), `SamlWorld.ts`, `SamlFederationSteps.ts`, `organization/test/DomainClaims.test.ts`, `saml/test/SamlDomainClaims.test.ts`, `SamlDomainClaimMigration.test.ts` | HIGH (security invariant: domain-takeover) |
| Claim and row are one unit: claim first so a taken domain is refused before any write; inside the caller's `SqlTransaction` both roll back; on the memory twin a failed write releases the claim or restores `previous` | BEH-EA-317 prose; `DomainClaims.withClaim` doc | `organization/test/DomainClaims.test.ts` (already pins this once at the `withClaim` level) | HIGH |
| Delete releases the claim in the same transaction; org deletion releases all claims (`releaseAllForOrganization`) | BEH-EA-317, `OrganizationDeletion.contribute` (`connectionsOnOrganizationDelete`, `SamlOrganizationDeletion`) | `saml/test/SamlOrganizationDeletion.test.ts`, `organization/test/OrganizationDeletion.test.ts` | MEDIUM |
| Suspended or missing organization is indistinguishable (MTI-009) | BEH-EA-237 (`28-tenancy.md:132`) | `28-tenancy.feature`, `30-scim.feature:50`, `TenancyWorld.ts` | MEDIUM |
| SAML connection admin: validation order, role-mapping ceiling, signing-key ensure, pinned certs, metadata import | BEH-EA-318, 316, 314 | `saml/test/SamlConnections.test.ts`, `SamlAdmin.test.ts`, `SamlRoleMapping.test.ts` | HIGH (per-protocol validation stays per-protocol) |
| Events and cache invalidation on OIDC writes (`map.invalidate`, `OrganizationConnection{Created,Updated,Deleted}Event`) | `OrganizationConnections.ts` | `organization/test/OrganizationConnections.test.ts` | MEDIUM |
| Public exports: `DomainClaims.*` (re-exported from `organization/index.ts:11` and `records.ts:23`), `SamlRecords.SamlDomainTaken`, `ConnectionRecords.ConnectionDomainTaken`, `OrganizationConnectionStore`, `SamlConnectionStore` shapes | barrels | grep | LOW |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| One `claimed`/`remove` orchestration taking a protocol descriptor `{protocol, onTaken, ...}`; delete the two `claimed` wrappers and one gate | locality for BEH-EA-317 | MEDIUM | `saml` already depends on `organization`, so the module lives in `organization` (matches the report). |
| One org-gate with one policy. Today SAML create accepts a suspended org and OIDC refuses it; SAML update/remove never check | closes a real protocol divergence | MEDIUM | This is a **behavior change** for SAML. Needs a decision and a scenario in `29-saml-sp.feature`; do not fold silently. Likely intended policy: `findActive` on create and update, none on remove (so a suspended org's connections can still be cleaned up). |
| Lifecycle ordering tested once at the module level instead of per protocol | test locality | LOW | `DomainClaims.test.ts` already covers `withClaim`; add a protocol-parametrized suite. |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Pull SCIM into the lifecycle module | SCIM has no domains and no claims; its connection is a revocable bearer token (BEH-EA-246) with `create/list/revoke` only | Leave `ScimConnectionStore`; at most share the active-org gate with `ScimAuthenticationLive` |
| Unify SAML and OIDC validation | Validation is the protocol-specific part (certificates, role ceilings, URL checks vs discovery/endpoints) | Module takes validation as a supplied function |
| Reword error messages | OIDC copies the SAML wording on purpose ("the organization does not exist"); wire errors are asserted in scenarios | Keep strings |

**Dependencies:** `organization/DomainClaims.ts`, `SqlTransaction` (ports), `OrganizationDirectory`, `ConnectionRecords`, `SamlRecords`. Memory twin has no real transaction, so the compensating-release path must stay. Needs `pnpm test:pg` if the SQL path changes (primary key on `organization_domain_owner` is the atomicity). Overall complexity HIGH (security invariant).

## Candidate 3: Test-host composer for BDD Worlds

**Re-scoped.** The "plugin list in, host out" composer exists: `TestAuth.layer(Auth.make([...]), options)` is `AuthHost.layer` over the test ports (BEH-EA-342, ADR-EA-044, ADR-EA-054). What is left in the Worlds:

- 5 intentional exemptions (header comment): `AuthenticationWorld`, `ContractStratumWorld`, `CsrfWorld`, `QadiBridgeWorld`, `TenancyWorld` (identity and connection stacks that are not `Auth.make` compositions).
- Repeated World scaffolding around `TestAuth.layer`: `lazyApp` cell in 11 Worlds, `TestClock` in 15, plus each World's observation/capture layer and named-actor state. `shared/Harness.ts` (123 lines) already holds `cheapArgon2id`, `awaitCondition`, `makeNamedRegistry`; `shared/FirstPartyComposition.ts` (40 lines) composes every first-party plugin for the events registry.
- `Layer.mergeAll/provide` counts (TenancyWorld 42, QadiBridgeWorld 39, AuthenticationWorld 39) are mostly fixture and middleware wiring in the exempt Worlds, not plugin composition.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| Each World's scenarios keep their exact Gherkin and results across 16 feature directories (`features/features/*`); `pnpm test:bdd` green; `pnpm spec:verify:strict` traceability intact | PROJECT.md constraints | `features/traceability.md` | HIGH (31 Worlds, 55 Steps files) |
| `TestAuth.layer` semantics: memory records, `TestMailbox`, permissive limiter, derived middleware, `UndeclaredEventPolicy: "die"`, SQL mode via `records: "sql"` | BEH-EA-193, 331, 332, 342, ADR-EA-049 | `packages/test/test/*` | HIGH |
| One lazy app per World, released with the scenario scope; served app lives as long as its scope | BEH-EA-351, 352 | `25-testing-harness.feature`, `packages/test/test/TestAuthApp.test.ts` | MEDIUM |
| Hand-wired exemptions stay hand-wired where the wiring is the thing under test (plan 08 rule) | `.planning/08-test-composition/PLAN.md:803` | header comments | LOW |
| `AWTHAQ_POSTGRES_URL` mode: Worlds run on Postgres unchanged (`awaitCondition`/`awaitStable` branch on it) | `shared/Harness.ts` | `pnpm test:pg` | MEDIUM |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| A World scaffold in `shared/` for the repeated tail: scenario scope + `lazyApp` + `TestClock` + capture/observation layer + named actors, over `TestAuth.layer` | shrinks 11 to 15 Worlds; the real remaining duplication | MEDIUM | Wraps `TestAuth`, does not replace it. Pairs with candidate 4 (the scaffold will want the split `app` and `composition` modules). |
| Fold `FirstPartyComposition` and any "every plugin" compositions into the scaffold | one place for the first-party list | LOW | |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| A second plugin-list-to-host composer in `features/` | Duplicates `TestAuth.layer`/`AuthHost.layer`; ADR-EA-044 says the host is one function over the static tuple | Extend `TestAuth.layer` options if a World needs something |
| Migrating the 5 exempt Worlds onto it | Their point is the wiring under test | Keep the exemption comment |

**Dependencies:** candidate 4 (split `TestAuth.ts` first or together), `@awthaq/test`, `features/step-definitions/shared/*`. Overall complexity MEDIUM, but the value is smaller than the report claims. Treat the original framing as refuted and re-scope in the roadmap.

## Candidate 4: Split `packages/test/src/TestAuth.ts` by concern

**Verified layout of the 1869 lines:** foundation exports and layer types ~150-420; `layer` overloads 388-422; sign-in/CSRF minting 430-540; `App`/`serve`/`listen`/`withApp`/`lazyApp` ~570-930; `buildContext`, `encryption`, `httpClient`, `throwingFramework` 931-975; `ContractTestOptions` 1002; `migratedSchema` 1160; `runPluginContractTests` 1417-1860; re-exports 1860+. `internal/` (contract, foundation, storeContract) and `TestSql.ts` (405 lines), `SealedConformance.ts`, `TenantConformance.ts` already exist as peers.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| The public namespace `TestAuth.*` is unchanged (`index.ts` does `export * as TestAuth from "./TestAuth.ts"`); ~270 files reference `TestAuth` (135 use `TestAuth.layer`, 67 use serve/app/withApp/lazyApp/listen, 25 `runPluginContractTests`, 24 sign-in/CSRF helpers) | `packages/test/src/index.ts` | whole suite | HIGH (blast radius). Keep `TestAuth.ts` as a thin facade of `export *`. |
| `TestAuth.layer` behavior, overloads and types (incl. `RecordsOption`, `ContractTestOptions`) | BEH-EA-193, 331, 332, 342 | `packages/test/test/*` | HIGH |
| `serve`/`lazyApp`/`withApp`/`listen` lifecycle: app lives exactly as long as its scope, `openApps()` leak counter | BEH-EA-333, 351, 352, 353 | `TestAuthApp.test.ts`, `25-testing-harness.feature` | MEDIUM |
| `signInAs`, `csrfToken`, `csrfSetCookie`, `sessionSetCookie` | BEH-EA-197 | `TestAuthMiddleware.test.ts`, many suites | MEDIUM |
| `runPluginContractTests` checks (manifest legality, migrations, records suites, tenant and sealed conformance) run for every first-party plugin | BEH-EA-198, 336 | each plugin's `test/Contract.test.ts` (25 files) | HIGH |
| `migratedSchema` output shape (locked by every `Schema.lock.test.ts`: organization, jwt, scim, api-key, passkey, device-authorization, admin, roles, qadi, webhooks, two-factor, saml) | plan 22 | those 12 files | MEDIUM |
| No new circular imports (`pnpm circular`); `internal/` stays internal | PROJECT.md | CI | MEDIUM (split files will import each other: composition to harness to contract) |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| 4 files by concern: composition (`layer`, `memoryFoundation`), session/CSRF minting, app harness (serve/listen/lazyApp), contract runner (+ `migratedSchema`) | a serve bug no longer sits beside a contract-runner bug | MEDIUM | Same barrel. |
| Move `migratedSchema` next to `TestSql` or the contract runner; it already composes `schemaOf` | one schema-reading home | LOW | Not an overlap to delete; it is a consumer. |
| Prune genuinely single-user exports | smaller interface | LOW | The report's example, `buildContext`, is NOT one. Re-grep each candidate export before pruning. |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Changing the `TestAuth.*` namespace shape or renaming exports | ~270 consumer files | Facade + `export *` |
| Deleting `buildContext` | documented in README, 3 call sites plus a test | Keep |

**Dependencies:** none upstream; candidate 3's scaffold wants it first. Overall complexity MEDIUM (mechanical but wide).

## Candidate 5: CLI plugin views behind `Output.report`; delete `ConfigList`

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| `plugin list`: ids in link order as `N. id`; `--graph` text; `--hooks`, `--rules`, `--events` tables; `--format text|json|dot`; DOT is `digraph awthaq {` ... `}` with one edge per `dependsOn` (dependency to dependent) | BEH-EA-202 (`26-cli.md:50`); BEH-EA-225 for `--json` | `packages/cli/test/Inspection.test.ts` (lines ~74-130), `features/features/08-tooling/26-cli.feature`, `CliSteps.ts` | MEDIUM |
| Exact JSON shapes per view: `graph(auth)` nodes (incl. `tenancy` described strings, `ports`, `exposes`, `hooks`), `HookChain[]`, `RuleRow[]` (window as `Duration.format`), `EventRow[]` | `Plugin.ts` | `Inspection.test.ts` | MEDIUM (consumers parse these) |
| `--format json` forces JSON even without `--json`; `--json` forces JSON whatever `--format` says, except that for the graph view `--format dot` is tested first and wins over `--json`; hooks/rules/events have no dot branch (`Plugin.ts:266-285`) | `Plugin.ts:266-285` | `Inspection.test.ts` | LOW but easy to get wrong; pin with a test first |
| Stdout is the result, stderr the failure; `--json` failure document carries `_tag` and exit code (BEH-EA-225); no secret values reach Output (BEH-EA-201, ECS-005) | `Output.ts` header | `ExitCodes.test.ts`, `26-cli.feature` | MEDIUM |
| `config list`: every descriptor with source, entries `path = value`, `<redacted>` for sensitive and `Redacted`, text line shape `owner  key  (source)` then `  path = value` | BEH-EA-229, 356 | `Doctor.test.ts:237`, `CliSteps.ts:329`, `26-cli.feature`, `admin/test/AdminConfig.test.ts` | MEDIUM |
| Public barrel: `index.ts:12` exports `ConfigList` today | `packages/cli/src/index.ts` | grep | LOW (pre-1.0, unpublished; update the barrel, `Doctor.test.ts:24`, spec 26-cli lines 46 and 398 in the same change) |
| `doctor`, `routes`, `migration status` already use `Output.report`; their output unchanged | `Doctor.ts:272`, `Routes.ts:82`, `Migration.ts:64` | `Doctor.test.ts`, `Migration.test.ts` | LOW |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| A view abstraction `{ data, text, dot? }` selected once from `format` plus `out.json`, so the format rule lives in one place | removes 4 copies of `options.format === "json" \|\| out.json` | MEDIUM | `Output.report` needs a `format` input (it only knows `out.json`). Put the format rule in the view module, not in `OutputShape`. |
| Move `Migration.apply` (`:88-117`) and `Openapi` (`:34`) onto the same seam | uniform `--json` handling, one capture adapter | MEDIUM | They emit mixed documents (`{pending, drift, applied}`); keep the shapes. |
| Delete `ConfigList`: `renderText` and `show` inline into `Cli.ts:152` or `Doctor.ts` (which already owns `configContext` and `descriptorsOf`) | removes a pass-through | LOW | Not "3 lines": about 9 lines plus a test import move. |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Make `OutputShape` aware of `--format` | Output is the writer; format choice is a command concern; widening the shared interface touches every command and the capture adapter | Format selection in the view module, `Output.report` for the json/text pair |
| Change any JSON shape or text column layout | scripted consumers (BEH-EA-225 promises data not prose) | Snapshot tests before refactor |

**Dependencies:** `Output.ts` (capture adapter reused by tests), `Doctor.configContext`. Low risk, no ADR. Overall complexity LOW-MEDIUM.

## Candidate 6: Single table catalogue (core/sql/cli)

**Re-scoped.** The data that exists in more than one place:
- `TenantScope.partitionedTables` (4) and `directoryTables` (2) in `sql` (the source of truth for RLS coverage, `TenantScope.coverage`).
- `core/Auth.ts:779` `coreTables` = those two lists concatenated, used once to accept a Derived table whose parent is a core table.
- `test/src/LaggingReplica.ts:31` `coreTables` = the same 6 names hand-copied.
- Plugin tables are already declared once per plugin (`AuthPlugin.tables` with tenancy) and exposed as `auth.tenancy`; the CLI formats them (`describeTenancy`).
- Core sealed columns (6) are declared once in `sql/CoreSealedColumns.ts`.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| `Auth.make` refuses: a Derived table with an unknown parent, a Global parent, a plugin that reads a table owned by a plugin not in its `dependsOn` (`UndeclaredTableDependency`) | BEH-EA-016 family; `Auth.ts:760-900` | `core/test/AuthPlugin.test.ts`, `TenantConfigScope.types.test.ts` | MEDIUM |
| `TenantScope.enableRls({plugins: auth.tenancy})` covers partitioned core tables, directory tables only on `includeDirectory`, Keyed only on `includeKeyed`, Derived via covered parent; fail-open when no tenant set; policy name `awthaq_tenant` | BEH-EA-231, 232; ADR-EA-018 | `sql/test`, `TenantConformance.ts`, `28-tenancy.feature`, `TenancySteps.ts` | HIGH (security backstop) |
| Package layering: `sql` (stratum 3) before `core` (stratum 4); no cycle | ADR-EA-041 decision 3; `pnpm circular` | CI | MEDIUM |
| Plugin `tenancy` declaration API (`AuthPlugin.Table.partitioned/keyed/derived/global`) and `auth.tenancy` shape; CLI `plugin list --graph` tenancy strings (`partitioned "tenantId"`, `derived via ... of ...`, `global: <reason>`) | `AuthPlugin.ts:327-344`, `Plugin.ts:57-69` | `Inspection.test.ts`, `Schema.lock.test.ts` per plugin | LOW |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| Export one `coreTables` (name, tenancy, owner) from `sql` and have `Auth.ts`, `LaggingReplica`, and `TenantScope.coverage` read it | removes the one real duplicate (LaggingReplica) and makes "a new core table touches one list" true | LOW-MEDIUM | Keep it in `sql`; ADR-EA-041 puts the core table DDL (`CoreMigrations`) there. |
| Move the tenancy formatter next to `TenantScoped.Tenancy` so the CLI and any other display reuse it | one description | LOW | Optional. |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| A catalogue in `core` read by `sql` | `sql` cannot depend on `core` (ADR-EA-041 alternative (a): package cycle `tsc -b` refuses) | Keep it in `sql` |
| Catalogue that also lists plugin tables | Plugin tables are declared by plugins and aggregated at `Auth.make`; a central list would reintroduce the "new plugin touches a core list" problem | Catalogue covers core tables only |
| Treat "core imports sql" as the defect | It is the documented layering | Leave |

**Dependencies:** ADR-EA-018, ADR-EA-041 (check before acting, as the report advised; the check says: leave placement in `sql`). Overall complexity LOW, and the whole candidate may reduce to deleting 2 hand copies. Roadmap should treat it as a small cleanup or drop it.

## Candidate 7: Shared record-store scaffolding (16 `*Records.ts`)

**Verified:** 16 files (`admin/ImpersonationRecords`, `api-key/{ApiKeyRecords,ApiKeyClientRecords}`, `device-authorization/{DeviceClientRecords,DeviceGrantRecords}`, `jwt/SigningKeyRecords`, `organization/{ActiveContext,OrgRole,Organization,Invitation,Membership,Connection,Team}Records`, `saml/SamlRecords`, `scim/ScimRecords`, `webhooks/WebhookRecords`), 10,575 lines. Each has Shape + Service + `layerMemory` (Ref/HashMap) + `layerSql`. Shared already: `SealedColumn`, `SqlModels.dialectFields`, `StoreFailure.orStoreUnavailable`, `SqlStore`, `TenantScoped`, `RecordsContract`.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| Memory and SQL adapters give identical answers for every operation; every operation carries a verdict (`read`, `write`, `atomic` with a `race` case, `exempt` with reason), and an operation without one does not compile | ADR-EA-041 decision 9, plan 25; BEH-EA-336, BEH-EA-334 (`records` bundles) | `packages/test/src/RecordsContract.ts`, each plugin's `test/contract/*`, `runPluginContractTests` | HIGH |
| Atomicity on Postgres: one `Ref.modify` in memory; one conditional statement or one `SqlStore.atomically(sql, key)` (advisory lock key `<table>:<scope>:<id>`) in SQL; a transaction alone is not atomicity under READ COMMITTED | ADR-EA-041 decision 9 | `pnpm test:pg` | HIGH |
| Tenant isolation and sealed-column conformance per store | plan 05, 17; BEH-EA-231 | `TenantConformance.ts`, `SealedConformance.ts` | HIGH |
| Error classification: outage is `StoreUnavailable` with the label `<Store>.<op>`; unique violations via `StoreFailure.isUniqueViolation`; decode failures are defects | ADR-EA-041 decision 5 | contract suites | MEDIUM |
| Each plugin's `records` bundle (`records.memory`, `records.sql`) and exported Shape/Service types; `Schema.lock.test.ts` stays byte-identical | BEH-EA-334 | 12 lock tests | MEDIUM |
| Domain bodies stay in each module (`takesLastOwner`, team forest, ledger links, etc.) | the report; ADR-EA-040 (domain in system modules) | domain tests | LOW |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| Shared memory table helper (`Ref<HashMap>` with `insert`, `modify`, `values`, ordered listing) | cuts the ~3.5k lines of memory twins' mechanical part | HIGH | The thin-share risk the report named is real: only 4 files use the plain `Ref.make(HashMap.empty)` shape; the rest hold multi-table state. Prototype on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords`, `DeviceGrantRecords` first. |
| Shared `(createdAt, id)` / `oldest first` comparators and the dialect row helper | closes the comparator-drift class (reported live drifts: members desc, team order, connection `emailDomains` order, per plan 24) | MEDIUM | Same slice as candidate 1. |
| Per-store `unavailable(op)` and `wire` boilerplate from one factory | less repetition | LOW | |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Replace memory twins with SQL over SQLite `:memory:` | Plan 24 Track A rejected it: the drift that matters is Postgres concurrency, which SQLite cannot reproduce | Keep two adapters under `RecordsContract` |
| A generic CRUD base class or repository layer | ADR-EA-041 decision 3/9: no repository layer; adapters own their statements | Helpers, not inheritance |
| Weakening or auto-generating the verdicts | They are the compile-time bar | Keep hand-written verdicts |

**Dependencies:** ADR-EA-040, 041, 054; candidate 1 (comparator slice) first. Overall complexity HIGH, value uncertain (MEDIUM). Do last of the structural candidates, after a spike on the 4 simple files.

## Candidate 8: Fold credential registry and source parsing in `server/Credentials.ts`

**Verified layout:** resolver 37-110; registry 117-260; source/carrier parsing 262-320; tiers 322-344; `make` 442-587; scopes (`httpScope`, `collecting`) 588-678. ADR-EA-042 (just landed) made this module the one credential-precedence implementation.

### Table stakes (preserve)

| Behavior | Source | Verified by | Complexity |
|----------|--------|-------------|------------|
| Precedence: impersonation cookie only when the session carries `actingAs`, session cookie, `x-api-key` on the machine tier, then bearer (claimed registry first, `Sessions` otherwise); an unresolved credential falls through; a store outage stops the chain with a 503 | ADR-EA-042; BEH-EA-065, 066, 072 | `server/test/Credentials.test.ts`, `Authentication.test.ts`, `09-authentication-middleware.feature`, `AuthenticationWorld.ts` | HIGH |
| Declared security-record order is the strategy chain; no second ordering mechanism | BEH-EA-072 | same | MEDIUM |
| Tier admission: user tier admits `User` only, machine tier admits any claimed principal | ADR-EA-042 decision 4; BEH-EA-066 | tests above | MEDIUM |
| Empty credential never resolves; bearer parsing equals `HttpApiBuilder.securityDecode(Api.BearerToken)` (RFC 9110) | BEH-EA-065 | parsing tests in `Credentials.test.ts` | LOW |
| Registry rules: ids unique per carrier (`DuplicateCredentialResolver`), registry frozen at first read (`CredentialResolversFrozen`, ADR-EA-012), `contribute(carrier, contribution)` is how jwt and api-key claim credentials | ADR-EA-012, 042 | `server/test/CredentialResolvers.test.ts`, `packages/jwt`, `packages/api-key`, `qadi/test/SubjectExtractor.test.ts`, `36-jwt.feature` | MEDIUM |
| Per-request single-flight memos (sessions and claimed credentials; one API-key throttle charge and one JWT verify per request across Path A and B) | ADR-EA-042 decision 6 | `Credentials.test.ts` parity table (23 request shapes x 3 tiers) | HIGH |
| Rotation hand-off through the carrier it came in on; `collecting` scope for web `getSession` | ADR-EA-042 decisions 2, 7 | `web` tests, `SessionLifecycle.test.ts` | HIGH |
| Public exports used elsewhere: `PrincipalResolver(Live, WithUserFactsLive)`, `CredentialResolvers(Live)`, `contribute`, `Carrier`, `Presented`, `Source`, `presented`, `fromRequest`, tiers, `make`, `httpScope`, `collecting`, `principalFields`; consumers `server/{Authentication,AuthHost,AuthHttp}`, `web/Session.ts`, `qadi/SubjectExtractor.ts`, `jwt`, `api-key`, `test/TestAuth.ts`, BDD `ResolveCredential.ts` | grep | build | MEDIUM |

### Differentiators

| Improvement | Value | Complexity | Notes |
|-------------|-------|------------|-------|
| Split into sibling modules behind `Credentials` (registry, source, tiers, scope) keeping one seam | locality; `make` stays the deep part | LOW-MEDIUM | This is a file split, not an interface change, so ADR-EA-042 is not reopened. |
| Move registry state into `internal/` (already exists in `server/src/internal`) | smaller public surface | LOW | Only if `contribute` and the Tag stay exported. |

### Anti-features

| Anti-feature | Why | Instead |
|--------------|-----|---------|
| Reopen ADR-EA-042 decisions (scope seam, per-scheme handlers, tier admission) | Landed days ago; parity table protects it | Park unless friction appears (the report's own advice) |
| Re-add copies per adapter | ADR-EA-042 alternative (d), rejected | Keep one seam |

**Dependencies:** ADR-EA-012, 042, 044. Overall complexity LOW-MEDIUM; lowest priority.

## Feature Dependencies

```
1 keyset page (comparators) --> 7 record scaffolding (shares the comparator slice)
4 split TestAuth --> 3 World scaffold (the scaffold wraps the split app/composition modules)
2 lifecycle module -- independent of 1,4,5,6,8; needs pnpm test:pg
5 CLI views -- independent
6 table catalogue -- independent, tiny; touches core/Auth.ts and test/LaggingReplica.ts
8 Credentials split -- independent, last
```

## MVP / Recommended order

1. Candidate 1 (keyset), re-scoped to users, impersonation, organizations; leave Membership and `listLive` out; resolve the collation question.
2. Candidate 2 (lifecycle), after deciding the SAML suspended-org policy; exclude SCIM.
3. Candidate 5 (CLI views), low risk, pin JSON shapes first.
4. Candidate 4 then 3 (re-scoped as a World scaffold).
5. Candidate 7 after a spike on 4 simple files; candidate 6 as a 2-line cleanup; candidate 8 last or park.

## Open questions for the roadmap

- BEH-EA-036 says no store port accepts an offset, yet `MembershipRecords` does. Amend the spec or convert the listing; decide before candidate 1 closes.
- SAML suspended-org policy on create/update (behavior change).
- Whether Postgres id collation drift is real (needs `pnpm test:pg`).
- Whether candidate 3 and 6 stay in the milestone given their premises mostly failed verification.

## Sources

- Code read directly: `packages/{ports,sql,admin,organization,saml,scim,core,cli,test,server,device-authorization}/src/*`, `features/step-definitions/*`.
- Spec: `spec/behaviors/05-persistence-stratum.md` (BEH-EA-036), `07-sessions.md`, `09-authentication-middleware.md`, `25-testing-harness.md` (BEH-EA-193..200, 331..357), `26-cli.md` (BEH-EA-201..229, 356), `27-admin-impersonation.md` (BEH-EA-221, 222), `28-tenancy.md` (BEH-EA-237), `29-saml-sp.md` (BEH-EA-314..318), `30-scim.md` (BEH-EA-246, 252, 348, 349); ADR-EA-018, 040, 041, 042, 044, 054; `.planning/08-test-composition/PLAN.md`, `.planning/24-memory-records-over-sqlite/PLAN.md`.
- Feature files: `features/features/01-contract-and-persistence/05-persistence-stratum.feature`, `03-http-layer/09-authentication-middleware.feature`, `08-tooling/{25-testing-harness,26-cli}.feature`, `09-admin-and-impersonation/27-admin-impersonation.feature`, `10-organization/35-organization.feature`, `11-jwt/36-jwt.feature`, `12-multi-tenancy/28-tenancy.feature`, `13-enterprise-federation/{29-saml-sp,30-scim}.feature`.
- All findings are HIGH confidence from direct code reading; the Postgres collation point is flagged unverified.
