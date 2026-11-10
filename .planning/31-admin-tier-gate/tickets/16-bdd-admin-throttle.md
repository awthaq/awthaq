---
plan: 31-admin-tier-gate
ticket: 16
title: "BDD: an administrator is rate limited (REQ-EA-1523, Q2)"
type: execute
wave: 6
depends_on: [11, 15]
files_modified:
  - features/features/09-admin-and-impersonation/27-admin-impersonation.feature
  - features/step-definitions/AdminSteps.ts
  - features/traceability.md
  - spec/traceability.md
autonomous: false
requirements: [REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A scenario shows the third user listing by one administrator refused as RateLimited under a 2-per-minute override, while refusals before it were not counted"
  artifacts:
    - path: "features/features/09-admin-and-impersonation/27-admin-impersonation.feature"
      contains: "@REQ-EA-1523"
  key_links:
    - from: "features/step-definitions/AdminSteps.ts"
      to: "packages/admin/src/Admin.ts"
      via: "RateLimits.overrides on the admin rule; listUsers three times"
      pattern: "RateLimited"
---
Status: ready-for-human (Q2; drop if Q2 is "no")
Blocked by: 11, 15

<objective>
An acceptance scenario for BEH-EA-349.

Purpose: a new 429 on the admin groups is a user-visible behaviour.
Output: a `@BEH-EA-349` Rule with one scenario tagged `@REQ-EA-1523`, steps, manifest, §6 rows.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§6.5, §10 Q2)
@features/features/09-admin-and-impersonation/27-admin-impersonation.feature (BEH-EA-224 Rule :309-…)
@features/step-definitions/AdminSteps.ts
@packages/admin/test/AdminGate.test.ts (ticket 11's "BEH-EA-349" block: how the override and limiter are provided)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Scenario and steps</name>
  <files>features/features/09-admin-and-impersonation/27-admin-impersonation.feature, features/step-definitions/AdminSteps.ts</files>
  <read_first>features/step-definitions/AdminSteps.ts, features/STYLE.md</read_first>
  <action>After the BEH-EA-224 Rule add a comment pointing at `spec/behaviors/27-admin-impersonation.md` and a `@BEH-EA-349` Rule "Each administrator is rate limited on the admin groups" with one scenario, hand-tagged `@REQ-EA-1523`, "An administrator is rate limited on user administration once past the gate": Given user administration is denied by default; And the admin rule allows 2 calls per minute; When the administrator lists users three times; Then all three are refused as "AdminActionDenied"; When user administration is allowed and the administrator lists users three times; Then the first two succeed and the third is refused as "RateLimited". Implement the new steps with `RateLimits.overrides` for the `admin` rule and a memory limiter, as ticket 11's unit cases do; reuse existing step texts where they exist.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>
    - `grep -c "@REQ-EA-1523" features/features/09-admin-and-impersonation/27-admin-impersonation.feature` → 1 (baseline 0).
  </acceptance_criteria>
  <done>Scenario passes.</done>
</task>

<task type="auto">
  <name>Task 2: Manifest and traceability</name>
  <files>features/traceability.md, spec/traceability.md</files>
  <read_first>features/scripts/allocate-req-ea.py</read_first>
  <action>Run `python3 features/scripts/allocate-req-ea.py`; update `spec/traceability.md` §6's file-27 row to list REQ-EA-1523 and the new count; Document Control line (plan 31 ticket 16).</action>
  <verify><automated>python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c "REQ-EA-1523" features/traceability.md` ≥ 1 (baseline 0).
  </acceptance_criteria>
  <done>Manifest and matrix current.</done>
</task>
</tasks>

<verification>
pnpm test:bdd && python3 features/scripts/allocate-req-ea.py --check && pnpm spec:verify:strict
</verification>

<success_criteria>
- REQ-EA-1523 scenario green and traced.
</success_criteria>

## Comments
