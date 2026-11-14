---
gsd_state_version: "1.0"
milestone: v1.0
milestone_name: Architecture Deepening, batch 3
current_phase: 4
current_phase_name: Connection-lifecycle module
current_plan: Not started
status: planning
stopped_at: Phase 3 complete, ready to plan Phase 4
last_updated: "2026-11-14T11:07:42.273Z"
last_activity: 2026-11-14
last_activity_desc: Phase 3 complete, transitioned to Phase 4
state_head: db288f17b532fda67a5147bf788f8e1d0e550e02
progress:
  total_phases: 7
  completed_phases: 3
  total_plans: 18
  completed_plans: 18
  percent: 43
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-14)

**Core value:** Composition is checked by the compiler: a missing plugin, port or duplicate slot is a compile error, not a runtime surprise.
**Current focus:** Phase 01 — CLI views and ConfigList removal

## Current Position

Phase: 4 — Connection-lifecycle module
Current Plan: Not started
Total Plans in Phase: 9
Status: Ready to plan
Last activity: 2026-11-14 — Phase 3 complete, transitioned to Phase 4

Progress: [████░░░░░░] 43%

## Performance Metrics

**Velocity:**
- Total plans completed: 18
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 4 | - | - |
| 2 | 5 | - | - |
| 3 | 9 | - | - |

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

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 3, 4, 6]: no local Postgres (`docker` absent, `AWTHAQ_POSTGRES_URL` unset); these phases must land through CI and record "not run locally"
- [Phase 6]: REC-03 and REC-04 are conditional on the spike go decision; a no-go closes them as not pursued
- [Phase 1]: knip baseline is already dirty (3 unlisted deps in the sql fixture, `.reports/`, untracked `.claude/`); record it, do not "fix" it by adding `@awthaq/core` to sql (cycle)

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-14T07:22:48.697Z
Stopped at: Phase 3 complete, ready to plan Phase 4
Resume file: None
