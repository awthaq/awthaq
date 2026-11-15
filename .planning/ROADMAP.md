# Roadmap: awthaq

## Milestones

- 🚧 **v1.0 Architecture Deepening, batch 3** - Phases 1-7 (in progress)

## Overview

This milestone resolves the eight deepening candidates from the 2026-11-14 architecture review, choosing the cleanest end state. Research re-read the tree and found the report's premises only partly true: two candidates were refuted or mostly refuted (test-host composer, table catalogue), two were re-scoped (keyset, connection lifecycle), and four survive near as stated. The journey runs cheap barrel-preserving locality moves first (CLI views, `TestAuth` split) to set the changeset and gate routine, then the shared low-stratum keyset module, then the behaviour-bearing connection-lifecycle consolidation, then the shrunk table-list cleanup, then the gated record-store scaffolding behind a spike and no-go decision, and finally the optional World scaffold and `Credentials` file split. Placement follows the strata rule (`api < ports < sql < core < server < qadi < plugins < cli/test/features`). Phases 3, 4 and 6 touch SQL and must land as CI-verified branches (there is no local Postgres).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: CLI views and ConfigList removal** - One views module resolves `--format`/`--json` once; `ConfigList` deleted; gate baseline recorded (completed 2026-11-14)
- [x] **Phase 2: Split TestAuth** - `TestAuth.ts` becomes a facade over `internal/` modules with an identical public name set (completed 2026-11-14)
- [x] **Phase 3: Keyset-page module** - One page contract, clamp, cursor derivation and comparator for users, organizations and impersonations (completed 2026-11-14)
- [x] **Phase 4: Connection-lifecycle module** - SAML and OIDC share one exposed lifecycle service in `organization` with a single suspended-org policy (completed 2026-11-14)
- [x] **Phase 5: Core-table list cleanup** - One core-table list in `@awthaq/sql` projected to `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` (completed 2026-11-14)
- [x] **Phase 6: Record-store scaffolding (gated)** - Preconditions recorded, spike with go/no-go, scaffolding only if the spike pays (completed 2026-11-15)
- [ ] **Phase 7: World scaffold and Credentials split (optional)** - Shared World tail scaffold in `features/` and a pure file split of `server/Credentials.ts`

## Phase Details

### Phase 1: CLI views and ConfigList removal
**Goal**: Maintainers render every `plugin` view through one views module that resolves output format once, and the gate baseline is recorded so every later phase is checked against it.
**Depends on**: Nothing (first phase)
**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04, GATE-01, GATE-02, GATE-03
**Success Criteria** (what must be TRUE):
  1. The knip baseline (3 unlisted deps in `packages/sql/test/fixtures/readme-quickstart.ts`, `.reports/`, untracked `.claude/`) is recorded before any code change, and `tsc -b`, `pnpm test`, `pnpm test:bdd`, `pnpm circular`, `pnpm spec:verify:strict`, `pnpm check:error-tags`, `pnpm check:transactions`, `pnpm coverage` and `pnpm knip` pass against it at phase close.
  2. A test matrix over mode x (text, `--format json`, `--json`, dot) for the hooks, rules, events and graph views is committed passing against the pre-refactor code, and passes unchanged afterwards (graph: `dot` beats `--json`; hooks, rules and events have no dot branch; `--format json` does not regress to text).
  3. All four `plugin` views render through one views module that resolves `--format` and `--json` once, with output identical to today.
  4. `ConfigList` is absent from the package export and the tree, a changeset with a `Migration:` line exists, and `spec/behaviors/26-cli.md` (lines 46 and 398) is updated with Revision and Change History bumped together.
  5. `Migration.apply` and `Openapi` write through the same `Output` seam wherever that costs no behaviour change, proven by their existing tests passing unmodified.
