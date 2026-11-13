---
plan: 32-scim-resource-engine
ticket: 03
title: "Interpret a group PATCH or PUT completely before the first write"
type: tdd
wave: 2
depends_on: [02]
files_modified:
  - packages/scim/src/Scim.ts
  - packages/scim/test/ScimAtomicity.test.ts
  - packages/scim/test/ScimGroups.test.ts
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "On every backend, an unknown op, an empty, removed or over-long displayName, or a member the connection did not provision refuses the PATCH with nothing written (memory A1-A3 green)"
    - "On every backend, a PUT whose rename is vetoed keeps the old externalId (memory A4 green)"
    - "A path-less PATCH object applies displayName, externalId and members together (A6 green, both modes)"
    - "A PATCH with several member operations calls applyRoster once, with the net change (A8)"
  artifacts:
    - path: "packages/scim/src/Scim.ts"
      provides: "interpretGroupPatch, groupReplacement, namedMembers, settleRoster; one vet-then-apply sequence shared by replaceGroup and patchGroup"
      contains: "interpretGroupPatch"
  key_links:
    - from: "patchGroup / replaceGroup"
      to: "requireMembers(namedMembers(changes))"
      via: "every named member checked before the unit opens"
      pattern: "namedMembers\\("
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Give groups what users already have (`interpretUserPatch`, `Scim.ts:338-367`): a pure interpreter that turns the body into `GroupChanges`, refuses before any write, and lets `PUT` and `PATCH` share one vet-then-apply sequence. Engine-independent: the functions sit in `Scim.ts` beside `interpretUserPatch`; ticket 07 moves them.

