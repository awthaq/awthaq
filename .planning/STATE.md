---
gsd_state_version: "1.0"
milestone: v1.0
milestone_name: Architecture Deepening, batch 3
current_phase: 5
current_phase_name: Core-table list cleanup
current_plan: 4
status: executing
stopped_at: Completed 05-03-PLAN.md
last_updated: "2026-11-14T15:41:17.049Z"
last_activity: 2026-11-14
last_activity_desc: Phase 5 execution started
state_head: 4bf14a22ed42b0592ebb9cb670185c00d3014757
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 33
  completed_plans: 30
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-14)

**Core value:** Composition is checked by the compiler: a missing plugin, port or duplicate slot is a compile error, not a runtime surprise.
**Current focus:** Phase 5 — Core-table list cleanup

## Current Position

Phase: 5 (Core-table list cleanup) — EXECUTING
Current Plan: 4
Total Plans in Phase: 6
Status: Ready to execute
Last activity: 2026-11-14 — Phase 5 execution started

Progress: [██████░░░░] 57%

## Performance Metrics

**Velocity:**
- Total plans completed: 27
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 4 | - | - |
| 2 | 5 | - | - |
| 3 | 9 | - | - |
| 4 | 9 | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 20min | 3 tasks | 5 files |
| Phase 01 P02 | 2 min | 2 tasks | 3 files |
| Phase 01 P03 | 8 min | 2 tasks | 6 files |
| Phase 01 P04 | 25 min | 3 tasks | 3 files |
| Phase 02 P01 | 25min | 2 tasks | 3 files |
| Phase 02 P02 | 15min | 2 tasks | 4 files |
| Phase 02 P03 | 12min | 2 tasks | 5 files |
| Phase 02 P04 | 15min | 2 tasks | 3 files |
| Phase 02 P05 | 40min | 2 tasks | 3 files |
| Phase 03 P01 | 35min | 2 tasks | 2 files |
| Phase 03 P02 | 30min | 2 tasks | 3 files |
| Phase 03 P03 | 25min | 2 tasks | 5 files |
| Phase 03 P04 | 15min | 2 tasks | 3 files |
| Phase 03 P05 | 20min | 2 tasks | 6 files |
| Phase 03 P06 | 25 min | 2 tasks | 5 files |
| Phase 03 P07 | 20min | 2 tasks | 3 files |
| Phase 03 P08 | 15min | 2 tasks | 3 files |
| Phase 03 P09 | 25min | 2 tasks | 1 files |
| Phase 04 P01 | 40min | 3 tasks | 6 files |
| Phase 04 P02 | 25min | 2 tasks | 6 files |
| Phase 04 P03 | 25min | 2 tasks | 4 files |
| Phase 04 P04 | 15min | 2 tasks | 9 files |
| Phase 04 P05 | 25min | 2 tasks | 4 files |
| Phase 04 P06 | 30min | 2 tasks | 3 files |
| Phase 04 P07 | 25min | 2 tasks | 9 files |
| Phase 04 P08 | 25min | 2 tasks | 6 files |
| Phase 04 P09 | 40min | 2 tasks | 1 files |
| Phase 05 P01 | 17min | 2 tasks | 2 files |
| Phase 05 P02 | 10min | 2 tasks | 4 files |
| Phase 05 P03 | 12min | 2 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Seven phases follow research/SUMMARY.md order: CLI views, TestAuth split, keyset, connection lifecycle, table list, record scaffolding (spike/no-go gate), optional World scaffold + Credentials split
- [Roadmap]: Phase 0 preconditions attach to the phase that needs them: GATE-02 (knip baseline) to Phase 1, REC-01 (Track A, ADR-EA-046) to Phase 6
- [Roadmap]: GATE-01/02/03 map to Phase 1, GATE-04 to Phase 3 (first SQL phase); all apply to later phases too
- [Decided]: SAML suspended-org gate is `findActive` on create and update, none on remove; cursors byte-identical per listing; id collation declared stable by construction
- [Phase 01]: Plugin view matrix encodes the resolution contract (dot only where a view has a dot branch, then json if --format json or --json, else text) and pins failure rendering at exit 9 on the global --json only
- [Phase 01]: 01-02: PluginViews.render resolves --format and global --json once; DOT printed with { json: false } so the global flag cannot turn it into a document; Output.report gains optional { json } override
- [Phase 01]: Migration.apply status preview stays hand-guarded: it prints before the drift and pending checks while Output.report couples text and document at one point
- [Phase 01]: 01-04: one minor changeset covers both the views module and the ConfigList export removal; all baseline gates re-run green at phase close
- [Phase 02]: Surface probe kept outside the repo (never committed); TestAuth surface pinned by TestAuthSurface.test.ts (23 values runtime, 24 types compile-time)
- [Phase 02]: Name Encryption.Encryption in composition.ts TestProvided to keep testPorts/encryption declaration emit portable (TS2883) after FoundationServices left the facade
- [Phase 02]: 02-03: temporary session import placed in the facade import block so import ordering stays lint-clean
- [Phase 02]: 02-04: TestFramework type re-export stays in the TestAuth facade; contractRunner imports it from ../TestFramework.ts
- [Phase 02]: 02-05: no changeset added; probe diff empty and @awthaq/test exports only '.', nothing package-visible
- [Phase 03]: Golden cursor test asserts whole pages (ids plus encoded cursor or null) per traversal so page count and final None are pinned
- [Phase 03]: 03-02: Wave 0 wire pins serve with testClock: true and advance 1 ms between creates; pins name the cursor types through the aliases later plans keep
- [Phase 03]: 03-03: Keyset.key infers with no annotations (spike); window decides follows-cursor by the first non-zero key comparison; A1 confirmed (TS2322/TS4111), no cursor-schema factory
- [Phase 03]: 03-04: KeysetSql refuses mixed-direction declarations with Defects.InvalidConfiguration at make (setting 'keyset order'); wrong cursor arity is Defects.InvariantViolation at after
- [Phase 03]: 03-05: Users.UserCursor and Users.UsersPage kept as names, now aliases of UserStore.UserCursor and Keyset.Page; usersPage SQL is one template via sql.and over an optional KeysetSql seek
- [Phase 03]: 03-06: OrganizationCursor defined in OrganizationRecords, aliased by OrganizationDirectory and AdminTenants; the admin gate stays in AdminTenants.listOrganizations
- [Phase 03]: 03-07: ImpersonationPage is a Keyset.Page alias; AdminApi.LimitSchema bound by Keyset.MIN_LIMIT/MAX_LIMIT; KEY-06 scoped grep at 0
- [Phase 03]: 03-08: BEH-EA-036 amended in place (Rev 1.14, traceability 1.91); changeset names byCreation, pageLimit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE as removed
- [Phase 03]: 03-09: Postgres confirmations recorded as open CI items, not passes; GATE-04 not-run-locally record satisfied, CI pass outstanding
- [Phase 04]: 04-01: Postgres full-suite record at HEAD is clean (421 files, 6629 tests, no failures); Wave 0 pins import no DomainClaims; SCIM orphan is finding F-04-01 only (CONN-F1); two unit-suite intermittents recorded (passkey ChallengeStore sql, organization TenantMiddleware loopback)
- [Phase 04]: 04-02: suspension step uses OrganizationRecords.setSuspended (AppServices widened by one type member in SamlWorld.ts); race cases assert one observed-counts object each so the red output shows every divergent count
- [Phase 04]: 04-03: DomainClaims lock key is organization-level (organization_domain_claim:org:<id>) via SqlStore.atomically; owner rows inserted sorted, read in input order
- [Phase 04]: 04-04: OrganizationConnectionLifecycle exposed (key awthaq/plugin/organization/ConnectionLifecycle); taken-domain mapping on the claim call, compensation inside the SqlTransaction effect
- [Phase 04]: 04-05: OIDC remove reads the row first for its previous domains; events and cache invalidation stay in the store after the lifecycle returns
- [Phase 04]: 04-06: SqlTransaction stays in the SAML plugin ports (tsc rejects the drop); SAML update/refresh answer NotFound before the lifecycle gate; BDD red window closed (1580 passed, 0 failed)
- [Phase 04]: 04-07: DomainClaims reachable only at @awthaq/organization/records; RecordsBoundary.test.ts refuses non-organization src imports of it and a root export; withClaim/withRelease deleted
- [Phase 04]: 04-08: suspended and missing organizations stay indistinguishable in the spec wording; DomainClaims.test.ts traceability row narrowed to the Postgres lock test
- [Phase 04]: 04-09: phase-close gates recorded in 04-BASELINE.md; every gate meets the baseline; Postgres run locally on the CI image, CI confirmation open (no git remote)
- [Phase 05]: CAT-04 minimal-fix branch not taken: the BDD STAMPED_TABLES literal is a second real copy and auth_relay_cursor and rate_limit_buckets are in no list; the candidate closes with the catalogue (CAT-01..03)
- [Phase 05]: 05-03: partitionedTables typed via Extract over the declared tuple so the quoted reservations name stays on one line; replicated documented as LaggingReplica mirror set, not the ADR-EA-024 read set

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 6]: Postgres runs locally on the CI image (Debian `postgres:16` container `awthaq-p3-pg` on port 55433, pass `AWTHAQ_POSTGRES_URL` explicitly; use `--shm-size=1g` for full-suite runs); hosted CI cannot run (no git remote), so record "CI confirmation open"
- [Phase 6]: REC-03 and REC-04 are conditional on the spike go decision; a no-go closes them as not pursued
- [Phase 1]: knip baseline is already dirty (3 unlisted deps in the sql fixture, `.reports/`, untracked `.claude/`); record it, do not "fix" it by adding `@awthaq/core` to sql (cycle)

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-14T15:41:16.930Z
Stopped at: Completed 05-03-PLAN.md
Resume file: None