**Plans**: 4/4 plans complete
Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Wave 0: gate baseline (01-BASELINE.md) and pre-refactor pins (PluginViews.test.ts matrix, openapi, migration apply, config list)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-02-PLAN.md — Views module: Output.report `{ json }` override, PluginViews.ts, every plugin view through it
- [x] 01-03-PLAN.md — ConfigList inlined into Cli.ts and removed; Openapi and Migration.apply on the Output seam

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-04-PLAN.md — Changeset with Migration line, 26-cli.md and traceability.md revisions, phase-close gates vs baseline
**Research**: skip (the `Output.report` seam already exists; pin tests, then refactor)

### Phase 2: Split TestAuth
**Goal**: `packages/test/src/TestAuth.ts` is a thin facade over concern-scoped modules, with the exported surface and leak accounting untouched.
**Depends on**: Nothing (file-disjoint from Phase 1; the two may run in parallel)
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04
**Success Criteria** (what must be TRUE):
  1. The exported `TestAuth.*` name set diffed before and after the split is identical, and no consumer file (a file that imports `TestAuth` or `@awthaq/test`) outside `packages/test` needs an edit. The two core census tests that source-scan `TestAuth.ts` are not consumers; only their four `file:` path literals change (02-CONTEXT.md decision).
  2. `packages/test/src/internal/` holds separate modules for composition, session/CSRF minting, app harness and contract runner; `buildContext` is still exported and `migratedSchema` still calls `TestSql.schemaOf`.
  3. The open-app counter lives beside `serve`/`openApps`, and `LeakGuard` accounting is unchanged: the existing `LeakGuard` tests and the 13 `Schema.lock.test.ts` files pass without edits.
  4. `spec/behaviors/25-testing-harness.md` and `spec/traceability.md` cite the new implementation locations while keeping the cited test file names, and `pnpm spec:verify:strict` passes.
**Plans**: 5/5 plans complete
Plans:
**Wave 1**
- [x] 02-01-PLAN.md — Wave 0: surface snapshot (02-SURFACE-BEFORE.txt), gate baseline (02-BASELINE.md), TestAuthSurface.test.ts pin (23 values, 24 types)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 02-02-PLAN.md — internal/composition.ts extracted; foundation types moved to internal/foundation.ts; census `file:` line moved

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 02-03-PLAN.md — internal/session.ts (sign-in, CSRF minting, withRequest) and internal/appHarness.ts (counter beside serve/openApps); census `file:` lines moved

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 02-04-PLAN.md — internal/contractRunner.ts (buildContext exported, migratedSchema via TestSql.schemaOf); facade reduced to named re-exports; AFTER probe diff empty

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 02-05-PLAN.md — 25-testing-harness.md, traceability.md, invariants.md citations and revisions; allowlist diff and phase-close gates vs baseline
**Research**: skip (the barrel-plus-`internal/` pattern already exists in the package; run `tsc -b` after each extraction)

### Phase 3: Keyset-page module
**Goal**: Users, organizations and impersonations page through one keyset module with one page contract, byte-identical cursors, and Postgres-verified ordering.
**Depends on**: Phase 1 (gate baseline and the changeset-with-`Migration:` routine; no code dependency)
**Requirements**: KEY-01, KEY-02, KEY-03, KEY-04, KEY-05, KEY-06, KEY-07, KEY-08, GATE-04
**Success Criteria** (what must be TRUE):
  1. A keyset-page module in `@awthaq/ports` owns the limit clamp (1..200, default 50), `limit + 1` handling, next-cursor derivation and the in-memory comparator; users, organizations and impersonations list through it, and `OrganizationRecords.listPage` and `AdminTenants` change in one commit so `limit + 1` is applied exactly once. The post-page admin gate stays in the caller.
  2. A golden test pins cursors byte-identical per listing against today's three schemas (impersonation `startedAt`, users and organizations `createdAt`).
  3. A SQL row-value predicate builder in `@awthaq/sql` replaces the expanded-`OR` spellings and rejects mixed-direction orders, shown by a test.
  4. `StoreContract`/`RecordsContract` page-order cases (ties by id, exactly-full final page, sub-millisecond timestamps, mixed-case ids) pass on memory and on Postgres, `pnpm test:pg` passes in CI, and the phase records "not run locally".
  5. A grep finds no remaining `pageLimit`, `listLimit` or stale `MAX_PAGE_SIZE` copies; Membership offset paging, `SessionStore.listLive`, SCIM paging, audit log and webhook deliveries are untouched (empty diff); `spec/overview.md` `surface:ports` lists the module, BEH-EA-036 is amended to scope "store ports" to core ports, and keyset id ordering is declared collation-stable by construction.
