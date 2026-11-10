---
plan: 32-scim-resource-engine
ticket: 11
title: "Close-out: traceability rows, BEH-EA Implementation note, pnpm check"
type: execute
wave: 8
depends_on: [08, 10]
files_modified:
  - spec/traceability.md
  - spec/behaviors/30-scim.md
  - .planning/32-scim-resource-engine/PLAN.md
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532, REQ-EA-1533]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "spec/traceability.md names every new SCIM test file and what it proves"
    - "BEH-EA-350/351 say where the implementation lives (internal/protocol.ts, internal/engine.ts)"
    - "pnpm check is green for the whole plan"
  artifacts:
    - path: "spec/traceability.md"
      provides: "ScimProtocol.test.ts row content; Document Control line"
      contains: "ScimProtocol"
  key_links:
    - from: "spec/behaviors/30-scim.md BEH-EA-350"
      to: "packages/scim/src/internal/engine.ts"
      via: "Implementation note"
      pattern: "internal/engine.ts"
---
Status: ready-for-agent
Blocked by: 08, 10

<objective>
Finish the plan: trace the Phase 1 tests, add the Implementation notes, run the plan gate, and fill "Decisions taken".

Purpose: `pnpm spec:verify:strict` and `pnpm check` are the plan's exit gate (shared conventions).
Output: two spec edits; `pnpm check` green; PLAN.md "Decisions taken" filled.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§6.3, §9, §10)
@spec/traceability.md (the packages/scim/test/* row and Document Control)
@spec/behaviors/30-scim.md (BEH-EA-350/351 from ticket 05)
</context>

<tasks>

<task type="auto">
  <name>Task 1: traceability and Implementation notes</name>
  <files>spec/traceability.md, spec/behaviors/30-scim.md</files>
  <read_first>spec/traceability.md, spec/behaviors/30-scim.md</read_first>
  <action>In `traceability.md`, the `packages/scim/test/*` row adds `ScimProtocol.test.ts` (BEH-EA-248/251/252/350: the filter parser, paging, both PATCH interpreters and the roster fold, pure; the parser properties moved from `ScimFilter.property.test.ts`) and says `ScimGroupsListing.test.ts` runs L3 on SQL; add a Document Control revision line naming plan 32 ticket 11. In `30-scim.md`, add an Implementation note under BEH-EA-350 ("`internal/engine.ts` `write`: the owned lookup outside the unit, interpretation, vetting, one `SqlTransaction` unit, rendering after commit; `internal/protocol.ts` interprets") and under BEH-EA-351 ("`internal/engine.ts` `list`"); revision 1.8 with a change-history line. If ticket 06 landed before ticket 05, re-run `python3 features/scripts/allocate-req-ea.py` so the REQ-EA-1530..1533 rows name BEH-EA-350/351.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>`grep -c 'ScimProtocol' spec/traceability.md` ≥ 1 (baseline 0). `grep -c 'internal/engine.ts' spec/behaviors/30-scim.md` ≥ 1 (baseline 0).</acceptance_criteria>
  <done>Every new file is traced.</done>
</task>

<task type="auto">
  <name>Task 2: plan gate and Decisions taken</name>
  <files>.planning/32-scim-resource-engine/PLAN.md, spec/traceability.md</files>
  <read_first>.planning/32-scim-resource-engine/PLAN.md (§9, §10)</read_first>
  <action>Run `pnpm check` (and `pnpm test:pg` if a Postgres is available; say so if not, IMPLEMENTING.md). Tick every §9 item that holds; for any that does not, stop and report. Append to PLAN.md "Decisions taken": every open-question default taken (Q1–Q8), the observed failure messages of ticket 01, whether plan 37 has listed the SCIM SQL suites in `scripts/test-pg.sh` (Q5), F9 as a follow-up candidate (Q8), and the commit hashes. Fix any `spec/traceability.md` problem `pnpm check` reports; touch no source.</action>
  <verify><automated>pnpm check</automated></verify>
  <acceptance_criteria>`pnpm check` exits 0 (knip may report only `.reports/` files). PLAN.md's "Decisions taken" section is non-empty.</acceptance_criteria>
  <done>The plan is closed and its decisions recorded.</done>
</task>

</tasks>

<verification>
pnpm check
pnpm test:pg (when a Postgres is available)
</verification>

<success_criteria>
`pnpm check` green; traceability and Implementation notes in place; "Decisions taken" filled.
</success_criteria>

## Comments
