---
plan: 32-scim-resource-engine
ticket: 10
title: "One write path: replaceUser, patchUser, replaceGroup, patchGroup through engine.write and two adapters"
type: execute
wave: 7
depends_on: [09]
files_modified:
  - packages/scim/src/internal/engine.ts
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimAtomicity.test.ts
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "The write order (owned outside the unit, interpret, vet, apply in one unit, render after commit) is written once, in engine.write"
    - "The four PUT/PATCH handlers are engine.write calls over a user adapter and a group adapter"
    - "Every case of ScimAtomicity.test.ts stays green with no edit to its assertions"
  artifacts:
    - path: "packages/scim/src/internal/engine.ts"
      provides: "Writable interface; write(writable, operation)"
      contains: "withTransaction"
  key_links:
    - from: "engine.write"
      to: "SqlTransaction.withTransaction"
      via: "apply runs inside; SqlError → Errors.storeUnavailable(operation)"
      pattern: "withTransaction\\("
---
Status: ready-for-agent
Blocked by: 09

<objective>
Move the unit-of-work order out of the four PUT/PATCH handlers into `engine.write`, so the order every write must keep is stated once and the two resource kinds are adapters at that seam.

Purpose: ticket 02 and 03 wrote the order by hand in each handler; getting it wrong is silent (the owned lookup inside the unit would roll back a stale-mapping cleanup, PLAN.md §7 R3). One implementation, four callers, two adapters.
Output: `Writable` and `write` in `engine.ts`; `atomically` and `applyGroupChanges` gone from `Scim.ts`.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§3.3 Writable, the adapter table, §7 R2-R3)
@packages/scim/src/internal/engine.ts
@packages/scim/src/Scim.ts (atomically from ticket 02; applyUserChanges; applyGroupChanges from ticket 03; the four handlers)
@packages/ports/src/SqlTransaction.ts (:20-34)
@packages/scim/test/ScimAtomicity.test.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Writable and write in the engine</name>
  <files>packages/scim/src/internal/engine.ts</files>
  <read_first>packages/scim/src/internal/engine.ts, packages/scim/src/Scim.ts (ticket 02's helper)</read_first>
  <action>Export the `Writable<Owned, Changes, R, E>` interface of PLAN.md §3.3 and add `write(writable, operation)` to what `make` returns; `make` now also yields `SqlTransaction.SqlTransaction` once. `write` returns `(connection, id, changes)` where `changes` is an `Effect` failing `ScimBadRequest`, and runs, in this order: `writable.owned` (outside any unit: its 404 path may drop a stale mapping and that write must persist), then `changes`, then `writable.vet` (reads only), then `writable.apply` inside `sqlTransaction.withTransaction` with `SqlError` mapped by `Errors.storeUnavailable(operation)`, then `writable.render` after the unit. Document the order and the reason for each step in the interface's doc comments, one line each. Nothing inside the unit may catch a SQL failure and continue (Postgres aborts the transaction on a failed statement).</action>
  <verify><automated>npx tsc -b tsconfig.json && pnpm check:transactions</automated></verify>
  <acceptance_criteria>`grep -c 'withTransaction(' packages/scim/src/internal/engine.ts` = 1 (baseline after ticket 09: 0).</acceptance_criteria>
  <done>The write order exists once.</done>
</task>

<task type="auto">
  <name>Task 2: the user and group adapters; handlers become write calls</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts</read_first>
  <action>Define `userWritable` (owned `ownedUser`; vet = the `userName` mutability check moved out of `applyUserChanges`; apply = the rest of `applyUserChanges`; render = `userResource`) and `groupWritable` (owned `ownedGroup`; vet = `requireMembers(namedMembers(changes))` and the `externalId` pre-read from ticket 03; apply = roster, rename, mapping, `groupChanged` from ticket 03; render = `groupResource`). Then `replaceUser = (c, id, input) => writeUser(c, id, <the UserChanges replaceUser builds today, as an Effect>)`, `patchUser = (c, id, patch) => writeUser(c, id, interpretUserPatch(patch))`, `replaceGroup = (c, id, input) => writeGroup(c, id, groupReplacement(input))`, `patchGroup = (c, id, patch) => writeGroup(c, id, interpretGroupPatch(patch))`, with `writeUser = engine.write(userWritable, …)` per operation label ("Scim.replaceUser", "Scim.patchUser", "Scim.replaceGroup", "Scim.patchGroup"). `applyActive` keeps its own unit from ticket 02 (its other callers, `createUser`'s converge path and the deactivating `deleteUser`, need it); inside `write` it nests as a savepoint. Delete the now-unused ticket 02 helper's group/user call sites and ticket 03's shared group sequence function (its body is now `groupWritable`'s vet and apply); keep the helper only if `applyActive` still uses it, otherwise give `applyActive` a direct `sqlTransaction.withTransaction`. `ScimShape` does not change.</action>
  <verify><automated>npx tsc -b tsconfig.json && npx vitest run packages/scim/test</automated></verify>
  <acceptance_criteria>`grep -c 'engine.write(' packages/scim/src/Scim.ts` ≥ 2 (baseline 0). `grep -c 'applyGroupChanges' packages/scim/src/Scim.ts` = 0 (baseline after ticket 03: ≥ 3). `wc -l < packages/scim/src/Scim.ts` ≤ 1300 (baseline at HEAD: 1513).</acceptance_criteria>
  <done>The four handlers are one-line compositions over two adapters.</done>
</task>

<task type="auto">
  <name>Task 3: prove nothing moved</name>
  <files>packages/scim/test/ScimAtomicity.test.ts</files>
  <read_first>packages/scim/test/ScimAtomicity.test.ts</read_first>
  <action>Run the file unchanged; it must pass as it did after ticket 03. Only add, at the top of the file, one line to the header comment saying the cases now exercise `engine.write` through the `Scim` interface (no assertion changes). If a case fails, the cause is Task 2: fix the code, not the test. If `AWTHAQ_POSTGRES_URL` is available, run the file under it and record the result in Comments.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimAtomicity.test.ts packages/scim/test/ScimGroups.test.ts packages/scim/test/ScimUsers.test.ts</automated></verify>
  <acceptance_criteria>`git diff --stat packages/scim/test/ScimAtomicity.test.ts` shows only the header comment line changed.</acceptance_criteria>
  <done>The refactor is behaviour-preserving at the interface.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `/scim/v2` PUT/PATCH | every write now passes one ordered path |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-19 | Tampering | `engine.write` order | high | mitigate | Order fixed in one function; `ScimAtomicity.test.ts` unchanged and green |
| T-32-20 | Tampering | stale-mapping cleanup on 404 | medium | mitigate | `owned` outside the unit by construction; `ScimGroups.test.ts:223` |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:transactions
</verification>

<success_criteria>
One write path; four handlers over two adapters; `Scim.ts` ≤ 1300 lines; every SCIM test green with no assertion edits.
</success_criteria>

## Comments