**Plans**: 9/9 plans complete
Plans:
**Wave 1**
- [x] 03-01-PLAN.md — Wave 0: gate baseline (03-BASELINE.md) with KEY-06 grep baseline, KEY-07 path list and "not run locally"; KeysetCursors.test.ts golden pinned to today's code

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 03-02-PLAN.md — Wave 0: KeysetPins.test.ts domain pin matrix and KeysetHttp.test.ts wire pins; Wave 0 head recorded

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 03-03-PLAN.md — `Keyset` module in ports (spike first): paginate, window, limit; barrel and `surface:ports` (overview Rev 1.18); unit tests

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 03-04-PLAN.md — `KeysetSql` row-value seek in sql; mixed-direction refusal; memory-SQL agreement on TestSql

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 03-05-PLAN.md — users adopt Keyset (UserStore, UserStoreSql, Users.list; `next` renamed `nextCursor`); StoreContract KEY-05 cases

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 03-06-PLAN.md — organizations adopt Keyset; OrganizationRecords, OrganizationDirectory and AdminTenants in one commit; contract cases; golden append

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 03-07-PLAN.md — impersonations adopt Keyset; LimitSchema on Keyset bounds; KEY-06 grep at 0; active and tenant paging contract cases

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 03-08-PLAN.md — BEH-EA-036 amended (Rev 1.14), traceability (Rev 1.91), Migration changeset for six packages

**Wave 9** *(blocked on Wave 8 completion)*
- [x] 03-09-PLAN.md — phase close: allowlist, KEY-07 empty diff, oracle integrity, full gates vs baseline, open CI (Postgres) confirmations
**Research**: recommended (collation decision, `limit + 1` contract, sub-millisecond timestamp case; needs a Postgres run)

### Phase 4: Connection-lifecycle module
**Goal**: SAML and OIDC connections are created, updated and removed through one exposed organization service that keeps domain claims atomic and applies one decided suspended-organization policy.
**Depends on**: Phase 3 (both edit `OrganizationRecords`; keyset must land and be CI-verified first)
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-04, CONN-05, CONN-06
**Success Criteria** (what must be TRUE):
  1. Creating or updating a SAML or OIDC connection for a suspended organization is refused, while removing one still works. A failing scenario in `29-saml-sp.feature` landed first and now passes, BEH-EA-237/318 are amended, and suspended and missing organizations remain indistinguishable.
  2. Claim-then-connection-write is atomic (BEH-EA-317): a failed connection write releases the claim in the memory twin, a rolled-back claim emits no event, and deleting a connection or an organization releases its domains.
  3. A Postgres update-vs-remove race case asserts outcome counts and passes in CI, recorded as "not run locally".
  4. `DomainClaims` is no longer exported from the organization root, `organization` imports no SAML types, protocol error tags and `onTaken` are preserved, and `pnpm check:transactions` and `pnpm check:error-tags` pass; ADR-EA-040 carries a revision line and a changeset with a `Migration:` line exists.
  5. SCIM is unchanged except for the shared active-organization gate and deletion hook, and the SCIM `createConnection` orphan case is recorded as a finding.
**Plans**: 9/9 plans complete
- [x] 04-01-PLAN.md
- [x] 04-02-PLAN.md
- [x] 04-03-PLAN.md
- [x] 04-04-PLAN.md
- [x] 04-05-PLAN.md
- [x] 04-06-PLAN.md
- [x] 04-07-PLAN.md
- [x] 04-08-PLAN.md
- [x] 04-09-PLAN.md
**Research**: recommended (security-critical: policy, lock-order deadlock hypothesis, event placement)

