---
plan: 32-scim-resource-engine
ticket: 02
title: "One unit of work per SCIM write (the declared SqlTransaction port, finally opened)"
type: tdd
wave: 1
depends_on: [01]
files_modified:
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimAtomicity.test.ts
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "On SQL, a refused group PATCH or PUT leaves the team, roster and mapping as they were and publishes nothing (A1-A5 SQL green)"
    - "On SQL, a SCIM deactivation commits the suspension and the session revocation together, and a retry after an outage completes (A7 green)"
    - "A 404 for a group or user whose resource vanished still drops the stale mapping (the lookup stays outside the unit)"
  artifacts:
    - path: "packages/scim/src/Scim.ts"
      provides: "atomically helper over SqlTransaction; applyActive, replaceUser/patchUser apply, replaceGroup/patchGroup writes inside it"
      contains: "sqlTransaction.withTransaction"
  key_links:
    - from: "Scim.ts make"
      to: "SqlTransaction.SqlTransaction"
      via: "yield* once in make; withTransaction; SqlError → Errors.storeUnavailable(operation)"
      pattern: "yield\\* SqlTransaction\\.SqlTransaction"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Open one unit of work around every SCIM write that today commits step by step, using the `SqlTransaction` port `Scim.layer` already declares (`Scim.ts:517`) and `make` never yields.

Purpose: fixes F1–F3 and F6 on SQL (PLAN.md §2.6) in under 30 lines, with no change to any interface. Nested `OrganizationTeams` transactions become savepoints and their events and `After*` taps wait for the outer commit (ADR-EA-037 decision 4).
Output: `atomically` in `Scim.ts`; SQL cases A1–A5 and A7 flipped from `it.effect.fails` to `it.effect`.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§2.2, §3.4, §7 R2-R3)
@spec/decisions/037-unit-of-work-releases-events-on-commit.md (decisions 2-5, 7)
@packages/ports/src/SqlTransaction.ts (:20-34, :86-122, :139-142)
@packages/admin/src/AdminAccounts.ts (:162, :244-260: yield the port, map SqlError with Errors.storeUnavailable)
@packages/scim/src/Scim.ts (:622-632 make, :714-748 applyActive, :964-988 replaceUser/patchUser, :1298-1408 replaceGroup/patchGroup)
@packages/scim/test/ScimAtomicity.test.ts
</context>

<tasks>

<task type="tdd">
  <name>Task 1: atomically, and the writes inside it</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (whole make, :622-1450), packages/admin/src/AdminAccounts.ts (:240-262)</read_first>
  <action>In `make`, yield `SqlTransaction.SqlTransaction` once next to the other yields (bind it as `sqlTransaction`; a dependency yielded inside an operation would leak into the HTTP builder's requirements, the rule `OrganizationTeams.ts:257-258` states). Add one helper, `atomically(operation, effect)`, that runs `sqlTransaction.withTransaction(effect)` and maps the `SqlError` it adds with `Effect.catchTag("SqlError", Errors.storeUnavailable(operation))` (ADR-EA-028: a failed COMMIT is a `503`, as `AdminAccounts.ts:257-259` does). Then run inside it, and only these: (1) the whole body of `applyActive` (label "Scim.applyActive"), so the suspension, `sessions.revokeAll` and the deactivation event are one unit; (2) the `applyUserChanges(…)` call of `replaceUser` and of `patchUser` (labels "Scim.replaceUser", "Scim.patchUser"); a nested `applyActive` becomes a savepoint, which is correct; (3) in `replaceGroup`, everything from the `setExternalId` call through `groupChanged` (label "Scim.replaceGroup"); (4) in `patchGroup`, the `for` loop through `groupChanged` (label "Scim.patchGroup"). Keep `ownedUser`/`ownedGroup` and the `displayName`/`requireMembers` checks before `setExternalId` OUTSIDE the unit: `ownedGroup` and `ownedUser` drop a stale mapping on their 404 path, and that write must survive the failure it precedes. Render (`userResource`, `groupResource`) after the unit, as now. Inside the unit nothing may catch a SQL failure and continue (Postgres aborts the transaction on a failed statement); every failure already ends the operation, keep it so. Do not touch `createUser`, `createGroup`, `deleteGroup` or the erasing `deleteUser`: each already runs in its own unit. `pnpm check:transactions` must stay green: call the port, never `sql.withTransaction`.</action>
  <verify><automated>npx tsc -b tsconfig.json && pnpm check:transactions && npx vitest run packages/scim/test/ScimGroups.test.ts packages/scim/test/ScimUsers.test.ts packages/scim/test/ScimHttp.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'sqlTransaction.withTransaction' packages/scim/src/Scim.ts` = 1 (baseline at HEAD: 0). `grep -c 'yield\* SqlTransaction.SqlTransaction' packages/scim/src/Scim.ts` = 1 (baseline 0). The existing suites stay green, including "a group whose team was removed elsewhere is not found, and its stale mapping is dropped" (`ScimGroups.test.ts:223`).</acceptance_criteria>
  <done>Every multi-step SCIM write runs in one unit of work on SQL; memory behaviour is unchanged (the port is `layerNoop` there).</done>
</task>

<task type="tdd">
  <name>Task 2: flip the SQL red cases</name>
  <files>packages/scim/test/ScimAtomicity.test.ts</files>
  <read_first>packages/scim/test/ScimAtomicity.test.ts</read_first>
  <action>Change SQL A1, A2, A3, A4, A5 and A7 from `it.effect.fails` to `it.effect`. Leave memory A1–A4, A6 and SQL A6 as `.fails` (ticket 03 fixes them). If any flipped case still fails, the cause is in Task 1, not in the test: fix the code. Record in Comments the SQLite run result and, if `AWTHAQ_POSTGRES_URL` was available, a Postgres run of this file.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimAtomicity.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'it.effect.fails' packages/scim/test/ScimAtomicity.test.ts` = 6 (baseline after ticket 01: 12).</acceptance_criteria>
  <done>F1, F2, F3 and F6 are fixed on SQL and proven.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `/scim/v2` | PATCH/PUT bodies from a bearer-token holder drive several writes |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-04 | Tampering | `patchGroup`/`replaceGroup` writes | high | mitigate | One unit; A1–A5 SQL |
| T-32-05 | Elevation of privilege | `applyActive` (suspended user keeps live sessions after an outage) | high | mitigate | Suspension and revocation in one unit; A7 |
| T-32-06 | Denial of service | veto taps running inside an open transaction hold locks | low | accept | Already true in tenanted Postgres deployments (ADR-EA-037 Context); BEH-EA-350 note (ticket 05) |
| T-32-07 | Repudiation | audit rows of a refused write | low | accept | They roll back with the unit: the change did not happen (ADR-EA-037 decision 2); SCIM publishes no attempt event |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:transactions
</verification>

<success_criteria>
6 SQL red cases green; 6 memory/SQL-A6 cases still `.fails`; every pre-existing SCIM test green; no new `as`.
</success_criteria>

## Comments
