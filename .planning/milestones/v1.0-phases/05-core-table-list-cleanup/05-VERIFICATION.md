---
phase: 05-core-table-list-cleanup
verified: 2026-11-14T17:30:00Z
status: passed
score: 4/4 roadmap truths verified; Postgres legs run locally on Debian postgres:16 (the image CI uses), CI confirmation open (no git remote)
covered_files:
  - .changeset/core-table-catalogue.md
  - .planning/phases/05-core-table-list-cleanup/05-01-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-01-SUMMARY.md
  - .planning/phases/05-core-table-list-cleanup/05-02-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-02-SUMMARY.md
  - .planning/phases/05-core-table-list-cleanup/05-03-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-03-SUMMARY.md
  - .planning/phases/05-core-table-list-cleanup/05-04-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-04-SUMMARY.md
  - .planning/phases/05-core-table-list-cleanup/05-05-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-05-SUMMARY.md
  - .planning/phases/05-core-table-list-cleanup/05-06-PLAN.md
  - .planning/phases/05-core-table-list-cleanup/05-06-SUMMARY.md
  - features/step-definitions/TenancySteps.ts
  - packages/core/src/Auth.ts
  - packages/core/test/AuthTenancy.test.ts
  - packages/sql/README.md
  - packages/sql/src/CoreTables.ts
  - packages/sql/src/TenantScope.ts
  - packages/sql/src/index.ts
  - packages/sql/test/CoreTablePins.test.ts
  - packages/sql/test/CoreTables.test.ts
  - packages/sql/test/TenantScope.postgres.test.ts
  - packages/test/src/LaggingReplica.ts
  - packages/test/test/LaggingReplica.test.ts
  - spec/behaviors/28-tenancy.md
  - spec/overview.md
  - spec/traceability.md
covered_digest: "v4:sha256:855dca5c5117a1a83c06c1f7b7a3af0cbd84499f73bcb4993eec30b815784549"
behavior_unverified: 0
overrides_applied: 0
human_verification: []
---

# Phase 5: Core-table list cleanup Verification Report

