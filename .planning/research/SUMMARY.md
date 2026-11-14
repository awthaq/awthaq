# Project Research Summary

**Project:** awthaq, milestone v1.0 Architecture Deepening (batch 3)
**Domain:** internal restructuring of an Effect v4 TypeScript auth monorepo (pre-1.0, unpublished)
**Researched:** 2026-11-14
**Confidence:** HIGH (code-verified), MEDIUM on the candidate 3, 6 and 7 ownership calls

## Executive Summary

This milestone resolves eight architecture-deepening candidates from a review report. The four researchers re-read the tree and found the report's premises only partly true. Two candidates were refuted or mostly refuted (#3 test-host composer, #6 table catalogue). Two were re-scoped (#1 keyset, #2 lifecycle). Four survive close to as stated (#4, #5, #7, #8), with corrections. Every candidate is a design problem over primitives that already exist. STACK found no new dependencies and no version changes. The repo runs `effect@4.1.2`, not the `rc.116` the brief names.

The recommended approach is to do the barrel-preserving locality moves first (#5, #4), then the shared low-stratum module (#1), then the behaviour-bearing consolidation (#2, #6), and to treat #3, #7 and #8 as gated or optional. Placement follows the strata rule (`api < ports < sql < core < server < qadi < plugins < cli/test/features`). Keyset goes in `ports`, with the SQL predicate in `sql`. The table catalogue stays in `sql`. The lifecycle module goes in `organization`. A module in the wrong stratum creates a package cycle that `tsc -b` refuses, and `pnpm circular` may not catch it.

The main risks are behaviour changes disguised as refactors, and gates that only run in CI. The SAML suspended-org policy, the cursor wire bytes and the Postgres id collation each change observable behaviour. There is no local Postgres (`docker` absent, `AWTHAQ_POSTGRES_URL` unset). C1, C2 and C7 must each land as a CI-verified branch before the next phase depends on it.

## Candidate verdicts (read this first)

| # | Candidate | Verdict | What changes from the report |
|---|-----------|---------|------------------------------|
| 1 | Keyset-page module | **Survives, re-scoped** | 3 listings, not 8+: users, organizations, impersonations. Exclude `MembershipRecords` (offset paging), `SessionStore.listLive` (`{items, truncated}`, no cursor; share the comparator at most), SCIM (RFC 7644 `startIndex`/`count`), audit log, webhook deliveries (single key). Also fold the three cursor codecs and three limit clamps. |
| 2 | Connection lifecycle | **Survives, re-scoped; SCIM dropped** | SCIM has no domains, claim, transaction or update. `DomainClaims.withClaim/withRelease` is already shared. Remaining duplicates: a 10-line `claimed` adapter per store, `normalizeDomains`, the org gate, three deletion contributions. SCIM at most shares the active-org gate and deletion hook. |
| 3 | Test-host composer | **Refuted as stated; demote** | `TestAuth.layer` already is the host (BEH-EA-342, ADR-EA-044). 5 Worlds are hand-wired on purpose. Only a World scaffold in `features/step-definitions/shared/` (scope, `lazyApp`, `TestClock`, capture layer) is real, covering 11 to 15 Worlds. Optional. A second plugin-list-to-host composer is an anti-feature. |
| 4 | Split `TestAuth.ts` | **Survives, 3 corrections** | Keep `TestAuth.ts` as a facade of `export *` (~270 consumers, no outside edits). `buildContext` has 3 call sites plus README, so do not delete it. `migratedSchema` consumes `TestSql.schemaOf`; it does not overlap it. |
| 5 | CLI views / delete `ConfigList` | **Survives** | `ConfigList` is a public barrel export, so deleting it is a breaking export (changeset with `Migration:`). The real leak is `--format json` vs global `--json`, OR-ed in `Plugin.show`. `Migration.apply` and `Openapi` also bypass `Output.report`. |
| 6 | Single table catalogue | **Mostly refuted; reduce to a small cleanup** | core importing sql is the ADR-EA-041 layering, not a defect. `describeTenancy` in cli is a formatter. Real defects: the hand-copied `coreTables` in `test/LaggingReplica.ts`, and the lists omit `auth_relay_cursor` and `rate_limit_buckets`. Catalogue stays in `sql`, core tables only, no column types (ADR-EA-004 IR boundary). |
| 7 | Record-store scaffolding | **Survives, gated, thin payoff** | 11 of 16 files have not adopted `SqlStore`; that is the real shared slice. Do not extract "memory table CRUD". Blocked on plan 24 Track A. Needs a no-go gate. |
| 8 | Fold credential registry | **File split only; last or park** | The registry is a public cross-package seam (`api-key`, `jwt`, `qadi`, `web`, `test` use `contribute`/`CredentialResolvers`; ADR-EA-012). It cannot go internal. ADR-EA-042 landed days ago; do not reopen it. |

## Key Findings

### Recommended Stack

No new dependencies, no version changes. Read sources from `node_modules/.pnpm/effect@4.1.2/...`, not the stale `rc.116` directory beside it. Imports have no `unstable/` segment (`effect/sql/SqlClient`, `effect/schema/Model`).

**Core technologies (all already present):**
- `effect` 4.1.2: `Stream.paginate`, `Order.Tuple/flip`, `Layer.mock/fresh`, `Data.taggedEnum` with `Match` cover keyset, lifecycle and test composition.
- `@effect-cucumber/vitest` 0.10.1: already provides `shared`/`perScenario`/`Rule` layer tiers. A "composer" is a function over `Layer.mergeAll/provideMerge`, not a library.
- `Output.report(value, render)`: the CLI seam already exists.

**Rejected:** `SqlModel.makeRepository` (only insert/update/findById/delete, unstable, adds a second persistence idiom), any FSM library, pagination helper packages, splitting `@awthaq/test` into packages, upgrading Effect/TS/oxlint.

**Tooling constraints for plans:** no `as` in `packages/*/src` (modules take accessor functions, not column-name strings). No `from "effect"` barrel imports. knip fails on orphaned files and exports. `pnpm circular` runs a type-inclusive second pass. `spec:verify:strict` applies. `pnpm test:pg` is required for SQL changes.

### Expected Features (behaviours to preserve)

**Must preserve (table stakes):**
- BEH-EA-036 keyset-only. No store port accepts an offset. Read `limit + 1`. An exactly-full final page invents no cursor. Clamp 1..200, default 50. Ties break by id. Users and organizations ASC, impersonation DESC.
- BEH-EA-317 domain-claim invariant: claim first, claim and row atomic, release with delete, one domain belongs to one org (domain-takeover security invariant).
- BEH-EA-237: suspended and missing organizations are indistinguishable.
- The `TestAuth.*` namespace is unchanged, and the 12 `Schema.lock.test.ts` files stay byte-identical.
- CLI JSON shapes and `--format`/`--json` precedence. On the graph view `dot` wins over `--json`. Hooks, rules and events have no dot branch.
- ADR-EA-042 precedence, tiers and per-request single-flight memos (23 request shapes x 3 tiers).
- `RecordsContract` verdict per operation. Every `*Shape` stays frozen.

**Differentiators the work can carry:**
- One memory comparator derived from the declared order (the slice shared by #1 and #7).
- One limit clamp, so `AdminTenants` stops importing from `ImpersonationRecords`.
- One page contract, so `OrganizationRecords.listPage` stops pushing `+1` onto its caller.
- One CLI view module that resolves format once.
- `LaggingReplica` reading the real core table list.

**Do not do:** SCIM paging or lifecycle, `listLive` as keyset, converting `MembershipRecords` (a wire change), replacing memory twins with SQLite `:memory:`, a generic CRUD base class, any cursor wire change without a changeset.

### Architecture Approach

A package depends only on lower strata. A module needed by both a `ports` memory adapter and a `sql` adapter can only live in `ports` or below. `core -> sql` is by design (ADR-EA-041 decision 3; the alternative was rejected as a cycle).

**Major components and owners:**
1. Keyset: page assembly, clamp and comparator in `ports/src/Keyset.ts` (plus the `surface:ports` block in `spec/overview.md`). Row-value predicate builder in `sql`. Optional cursor/limit schema factory in `api`.
2. Connection lifecycle: protocol-neutral exposed service in `organization` (ADR-EA-040), generic over the protocol's records and error type. `saml` and `scim` already depend on `organization`.
3. TestAuth split: modules under `packages/test/src/internal/` (composition, minting, app harness, contract runner). `TestAuth.ts` becomes a thin facade.
4. CLI views: a views module in `cli/src/` that selects format once. `Output` stays the writer.
5. Table catalogue (if kept): `sql/src/`, extending `TenantScoped.Tenancy`/`TableDeclaration`. cli gets it through core's manifest, not by promoting `sql` to a runtime dependency.
6. World scaffold (if kept): `features/step-definitions/shared/`, built on the public `@awthaq/test` barrel.
7. Credentials: files under `server/src/internal/`, with every `Credentials.*` name still on the public namespace.

### Critical Pitfalls

1. **Two `limit + 1` contracts exist (C1).** `UserStore` and `ImpersonationRecords` apply it in the store. `OrganizationRecords.listPage` leaves it to `AdminTenants`. A half-migrated adopter applies it twice or never. Make the store primitive own it, and change `OrganizationRecords` and `AdminTenants` in one commit.
2. **Memory vs Postgres id ordering (C1).** Memory compares by UTF-16 code unit. Postgres keyset sorts `id` by DB collation. Only `AuditLogStoreSql` and `RelayCursorStoreSql` use `COLLATE "C"`. Existing contract cases use single lowercase letters and cannot tell the orders apart. Make an explicit recorded decision. `COLLATE "C"` needs an index migration.
3. **Use the row-value cursor form, not the expanded `OR` form (C1).** The `OR` spelling loses the partial-index plan on sessions (PPS-002). The fragment must emit row values for same-direction orders and refuse mixed direction.
4. **The SAML vs OIDC org gate is a behaviour change (C2).** SAML create uses `directory.find` (a suspended org is accepted). OIDC uses `findActive`. Unifying changes SAML. `withClaim` takes claim rows then the connection row, while `withRelease` takes the reverse, a possible Postgres deadlock (inferred, not reproduced). Keep the memory-twin compensating `onError`. Take `SqlTransaction` as a service. Keep `onTaken` and the protocol error tags. Emit events outside the write unit.
5. **Silent surface breakage in "internal" splits (C4, C5, C8).** The facade must keep every `TestAuth.*` name (diff the export list). `plugin list --format json` must not regress to text after the `Output.report` swap (pin a mode x format matrix first). The credential registry must stay per-composition and frozen at first read.
6. **Gates that mislead.**
   - Cross-package tests run against gitignored built `lib/`, so run `tsc -b` before every cross-package vitest run.
   - knip does not flag stale exports reachable through `export * as X`.
   - The knip baseline is already dirty: 3 real unlisted deps in the sql fixture, plus `.reports/` and `.claude/` files.
   - `spec:verify:strict` fails on moved cited paths.
   - The changeset `fixed` group bumps all packages.

## Implications for Roadmap

The three research files give slightly different orders. This resolves them: cheap barrel-preserving moves first to set the pattern, C1 before everything that edits the same files, C2 before C7, C6 shrunk to a cleanup, C3 and C8 optional at the end. Seven phases plus one precondition.

### Phase 0 (precondition, not a code phase): record the open decisions
Before Phase 1 closes, write down: the knip baseline, the plan 24 Track A verdict, ADR-EA-046's fate, and the BEH-EA-036 amendment vs Membership conversion. See "Open user decisions".

### Phase 1: CLI views and `ConfigList` removal (C5)
**Rationale:** independent, cli-only, low risk. Fixes the real `--format`/`--json` leak. Establishes the changeset-with-`Migration:` routine.
**Delivers:** a views module; format resolved once; `ConfigList.ts` deleted (inlined into `Cli.ts` or `Doctor.ts`); `Migration.apply` and `Openapi` moved onto the same seam if cheap.
**Avoids:** Pitfalls 19 and 20. Write the mode x (text, `--format json`, `--json`, dot) test matrix first. Update `spec/behaviors/26-cli.md` lines 46 and 398 and bump its Revision. Write a changeset for the removed export.

### Phase 2: Split `TestAuth.ts` (C4)
**Rationale:** same barrel-plus-internal pattern, and it unblocks any World scaffold. File-disjoint from Phase 1, so it can run in parallel.
**Delivers:** 4-5 modules under `packages/test/src/internal/`; `TestAuth.ts` as a facade; `buildContext` kept; `migratedSchema` moved next to the contract runner and still calling `TestSql.schemaOf`.
**Avoids:** Pitfalls 17 and 18. Diff the exported name set before and after. Run `tsc -b` after each extraction. Keep the open-app counter beside `serve`/`openApps`. Keep the test file names the spec cites. Update only the implementation cells in `spec/behaviors/25-testing-harness.md` and `spec/traceability.md`.

### Phase 3: Keyset-page module (C1, re-scoped)
**Rationale:** the highest-value shared module, and a hard prerequisite for C7's memory half. It must precede C2 and C7 because it edits `OrganizationRecords` and `ImpersonationRecords`.
**Delivers:** `ports/src/Keyset.ts` (plus the `sql` predicate and an optional `api` schema factory). Users, organizations and impersonations adopt it. One clamp, one page contract, a byte-pinned cursor test, and page-order cases in `StoreContract`/`RecordsContract`.
**Addresses:** BEH-EA-036/221/222, REQ-EA-093..095, 703..705.
**Avoids:** Pitfalls 1-8 and 32.
- Requirements must list the exclusions: Membership, `listLive`, SCIM, audit, webhooks.
- The post-page admin gate stays in the caller.
- Delete `pageLimit`, `listLimit` and the stale `MAX_PAGE_SIZE` copies by grep, since knip will not flag them.
- `pnpm test:pg` in CI is mandatory.

### Phase 4: Connection-lifecycle module (C2, SAML + OIDC only)
**Rationale:** security-invariant work. Do it after the decisions are made and before C7 rewrites the connection records.
**Delivers:** an exposed service in `organization` (`OrganizationSystem.services`). One `claimed`/`remove` orchestration takes a protocol descriptor. `normalizeDomains` is shared. One org gate carries the decided policy. `DomainClaims` leaves the organization root export. A new BDD scenario goes in `29-saml-sp.feature`.
**Avoids:** Pitfalls 9-14.
- Memory failed-write test shows the claim is released.
- Postgres update-vs-remove race case (8-way), asserting outcome counts.
- A rolled-back claim emits no event.
- `check:error-tags` and `check:transactions` pass.
- The module is generic, with no `import type` of `SamlRecords` into organization.
- ADR-EA-040 gets a revision line.

### Phase 5: Core-table catalogue cleanup (C6, shrunk)
**Rationale:** small and independent. Worth doing only as a cleanup. Do it after Phase 1; the two share only `cli/Plugin.ts` at file level.
**Delivers:** one core-table list in `sql` (name, owner, tenancy, sealed) that `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` project from. Decide whether `auth_relay_cursor` and `rate_limit_buckets` belong. `describeTenancy` stays in cli.
**Avoids:** Pitfalls 21 and 22.
- Each entry has explicit attributes, so each current list is a pinned projection.
- No column types or DDL (ADR-EA-004 IR boundary).
- The `core -> sql` edge stays.
- A declaration-list snapshot protects sealed AADs.
- If only the `LaggingReplica` copy proves real, ship it as a two-line fix and close the candidate.

### Phase 6: Record-store scaffolding (C7), spike first with a no-go gate
**Rationale:** largest blast radius (16 files, 5 packages, the public template), thinnest guaranteed payoff, depends on C1 and C2, and is blocked on plan 24 Track A.
**Delivers (only if the spike pays):** shared comparators (from C1), tenant-visibility plumbing, `unavailable(op)` labelling, a dialect wire row helper, and the 11 `SqlStore` stragglers moved onto `SqlStore.make`. Prototype first on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` and `DeviceGrantRecords`.
**Avoids:** Pitfalls 23 and 24.
- No `*Shape` change.
- Every `layerMemory` stays a single `Ref<State>`.
- Lock-key strings and operation labels stay byte-identical.
- One read-modify-write primitive, never get-then-set.
- Abandon if fewer than ~5 files share a helper.
- Update `docs/plugin-authoring.md` and `examples/plugin-template/` last.

### Phase 7 (optional): World scaffold (C3, re-scoped) and Credentials file split (C8)
**Rationale:** both are low value or can be parked. C3 should follow C4. Consider running it after Phase 4, so the Worlds are recomposed once after SAML/SCIM/organization behaviour changes. C8 is a pure file split.
**Delivers:**
- C3: a `features/step-definitions/shared/` scaffold wrapping `TestAuth.layer`. Classify all Worlds first. Migrate none of the 5 exempt ones.
- C8: files under `server/src/internal/`, with the public `Credentials` namespace unchanged.

**Avoids:** Pitfalls 15, 16 and 25.
- Keep `LeakGuard` accounting and the compile-error-on-missing-plugin gate.
- Never re-provide `Mailer`/`SmsSender` (ADR-EA-054).
- Never derive host composition outside `TestAuth.layer`.

### Phase Ordering Rationale

- C1 precedes C7 (hard). C2 precedes C7 (both edit `SamlRecords`/`ConnectionRecords`). C4 precedes C3 (soft). C5 and C6 overlap only on `cli/Plugin.ts`. C8 and C6 are independent.
- Phases 1 and 2 are file-disjoint and can run in parallel. Every later phase should be a branch that CI verifies on Postgres before the next builds on it.
- Phase 7 is droppable. If scope must shrink, cut C3 and C8 first, then C6 to its two-line fix, then C7 after the spike.

### Research Flags

Needs `/gsd-plan-phase --research-phase`:
- **Phase 3 (C1):** collation decision, `limit + 1` contract choice, sub-millisecond timestamp case. Needs a Postgres run to verify.
- **Phase 4 (C2):** policy decisions, the lock-order deadlock hypothesis, event placement. Security-critical.
- **Phase 6 (C7):** spike with go/no-go, and the plan 24 Track A dependency.

Standard patterns (skip research):
- **Phase 1 (C5):** the `Output.report` seam exists. Pin tests, then refactor.
- **Phase 2 (C4):** the barrel-plus-`internal/` pattern is already in the package.
- **Phase 5 (C6):** small, but the planner should re-grep before widening past `LaggingReplica`.
- **Phase 7 (C8):** file split with a frozen public surface. C3 only needs a per-World classification table.

## ADR and spec revisions needed

| Document | Change | Triggered by |
|----------|--------|--------------|
| ADR-EA-040 | New revision line: `DomainClaims` is a records store reached through the organization root export. The lifecycle module becomes the exposed owner, and `DomainClaims` leaves the root export. | C2 |
| ADR-EA-041 | Revision note: plan 24 Track A closed (precondition for C7). Keyset/memory scaffolding in `ports` follows decision 3 placement. | C1, C7 |
| ADR-EA-046 | Reserved for plan 24. Decide use or release before C7. Check `.planning/README.md` reservations and `spec/decisions/index.yaml` for the next free number (highest file is 057). | C7 |
| ADR-EA-018 / 019 | Revision notes if the catalogue becomes the single table list. | C6 |
| ADR-EA-004 | No change. State in the C6 plan that the catalogue may not grow column types or DDL (the retired IR). Note any keyset wording change. | C1, C6 |
| ADR-EA-042 | Not reopened. Revise only if a public `Credentials.*` name changes. | C8 |
| BEH-EA-036 | Amend: either "store ports" excludes plugin record stores (Membership offset), or Membership converts to keyset. Add the collation decision. | C1 |
| BEH-EA-237, 318 (`29-saml-sp.md`), `30-scim.md`, `35-organization.md` | Amend per the SAML suspended-org decision. | C2 |
| `26-cli.md` (lines 46, 398), BEH-EA-202/225/229 | Update the `ConfigList.ts` cites. Bump Revision and Change History together. | C5 |
| `25-testing-harness.md`, `spec/traceability.md` | Update implementation cells citing `TestAuth.ts`. Keep the cited test file names. | C4 |
| `spec/overview.md` `surface:ports` block | Add `Keyset` (drift check 13). | C1 |

Every package-visible change needs a changeset with a `Migration:` line (ADR-EA-034). Breaking exports to announce: `ConfigList` (C5), the `DomainClaims` root export (C2), any cursor wire change (C1). Write one changeset per candidate, not one for the milestone.

## Open user decisions

Each has a default.

1. **SAML suspended-org policy (blocks Phase 4).**
   - Today SAML create accepts a suspended org (`find`), OIDC refuses (`findActive`), SAML update/remove never check, and OIDC update does.
   - Default recommendation: `findActive` on create and update for both protocols, no check on remove, so a suspended org's connections can still be cleaned up.
   - This is a SAML behaviour change. It needs a failing scenario first, a BEH-EA-237/318 amendment and a changeset.
   - The alternative is to keep both and pass the gate as a module parameter.
   - Also decide the SCIM `createConnection` orphan case. It checks nothing and can create a connection for a nonexistent org.
2. **Cursor wire format (blocks Phase 3).**
   - The impersonation cursor uses `startedAt`. Users and organizations use `createdAt`.
   - Default: keep per-listing field names and byte-identical cursors, proven by a golden test against today's three schemas. Do not move to opaque tokens.
   - A unified field name or opaque token is a wire break and needs a changeset and a BEH-EA-036 revision. The project is unpublished, so it is allowed, but make it a deliberate choice.
3. **Postgres id collation (blocks Phase 3 design).**
   - Unverified as a live bug. UUIDv7 ids sort identically under most collations. It is real for `migrate-*` imports or custom `Ids`.
   - Option (a): declare keyset ids collation-stable by construction, enforce via a brand or contract, and add a mixed-case parity case under `test:pg`.
   - Option (b): `COLLATE "C"` plus an index migration (`sessions_user_created_live` is the index at stake).
   - Default: (a), unless CI shows drift.
4. **Plan 24 Track A gate (blocks Phase 6).**
   - The "SQL over SQLite `:memory:` as memory adapter" spike would delete every `Ref` twin that C7 scaffolds.
   - Plan 25, ADR-EA-041 decision 9 and the feature research all say keep two adapters, because SQLite cannot reproduce Postgres races.
   - Recommendation: record "Track A closed" as an ADR-EA-041 revision note and decide ADR-EA-046's fate before any C7 work.
   - If Track A stays alive, drop C7 from this milestone.
5. **BEH-EA-036 vs `MembershipRecords` offset paging (blocks Phase 3 close).**
   - The spec says no store port accepts an offset, but Membership does. Plan 24 recorded this as a known contradiction.
   - Default: amend the spec to scope "store ports" to core ports and leave Membership alone. Converting it is a wire change.
6. **Scope of C3 and C6 (before roadmap).**
   - Both premises mostly failed.
   - Default: keep C6 as a Phase 5 cleanup that may collapse to a two-line fix. Keep C3 only as an optional re-scoped World scaffold.
   - Also decide whether the generic half belongs in `@awthaq/test` (package suites in `packages/*/test` repeat the pattern) or stays in `features/shared`. The safe default is features-only.
7. **`plugin list --format` semantics (Phase 1, minor).** Confirm that `--format dot` keeps beating `--json` on the graph view, and that hooks/rules/events stay text-only for dot. Default: preserve exactly and pin with tests.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Read from installed `effect@4.1.2` sources, lockfile and workspace catalog. Not executed: no `pnpm test`, `circular` or knip run in STACK. |
| Features | HIGH / MEDIUM | HIGH for code verification (every site read). MEDIUM for BEH-to-feature mapping (spec grepped, not every scenario read). The Postgres collation point is unverified. |
| Architecture | HIGH / MEDIUM | HIGH on dependency direction, ADR text and existing seams. MEDIUM on ownership for C3, C6 and C7, each with a named open decision. |
| Pitfalls | HIGH / MEDIUM | HIGH for file-grounded findings. MEDIUM for inferred hazards (C2 lock-order deadlock, knip missing namespace exports). No local Postgres, so Postgres-only hazards are unreproduced. |

**Overall confidence:** HIGH that the candidate verdicts and build order are right. MEDIUM on payoff estimates for C7 and C3.

### Gaps to Address

- **Counts disagree between researchers.** `TestAuth.layer` is cited in 101, 103 and 135 files. `layerMemory` appears 55 and 116 times. Worlds using `TestAuth.layer` are cited as 28/31 and 37. Methods differ, conclusions agree. Re-grep at plan time.
- **Postgres-only behaviour is unverified here** (collation, advisory locks, deadlock, `TIMESTAMPTZ` row-value, RLS). Phases 3, 4 and 6 must land through CI and record "not run locally".
- **`@effect-cucumber/vitest` runtime semantics** are known from the README only. Shared Layers are built with `Effect.orDie` before `TestClock` exists, so clock-dependent services must not go in `shared`.
- **The generic test composer's home** (`@awthaq/test` vs `features/shared`) is undecided (decision 6).
- **The knip baseline in `IMPLEMENTING.md` is stale.** There are 3 real unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`, plus `.reports/` and untracked `.claude/` files. Record the baseline before Phase 1. Do not "fix" it by adding `@awthaq/core` to sql, which is the cycle.
- **`IMPLEMENTING.md` has stale paths** (`effect-auth`, branch `architecture/deepening-plans`). Follow its conventions (no `as`, replace-don't-layer, gate list), not its paths.
- **Per-phase gates:** run `pnpm coverage` after each dedup (global floors 89/83/84/90, plus per-package floors). Run `tsc -b` before any cross-package test run.

## Sources

### Primary (HIGH confidence)
- Installed Effect sources: `node_modules/.pnpm/effect@4.1.2/node_modules/effect/src/` (`Stream`, `Layer`, `Order`, `Schema`, `sql/Statement`, `sql/SqlModel`)
- `@effect-cucumber/vitest@0.10.1` README
- Repo code at `efb5e653`: `packages/{ports,sql,core,server,organization,saml,scim,admin,cli,test}/src/*`, `features/step-definitions/*`
- Spec: `spec/decisions/` ADR-EA-004, 010, 012, 018, 019, 023, 024, 027, 028, 034, 037, 040, 041, 042, 044, 045, 049, 054. `spec/behaviors/` 05, 07, 09, 25-30. `spec/overview.md`, `spec/traceability.md`, `spec/scripts/check-drift.mjs`
- Process: `.planning/{PROJECT,IMPLEMENTING,README}.md`, `.planning/24-memory-records-over-sqlite/PLAN.md`, `.planning/25-record-store-contract/PLAN.md`, `.planning/40-residue/PLAN.md`, `.planning/08-test-composition/PLAN.md`
- Gates executed in PITFALLS: `pnpm knip` (dirty baseline), `pnpm circular` (passes), `docker info` (unavailable)

### Secondary (MEDIUM confidence)
- Review report `architecture-review-20261114.html`. It supplied the candidate definitions. Its counts are unverified grep counts and several claimed sites were refuted.

### Tertiary (LOW confidence)
- None used. Inferred hazards (C2 lock order, knip namespace blind spot) are flagged as unreproduced in the text.

Detail: `.planning/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`.

---
*Research completed: 2026-11-14*
*Ready for roadmap: yes, after open decisions 1-5 are answered. Decisions 1 and 4 gate their phases. The rest have safe defaults.*
