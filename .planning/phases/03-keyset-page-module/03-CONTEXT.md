# Phase 3: Keyset-page module - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Users, organizations and impersonations page through one keyset module in `@awthaq/ports` with one page contract. A SQL row-value predicate builder in `@awthaq/sql` replaces the expanded-`OR` spellings and refuses mixed-direction orders. Cursors stay byte-identical per listing (impersonation `startedAt`, users and organizations `createdAt`), pinned by a golden test. `StoreContract`/`RecordsContract` gain page-order cases that pass on memory and on Postgres (CI only; "not run locally"). Duplicate `pageLimit`/`listLimit`/`MAX_PAGE_SIZE` copies are deleted. Membership offset paging, `SessionStore.listLive`, SCIM paging, audit log and webhook deliveries are untouched. `spec/overview.md` `surface:ports` lists the module and BEH-EA-036 is amended.

Requirements: KEY-01..KEY-08, GATE-04.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion: this is a structural refactor with technical success criteria and no new user-facing behaviour. The user's standing instruction for this milestone is the cleanest end state, not the simplest; complexity is accepted. The constraints below are already decided (REQUIREMENTS.md "Locked decisions", user-confirmed during milestone setup) and are not open:

- Cursor wire format stays byte-identical per listing (`startedAt` for impersonations, `createdAt` for users and organizations); a golden test against today's three schemas proves it. No cursor wire change.
- The store primitive owns `limit + 1`; `OrganizationRecords.listPage` and `AdminTenants` change in one commit so `+1` is applied exactly once. The post-page admin gate stays in the caller.
- Postgres id ordering is declared collation-stable by construction, with a mixed-case `test:pg` case. No `COLLATE "C"` unless CI shows drift.
- BEH-EA-036 wording is amended to scope "store ports" to core ports; Membership offset paging stays (KEY-F1 is a deferred follow-up).
- A port-visible contract change ships with a changeset carrying a `Migration:` line (the Phase 1 routine).
- Postgres is unavailable locally: SQL cases run in CI only; the phase records "not run locally" (GATE-04). Wave 0 records the gate baseline and a pin matrix of today's behaviour (limits, cursors, orders, tie handling) before any `src` change, as in Phases 1 and 2.
- Strata: `api < ports < sql < core < server < qadi < plugins < cli/test/features`; the keyset module lives in `ports`, the predicate builder in `sql`, and `ports` must not import `sql`. `pnpm circular` counts type-only imports.
- Research is recommended before planning (collation behaviour, the `limit + 1` contract, the sub-millisecond timestamp case); open design questions that research surfaces are resolved by the cleanest-end-state rule and recorded in the plans, and only a question that is genuinely the user's (a product or public-wire decision) is escalated.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `OrganizationCursor` already exists in `packages/admin/src` (admin impersonation paging) alongside `AdminTenants`.
- `StoreContract`/`RecordsContract` (`packages/test/src/internal/storeContract/`, `RecordsContract.ts`) are the existing shared contract suites to extend with page-order cases.
- `TestSql` and the Phase 2 `internal/` split give a house pattern for concern modules.

### Established Patterns
- The `@awthaq/ports` stratum holds port shapes and pure helpers; `@awthaq/sql` holds adapters and SQL builders.
- Phase 1 and 2 process: baseline and pin matrix committed before any `src` change, then refactor, then re-run every gate against the baseline.

### Integration Points
- Users, organizations and impersonation listings (admin, organization, core user store), their memory and SQL adapters, and `spec/overview.md` `surface:ports`, `spec/behaviors` (BEH-EA-036), `spec/traceability.md`.

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond the milestone's standing instruction: the cleanest solution, not the simplest.

</specifics>

<deferred>
## Deferred Ideas

- KEY-F1: convert `MembershipRecords` offset paging to keyset (a wire change; out of scope by decision).

</deferred>