### Phase 5: Core-table list cleanup
**Goal**: One core-table list in `@awthaq/sql` is the single source that the three existing hand-maintained lists project from.
**Depends on**: Phase 1 (the two phases overlap only at file level on `cli/Plugin.ts`)
**Requirements**: CAT-01, CAT-02, CAT-03, CAT-04
**Success Criteria** (what must be TRUE):
  1. A single list of core tables (name, owner, tenancy, sealed) exists in `@awthaq/sql`, and `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` each derive from it; a test shows each projection equals the list it replaces.
  2. `auth_relay_cursor` and `rate_limit_buckets` are each either included or excluded with a documented reason.
  3. The catalogue carries no column types or DDL (ADR-EA-004), the `core -> sql` package edge is unchanged (`pnpm circular` passes, no new dependency), and a declaration-list snapshot protects the sealed AADs.
  4. A re-grep at planning time confirms which duplicates are real; if only the `LaggingReplica` copy is, it ships as a minimal fix and the candidate is closed with that disposition recorded.
**Plans**: 6/6 plans complete
- [x] 05-01-PLAN.md
- [x] 05-02-PLAN.md
- [x] 05-03-PLAN.md
- [x] 05-04-PLAN.md
- [x] 05-05-PLAN.md
- [x] 05-06-PLAN.md
**Research**: skip (re-grep before widening past `LaggingReplica`)

### Phase 6: Record-store scaffolding (gated)
**Goal**: The repeated record-store scaffolding is consolidated only if a spike proves enough files share a helper; otherwise the candidate is closed with a recorded no-go.
**Depends on**: Phase 3 and Phase 4 (hard: C1 comparators feed the memory half, and C2 rewrites the connection records first)
**Requirements**: REC-01, REC-02, REC-03, REC-04
**Success Criteria** (what must be TRUE):
  1. Before any scaffolding code is written, an ADR-EA-041 revision note records plan 24 Track A as closed and ADR-EA-046's fate (use or release) is decided in `spec/decisions/`.
  2. A spike on `DeviceClientRecords`, `ApiKeyClientRecords`, `ApiKeyRecords` and `DeviceGrantRecords` produces a written go/no-go, and the call is no-go if fewer than about 5 files share a helper.
  3. On go, shared comparators, tenant-visibility plumbing, `unavailable(op)` labelling, a dialect wire row helper and `SqlStore.make` adoption replace the repeated scaffolding with no `*Shape` change: `RecordsContract` verdicts per operation pass unchanged, every `layerMemory` keeps today's `Ref` count (`ImpersonationRecords` keeps its two `Ref`s and a `Semaphore`), and lock-key strings and operation labels are byte-identical.
  4. On go, `docs/plugin-authoring.md` and `examples/plugin-template/` are updated last and their tests pass; the Postgres legs run locally on the Debian `postgres:16` image and are recorded as "CI confirmation open (no git remote)".
  5. On no-go, the phase closes with REC-03 and REC-04 recorded as not pursued and the reason written down; no scaffolding code lands.
**Plans**: 12/12 plans complete
- [x] 06-01-PLAN.md
- [x] 06-02-PLAN.md
- [x] 06-03-PLAN.md
- [x] 06-04-PLAN.md — F-06-01 fix: scope the advisory-waiter count in the Phase 4 race test to its lock key
- [x] 06-05-PLAN.md — Wave 0 pins: operation labels, Ref/Semaphore counts, lock keys, emitted `.d.ts` hashes
- [x] 06-06-PLAN.md — Wave 0 pins: equal-`createdAt` tie cases for the comparator adopters
- [x] 06-07-PLAN.md — `StoreFailure.labelled` and its adoption, device-authorization, api-key, jwt, admin
- [x] 06-08-PLAN.md — `StoreFailure.labelled` adoption, organization, saml, scim, webhooks
- [x] 06-09-PLAN.md — `Keyset.chronological` and its adoption, device and api-key
- [x] 06-10-PLAN.md — `Keyset.chronological` adoption, organization, saml, scim, webhooks
- [x] 06-11-PLAN.md — docs and template check, spec rows, changeset
- [x] 06-12-PLAN.md — phase close: gates on SQLite and Postgres, census, REC-03 closure
**Research**: recommended (spike with go/no-go; plan 24 Track A dependency)