Purpose: memory has no rollback (`SqlTransaction.layerNoop`), so the only way a refused request writes nothing there is to refuse before writing. Also fixes F5 (path-less objects) and aligns F8 (PATCH `displayName` length).
Output: the four pure functions, the shared sequence, memory A1–A4 and A6 (both modes) green, A8 added.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§3.2 the rule table and settleRoster semantics, §3.3 group adapter row, §3.4, Q3, Q6, Q7)
@packages/scim/src/Scim.ts (:285-367 UserChanges/interpretUserPatch, :1091-1151 requireMembers/applyRoster/replaceProvisioned, :1282-1408 renameGroup/replaceGroup/memberIdsOf/patchGroup)
@packages/scim/src/ScimApi.ts (:104 badRequest, :197-215 GroupInput/PatchRequest)
@packages/core/src/Erasure.ts (:95-100 Data.TaggedEnum + Data.taggedEnum, the repo's pattern)
@packages/scim/test/ScimAtomicity.test.ts
@packages/scim/test/ScimGroups.test.ts (:156-189, :339-387)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: the pure group interpreter</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (:282-367, :1323-1408)</read_first>
  <behavior>
    - [replace displayName "X"] gives displayName Some("X"); [remove displayName] and [replace displayName ""] and a 256-character name each fail ScimBadRequest
    - an op other than add/replace/remove (any case, trimmed) fails ScimBadRequest invalidSyntax with the existing message
    - [remove externalId] gives externalId Some(None); [replace externalId "e"] gives Some(Some("e"))
    - bare members: replace → Replace(ids), add → Add(ids), remove without ids → Clear, remove with ids → Remove(ids); members[value eq "x"]: add → Add([x]), remove → Remove([x]), replace → nothing
    - path-less object { displayName, externalId, members } yields all three; path-less remove applies to members only
    - settleRoster(steps, current): Replace sets, Add unions, Remove subtracts, Clear empties; add = final minus current, remove = current minus final; an id outside current and never added is never in remove
  </behavior>
  <action>Next to `interpretUserPatch`, add (module-level, not inside `make`): a `RosterStep` tagged enum with `Replace`, `Add`, `Remove` (each carrying `ids`) and `Clear`, declared with `Data.TaggedEnum` and constructed with `Data.taggedEnum` as `Erasure.ts:95-100` does; a `GroupChanges` interface (`displayName: Option<string>`, `externalId: Option<Option<string>>`, `roster: ReadonlyArray<RosterStep>`); `interpretGroupPatch(patch)` implementing PLAN.md §3.2's rule table row by row (reuse `stringOf`, `isRecord` and the members-id extraction that `memberIdsOf` does today, moved to module level); `groupReplacement(input)` for `PUT` (displayName trimmed and checked non-empty and at most 255 as `replaceGroup` does today, externalId `Some(stringOf(input.externalId))`, roster `[Replace(ids)]`); `namedMembers(changes)` (every id of every Add and Replace step, de-duplicated); `settleRoster(steps, current)` per PLAN.md §3.2. The 255 limit on PATCH is Q7's default; use the same message `replaceGroup` uses. Use one constant for 255 shared with `createGroup` and `replaceGroup`. No `as`, no return-type annotations on the Effect-returning consts.</action>
  <verify><automated>npx tsc -b tsconfig.json</automated></verify>
  <acceptance_criteria>`grep -c 'const interpretGroupPatch' packages/scim/src/Scim.ts` = 1 (baseline 0). `grep -c 'const settleRoster' packages/scim/src/Scim.ts` = 1 (baseline 0).</acceptance_criteria>
  <done>The interpreter compiles and requires nothing from the context.</done>
</task>

<task type="tdd">
  <name>Task 2: replaceGroup and patchGroup through one vet-then-apply sequence</name>
  <files>packages/scim/src/Scim.ts</files>
  <read_first>packages/scim/src/Scim.ts (:1298-1408 after ticket 02)</read_first>
  <action>Add one function inside `make`, `applyGroupChanges(connection, owned, changes, operation)`, used by both handlers. Before the unit (reads only): `requireMembers(connection, namedMembers(changes))`; when `changes.externalId` is `Some(Some(value))`, `records.findByExternalId(connection.id, "Group", value)` and refuse `409` "externalId is already provisioned" when it names another resource. Then, inside ticket 02's `atomically(operation, …)`: (1) roster first: read `provisionedMembers(connection, teamId)`, compute `settleRoster(changes.roster, current)`, and call `applyRoster` once only when `add` or `remove` is non-empty; (2) `renameGroup` when `displayName` is `Some` and differs from the team's name; (3) `records.setExternalId` when `externalId` is `Some`, keeping today's `ScimLinkConflict`/`ScimRecordNotFound` mapping (a lost race ends the unit); (4) `groupChanged(connection, id, "updated")` (always, as today). Return the updated `{ link, team }`. `patchGroup` becomes: `ownedGroup` (outside the unit), `interpretGroupPatch`, `applyGroupChanges(…, "Scim.patchGroup")`, `groupResource`. `replaceGroup` becomes: `ownedGroup`, `groupReplacement`, `applyGroupChanges(…, "Scim.replaceGroup")`, `groupResource`. Keep the 404-before-400 precedence (the owned lookup comes first, as today). Delete the old helper that replaced the provisioned members (`Scim.ts:1140-1151`) and the inline loop; `memberIdsOf` moved to module level in Task 1. Order rationale for the code comment: the roster goes first because `applyRoster` refuses before it writes and its refusals are the likeliest; the mapping goes last because its refusal is pre-read.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimGroups.test.ts packages/scim/test/ScimHttp.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'replaceProvisioned' packages/scim/src/Scim.ts` = 0 (baseline 3). `grep -c 'Unknown patch op' packages/scim/src/Scim.ts` = 2 (one in each interpreter; baseline 2, ticket 07 makes it 1 file). Existing `ScimGroups.test.ts` cases green, including "PATCH and PUT removals fire AfterRemoveTeamMember" and "PATCH add beyond maximumMembersPerTeam is 403 and changes no member".</acceptance_criteria>
  <done>PUT and PATCH share one sequence that refuses before writing and writes in one unit.</done>
</task>

<task type="tdd">
  <name>Task 3: flip the memory cases; add A8</name>
  <files>packages/scim/test/ScimAtomicity.test.ts, packages/scim/test/ScimGroups.test.ts</files>
  <read_first>packages/scim/test/ScimAtomicity.test.ts</read_first>
  <behavior>
    - A8 (memory and SQL): provisioned ada and bo; group with no members; PATCH [add [ada], add [bo], replace members [bo]] leaves members [bo]; the audit log holds exactly one `auth.organization.teamMemberAdded` row for this team (bo), none for ada
  </behavior>
  <action>Change every remaining `it.effect.fails` in `ScimAtomicity.test.ts` to `it.effect` (memory A1–A4, A6; SQL A6). Add A8 in both modes as plain `it.effect` (it pins Q3's default; if Q3 is answered "per operation", drop A8). In `ScimGroups.test.ts` change nothing unless a case asserted per-operation event counts; if one did, say so in Comments and update it to the net count with the PLAN.md Q3 reference.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimAtomicity.test.ts packages/scim/test/ScimGroups.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'it.effect.fails' packages/scim/test/ScimAtomicity.test.ts` = 0 (baseline after ticket 02: 6). A8 present in both modes.</acceptance_criteria>
  <done>F1, F3 and F5 are fixed on memory too; the event cardinality is pinned.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `/scim/v2` | PATCH bodies are decoded loosely on purpose (`ScimApi.ts:204`); the interpreter is where they are judged |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-08 | Tampering | `interpretGroupPatch` | high | mitigate | Every op judged before any write; unknown ops refused; unmanaged attributes ignored (BEH-EA-248 rule) |
| T-32-09 | Elevation of privilege | roster fold | high | mitigate | `settleRoster` can only remove ids in the provisioned set, so a directory can never remove a hand-added member (BEH-EA-251); property in ticket 07 |
| T-32-10 | Denial of service | huge `Operations` arrays | low | accept | Linear fold; the request body limit applies upstream |
| T-32-11 | Tampering | `externalId` race between pre-read and write | low | mitigate | SQL: the unique index refuses inside the unit, which rolls back. Memory: DRS-006 |
</threat_model>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Zero `.fails` left in `ScimAtomicity.test.ts`; A8 green on both modes; every pre-existing SCIM test green.
</success_criteria>

## Comments