**Phase Goal:** One core-table list in `@awthaq/sql` is the single source that the three existing hand-maintained lists project from.
**Verified:** 2026-11-14
**Status:** passed (every criterion verified in code at HEAD `b2892e56`, which includes the review fixes IN-01..IN-06)
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A single list of core tables (name, owner, tenancy, sealed) exists in `@awthaq/sql`; `Auth.ts`, `LaggingReplica` and `TenantScope.coverage` each derive from it; a test shows each projection equals the list it replaces | VERIFIED | `packages/sql/src/CoreTables.ts` holds one `declared` array of eight rows (users, accounts, sessions, verification_tokens, verification_reservations, auth_audit_log, auth_relay_cursor, rate_limit_buckets) and the exported views `tables`, `names`, `partitionedTables`, `directoryTables`, `stamped`, `replicated`, `isStamped`, all frozen; `owner` is the fixed marker `"core"`, `sealed` is a filter over `CoreSealedColumns.deployed({ encryptPii: true })`, never a second list. Exported through the barrel (`index.ts:33`, `export * as CoreTables`). Consumers read it: `TenantScope.ts:45,49` (`partitionedTables`/`directoryTables` are the catalogue's views, and `coverage` uses them at :101,:103); `Auth.ts:881` (`CoreTables.isStamped(tenancy.parent)`, the local `coreTables` concat is gone); `LaggingReplica.ts:35` (`coreTables = CoreTables.replicated`); the BDD private six-name `STAMPED_TABLES` is gone, `TenancySteps.ts:114` uses `CoreTables.isStamped`. Equality tests are oracle files with inline literal expectations that import nothing the phase added and were committed once at Wave 0 against untouched src: `CoreTablePins.test.ts` P1 (partitioned/directory lists and order) and P2 (five whole `TenantScope.coverage` outputs), `LaggingReplica.test.ts` P5 (six names, order), `AuthTenancy.test.ts` P6 (accepts the five other stamped parents, refuses the two non-tenant tables; additions only, 0 removed lines), `TenantScope.postgres.test.ts` P8 (`relrowsecurity` set). Re-run at HEAD: all pass (below). |
| 2 | `auth_relay_cursor` and `rate_limit_buckets` are each included or excluded with a documented reason | VERIFIED | Both are rows in the catalogue with `tenancy: "none"`, `replicated: false` and a `reason` string (relay cursor: no tenant column, a relay reads its cursor from the primary only; rate-limit bucket: no tenant column, atomic read-modify-write counter always on the primary, opt-in via `RateLimiterStoreSql.migrate`). `CoreTables.test.ts` asserts class, owner and non-empty reason for each, and that `isStamped` is false for both; `AuthTenancy.test.ts` asserts `Auth.make` refuses both as a Derived parent with cause `UnknownParent`; the `CoreTablePins` P8 Postgres pin shows RLS never covers `auth_relay_cursor`. The reasons are repeated in the changeset, the README and `spec/behaviors/28-tenancy.md` Rev 1.15 -> 1.16 (Change History bumped with it). BASELINE records a correction to the CONTEXT citation of the rate limiter header. |
| 3 | No column types or DDL (ADR-EA-004); `core -> sql` edge unchanged, `pnpm circular` passes, no new dependency; a declaration-list snapshot protects the sealed AADs | VERIFIED | `CoreTables.ts` has only `name`, `owner`, `tenancy`, `replicated`, `sealed`, `reason`; the test "an entry carries no column types or DDL" asserts the key allow-list, scalar-only values, and that each sealed element is the `CoreSealedColumns` declaration object itself. `packages/core/package.json:34` still has the single `@awthaq/sql` edge; `git diff --stat ea56a16f HEAD -- packages/{core,sql,test}/package.json features/package.json pnpm-lock.yaml` is empty; `pnpm circular`: no findings. `CoreTablePins.test.ts` P3 freezes `CoreSealedColumns.deployed({ encryptPii: true })` as six `[table, column, key, adoptPlaintext, aadOf(column,"<id>")]` tuples (and the three-tuple `encryptPii: false` case), with inline literals; BASELINE records the AAD mutation (`users:<id>:metadata` -> `...:meta`) seen to fail. |
| 4 | A re-grep at planning time confirms which duplicates are real; minimal fix only if `LaggingReplica` is the only real copy | VERIFIED | `05-BASELINE.md` "Census" and "CAT-04 disposition" classify the four lists: `TenantScope` (source), `LaggingReplica.coreTables` (real copy), the BDD `STAMPED_TABLES` (second real copy), `Auth.ts` `coreTables` (a projection). Two real copies plus two unclassified core tables, so the conditional minimal-fix branch is explicitly not taken and the full catalogue ships. Re-run census at HEAD: the quoted `"verification_reservations"` grep prints 2 lines (`CoreTables.ts:26` and the `case` label `TenancySteps.ts:473`); `grep -c 'as const' TenantScope.ts` = 0; `export * as CoreTables` count = 1; `STAMPED_TABLES` and the `coreTables` list literals are gone (the remaining `coreTables` hits are `LaggingReplica`'s own exported projection and an unrelated local variable in `PersistenceMigrationSteps.ts`); `auth_relay_cursor`/`rate_limit_buckets` appear in no consumer list, only in a `LaggingReplica` doc comment. |

**Score:** 4/4 truths verified. 0 behavior-unverified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/sql/src/CoreTables.ts` | the catalogue and its frozen views | VERIFIED | 106 lines, substantive; wired from `TenantScope`, `index.ts`, `Auth.ts`, `LaggingReplica`, `TenancySteps` |
| `packages/sql/test/CoreTables.test.ts` | drift guard against the real migrations | VERIFIED | creates the core tables and the rate limiter's, compares with `names`, plus a synthetic and a really-stray-table case, sealed columns exist, tenancy equals the `"tenantId"` column; documents what it does not prove |
| `packages/sql/test/CoreTablePins.test.ts` | Wave 0 oracle | VERIFIED | 9 tests, one commit `7720a413`, no `CoreTables` import |
| `packages/test/test/LaggingReplica.test.ts`, `AuthTenancy.test.ts`, `TenantScope.postgres.test.ts` | P5, P6, P8 | VERIFIED | one commit / additions only |
| `.changeset/core-table-catalogue.md` | changeset with `Migration:` | VERIFIED | `@awthaq/sql` minor, test and core patch; `Migration:` names the tuple -> `ReadonlyArray` typing change |
| spec and README | catalogue named | VERIFIED | `28-tenancy.md` Rev 1.16, `overview.md`, `traceability.md`, `sql/README.md` updated; `pnpm spec:verify:strict` PASS 32, FAIL 0 |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `TenantScope.partitionedTables/directoryTables` | `CoreTables` | `typeof` re-export of the frozen views | WIRED |
| `TenantScope.coverage` | the two views | `.map` at `TenantScope.ts:101,103` | WIRED |
| `Auth.make` Derived-parent check | `CoreTables.isStamped` | `Auth.ts:881` | WIRED |
| `LaggingReplica.coreTables` | `CoreTables.replicated` | `LaggingReplica.ts:35`, used as the default at :56 | WIRED |
| `features` tenancy steps | `CoreTables.isStamped` | `TenancySteps.ts:114` | WIRED |
| `CoreTables.sealed` | `CoreSealedColumns.deployed` | filter by table, same objects | WIRED |
| `core` -> `sql` | package edge | single existing `@awthaq/sql` dependency, no `package.json` diff | UNCHANGED |

### Data-Flow Trace (Level 4)

The views are derived from the one `declared` array at module load, and the consumers read the live frozen arrays (the same reference where typed `typeof`). The sealed view is a filter over the real `CoreSealedColumns` declarations (identity asserted: `entry("users").sealed[0] === CoreSealedColumns.usersMetadata`). The drift guard reads the real schema after the real migrations on SQLite and Postgres. No static or hollow data.

### Behavioral Spot-Checks and Gates (run in this verification)

| Check | Command | Result |
|-------|---------|--------|
| Build | `npx tsc -b tsconfig.json` | exit 0, no output |
| Phase tests, SQLite | `npx vitest run packages/sql/test/{CoreTablePins,CoreTables,TenantScoped,TenantScope.postgres}.test.ts packages/core/test/AuthTenancy.test.ts packages/test/test/LaggingReplica.test.ts` | 5 files passed, 1 skipped (Postgres file); 41 passed, 11 skipped |
| Phase tests, Postgres | same, `AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq` on container `awthaq-p3-pg` (PostgreSQL 16.16 Debian) | 6 files passed; 52 passed, 0 skipped. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote) |
| Tenancy BDD | `pnpm --filter @awthaq/features exec vitest run features/12-multi-tenancy/28-tenancy.steps.test.ts` | 60 passed, 7 skipped (the baseline's count) |
| Cycles | `pnpm circular` | no findings |
| Spec | `pnpm spec:verify:strict` | PASS 32, FAIL 0, SKIP 0 |
| Error tags / readmes / format | `pnpm check:error-tags`, `check:readmes`, `format:check` | 163 / 137 none shared; match; clean on 1228 files |
| knip | `pnpm knip` (filtered) | exit 1 as baseline: 39 untracked `.claude/` files and the same 3 `readme-quickstart.ts` unlisted deps, nothing under `packages/` added; `knip.json` diff empty |
| Scope | `git diff --name-only ea56a16f HEAD` outside `.planning/` | 16 files, all inside the plan allowlist; `.claude/` untracked and not in the diff |
| Oracle immutability | `git log ea56a16f..HEAD` on `CoreTablePins` and `LaggingReplica` tests; removed lines in `AuthTenancy` and `TenantScope.postgres` tests | one commit each; 0 removed lines |

The full unit, bdd and coverage suites and `package:smoke` were not re-run here; their phase-close records are in `05-BASELINE.md` ("Phase close") and the review fixes after that (IN-01..IN-06) touched only the files re-run above.

### Probe Execution

No probe scripts declared for this phase: SKIPPED.

### Requirements Coverage

| Requirement | Verdict | Evidence |
|-------------|---------|----------|
| CAT-01 | SATISFIED | One catalogue; `Auth.ts`, `LaggingReplica`, `TenantScope.coverage` (and the BDD step) project from it; equality pins P1/P2/P5/P6/P8 pass |
| CAT-02 | SATISFIED | Both tables classified `none`, not replicated, with reasons; pinned in three test files and the spec |
| CAT-03 | SATISFIED | No types or DDL (asserted), edge unchanged (no `package.json` diff), `pnpm circular` clean, sealed AAD snapshot P3 |
| CAT-04 | SATISFIED | Re-grep recorded in BASELINE; the minimal-fix branch was evaluated and rejected on evidence (two real copies, two unclassified tables); disposition and phase-close census recorded |
| GATE-04 | SATISFIED | Postgres legs run on Debian postgres:16, recorded as "run locally on the CI image, CI confirmation open (no git remote)", with an empty failing-test list in the full-suite record |

No orphaned requirements: REQUIREMENTS.md maps CAT-01..04 to this phase and the plans claim them. Checkbox state in REQUIREMENTS.md and the ROADMAP progress row (still "In Progress", "5. ... 6/6") is for the orchestrator to update; this report changes neither.

### Anti-Patterns Found

None. No `TBD|FIXME|XXX|TODO|HACK` in the phase's source or test files. Known limits are documented rather than hidden, in `CoreTables.test.ts`: a future opt-in store with its own migrator is not covered by the drift guard, and the guard cannot tell `partitioned` from `directory` (defended by the inline P1/P2 pins). Review: `05-REVIEW.md` 0 critical, 0 warning, 6 info, all disposed `fixed`; `05-SECURITY.md` `threats_open: 0` (19/19 closed).

### Notes (non-blocking)

- `partitionedTables`/`directoryTables` changed from `as const` tuples to `ReadonlyArray` of literals; the changeset's `Migration:` line says so and values and order are unchanged.
- `CoreTable.replicated` is documented as the test replica's mirror set, not ADR-EA-024's replica-eligible read set; do not derive read routing from it.
- CI confirmation of the Postgres legs is open by construction (no git remote); this is recorded, not a gap.

### Human Verification Required

None.

### Gaps Summary

No gaps. Every roadmap criterion is verified against the code at HEAD, not the SUMMARY claims.

---

_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