### Phase 7: World scaffold and Credentials split (optional)
**Goal**: The BDD Worlds that repeat the shared host tail use one scaffold over `TestAuth.layer`, and `server/Credentials.ts` is split into files with its public namespace frozen. Droppable: cut this phase first if scope must shrink.
**Depends on**: Phase 2 (the World scaffold builds on the split `TestAuth`) and Phase 4 (so the Worlds are recomposed once after the organization/SAML behaviour changes)
**Requirements**: WORLD-01, WORLD-02, CRED-01
**Success Criteria** (what must be TRUE):
  1. A table classifies every World as scaffolded or exempt, and a scaffold in `features/step-definitions/shared/` composing with `TestAuth.layer` (not re-wrapping it) supplies the one repeated tail piece, the `AuthEvents` capture layer (`lazyApp` and `TestClock` are already single `TestAuth` calls/options), to the Worlds that repeat it (census: Admin, Password, Domain); `pnpm test:bdd` passes with the same scenario count.
  2. The five hand-wired exempt Worlds are untouched, no second host composer exists, `LeakGuard` accounting is unchanged, and omitting a required service from a scaffolded World (measured on `DomainWorld`: dropping `NoBreachHttpClient` from `services` fails at `TestAuth.serve`) is still a compile error.
  3. `server/src/Credentials.ts` is split into files under `server/src/internal/`; every `Credentials.*` name is still on the public namespace (export-name diff is empty), ADR-EA-042 is untouched, and `api-key`, `jwt`, `qadi`, `web` and `test` compile without edits.
**Plans**: 4/7 plans executed
- [x] 07-01-PLAN.md
- [x] 07-02-PLAN.md
- [x] 07-03-PLAN.md
- [x] 07-04-PLAN.md
- [ ] 07-05-PLAN.md
- [ ] 07-06-PLAN.md
- [ ] 07-07-PLAN.md
**Research**: skip (a classification table plus a file split with a frozen public surface)

## Cross-Cutting Gates

GATE-01, GATE-03 and GATE-04 bind every phase that touches the relevant surface, but each requirement is mapped to the one phase that first establishes it:

| Gate | Mapped to | Applies to |
|------|-----------|------------|
| GATE-01 (gate list, `tsc -b` before cross-package vitest) | Phase 1 | Every phase |
| GATE-02 (knip baseline recorded) | Phase 1 | Recorded once, before Phase 1 code |
| GATE-03 (one changeset per candidate, `Migration:` line, spec Revision + Change History together) | Phase 1 | Every phase with a package-visible change |
| GATE-04 (Postgres verified in CI, "not run locally") | Phase 3 | Phases 3, 4 and 6 |

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Phases 1 and 2 are file-disjoint and may run in parallel. If scope must shrink, cut Phase 7 first, then reduce Phase 5 to its two-line fix, then take the Phase 6 spike as the decision point.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. CLI views and ConfigList removal | 4/4 | Complete    | 2026-11-14 |
| 2. Split TestAuth | 5/5 | Complete    | 2026-11-14 |
| 3. Keyset-page module | 9/9 | Complete    | 2026-11-14 |
| 4. Connection-lifecycle module | 9/9 | Complete    | 2026-11-14 |
| 5. Core-table list cleanup | 6/6 | Complete    | 2026-11-14 |
| 6. Record-store scaffolding (gated) | 12/12 | Complete    | 2026-11-15 |
| 7. World scaffold and Credentials split (optional) | 4/7 | In Progress | - |
