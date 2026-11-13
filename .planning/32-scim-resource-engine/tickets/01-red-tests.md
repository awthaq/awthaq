---
plan: 32-scim-resource-engine
ticket: 01
title: "Red tests: SCIM write atomicity (memory, SQL) and the group-listing cap"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/scim/test/support.ts
  - packages/scim/test/ScimAtomicity.test.ts
  - packages/scim/test/ScimGroupsListing.test.ts
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532, REQ-EA-1533]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Every live bug of PLAN.md §2.6 (F1-F6) has a test that fails at HEAD for the asserted reason, not for a setup error"
    - "The tree stays green: each red case is committed as it.effect.fails"
    - "A connection-scoping case (L2) passes at HEAD and keeps passing through ticket 04"
  artifacts:
    - path: "packages/scim/test/ScimAtomicity.test.ts"
      provides: "A1-A7, memory and SQL"
      contains: "it.effect.fails"
    - path: "packages/scim/test/ScimGroupsListing.test.ts"
      provides: "L1 (past the 10,000th group), L2 (connection scoping)"
    - path: "packages/scim/test/support.ts"
      provides: "ScimLiveSql"
      exports: ["ScimLiveSql"]
  key_links:
    - from: "packages/scim/test/support.ts ScimLiveSql"
      to: "TestAuth.layer(built, { records: \"sql\", suite })"
      via: "the same composition as ScimLive over SQLite (Postgres under AWTHAQ_POSTGRES_URL)"
      pattern: "records: \"sql\""
---
Status: done (uncommitted)
Blocked by: none

<objective>
Turn every live bug of PLAN.md §2.6 into a failing test before any fix, so tickets 02–04 are measured by flipping them.

Purpose: F1–F6 were found by reading. A red test proves each one and pins the exact state a refused write must leave behind.
Output: `ScimLiveSql` in `support.ts`; `ScimAtomicity.test.ts` with 12 `it.effect.fails` cases; `ScimGroupsListing.test.ts` with 1 `it.effect.fails` case (L1) and 1 passing case (L2).
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§2.4, §2.6, §5.1)
@packages/scim/test/support.ts
@packages/scim/test/ScimGroups.test.ts (helpers `user`, `patchGroup`, `memberIds`; the `deny` tap at :262 and `withTaps` at :257)
@packages/scim/test/ScimUsers.test.ts (:399-432: `sessions.issue`, `sessions.verify`, `TestAuth.withoutRequest`)
@packages/organization/test/OrganizationTeams.test.ts (:803-880: `TestAuth.layer(built, { records: "sql", suite, services })`, `countRows`, `TestSql.injectFailure`)
@packages/test/src/TestSql.ts (:90-122 `injectFailure`)
@packages/sql/src/SessionStoreSql.ts (:265-269: `revokeAll` is a `DELETE FROM sessions`)
@packages/scim/src/Scim.ts (:714-748 applyActive, :1298-1408 replaceGroup / patchGroup, :1153-1181 listGroups)
</context>

<tasks>

<task type="tdd">
  <name>Task 1: ScimLiveSql in support.ts</name>
  <files>packages/scim/test/support.ts</files>
  <read_first>packages/scim/test/support.ts, packages/organization/test/OrganizationTeams.test.ts (:805-809), packages/test/src/TestAuth.ts (:260-345, the SqlMode option)</read_first>
  <action>Add an exported `ScimLiveSql(suite, organizationConfig = {}, taps = Layer.empty)` next to `ScimLive`. It calls `TestAuth.layer(built, { records: "sql", suite, services: Layer.mergeAll(Scim.config({}), Organization.config({ teams: groupsTeams, ...organizationConfig })), taps })`, with the same `taps` type as `ScimLive`'s fourth parameter. No `users` decoration (no SQL case needs one). Keep the doc-comment style of the file: one line saying it is the same composition over SQLite `:memory:` (a per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`). If `TestAuth.layer` does not accept `taps` together with `records: "sql"`, stop and record the type error in Comments; do not cast.</action>
  <verify><automated>npx tsc -p tsconfig.test.json --noEmit</automated></verify>
  <acceptance_criteria>`grep -c 'export const ScimLiveSql' packages/scim/test/support.ts` = 1 (baseline at HEAD: 0). No `as` in the new function.</acceptance_criteria>
  <done>`ScimLiveSql` type-checks and builds the composition over SQL.</done>
</task>

<task type="tdd">
  <name>Task 2: ScimAtomicity.test.ts, A1-A7</name>
  <files>packages/scim/test/ScimAtomicity.test.ts</files>
  <read_first>packages/scim/test/ScimGroups.test.ts, packages/scim/test/ScimUsers.test.ts (:399-432), packages/organization/test/OrganizationTeams.test.ts (:811-880)</read_first>
  <behavior>
    - A1 (memory, SQL): group "Eng" with no members; PATCH [replace displayName "Platform", add members [{ value: "not-a-user" }]] fails ScimBadRequest; afterwards getGroup has displayName "Eng" and no members; the audit log has no `auth.organization.teamUpdated` row (`AuditLog.list({ eventTag })`).
    - A2 (memory, SQL): provisioned user ada; PATCH [add members [ada], { op: "frobnicate", path: "displayName", value: "X" }] fails ScimBadRequest with scimType "invalidSyntax"; afterwards the group has no members.
    - A3 (memory, SQL): PATCH [replace displayName "Platform", replace displayName ""] fails ScimBadRequest; afterwards displayName is "Eng".
    - A4 (memory, SQL): group "Eng" with externalId "grp-1"; a `OrganizationHooks.BeforeUpdateTeam` tap refuses the name "Vetoed"; PUT { displayName: "Vetoed", externalId: "grp-2", members: [] } fails ScimForbidden; afterwards getGroup has externalId "grp-1" and displayName "Eng".
    - A5 (SQL only): the same tap; PATCH [add members [ada], replace displayName "Vetoed"] fails ScimForbidden; afterwards the group has no members and the audit log has no `auth.organization.teamMemberAdded` row.
    - A6 (memory, SQL): PATCH [{ op: "replace", value: { displayName: "Platform", members: [{ value: ada }] } }] returns displayName "Platform" and members [ada]; then PATCH [{ op: "replace", value: { externalId: "grp-9" } }] returns externalId "grp-9".
    - A7 (SQL only): provisioned user, one session issued; `TestSql.injectFailure({ name: "fail_sessions_delete", table: "sessions", event: "DELETE" })`; PATCH [replace active false] fails StoreUnavailable; afterwards `users.findById` has status "active" and the session still verifies. Then drop the trigger (`DROP TRIGGER fail_sessions_delete`, add `ON sessions` on Postgres via `sql.onDialectOrElse`), PATCH again: the user is suspended and the session no longer verifies.
  </behavior>
  <action>Create the file with a header comment naming BEH-EA-251, BEH-EA-249 and plan 32 tickets 01–03, and saying why there is no memory A5 or A7 (memory has no rollback and no outages: `SqlTransaction.layerNoop`, DRS-006, PLAN.md §3.4). Structure: one `describe` per mode, built from `TestAuth.recordModes` where a case runs in both, each case its own `it.effect.fails` with the mode in its name (for example "A1 memory: …"). Memory cases provide `ScimLive({}, {}, undefined, taps)`; SQL cases provide `ScimLiveSql("scim_atomicity", {}, taps)`. Every case seeds its own connection with a distinct name (`seedConnection("a1-memory", "owner-a1-memory")`, …) so organization slugs never collide on a shared Postgres schema. Build the veto tap like `ScimGroups.test.ts` does (`HookPoint.HookAbort`, `input.name === "Vetoed" ? deny : Effect.succeed(input)`). Wrap user cases in `TestAuth.withoutRequest` as `ScimUsers.test.ts` does. Before marking any case `.fails`, run it once as a plain `it.effect` and copy the failing assertion message into this ticket's Comments; a case that fails in setup (seeding, layer build) is a broken test, not a red one, and must be fixed first. Then switch each to `it.effect.fails`. Expected `.fails` count: 12 (memory A1, A2, A3, A4, A6; SQL A1, A2, A3, A4, A5, A6, A7).</action>
  <verify><automated>npx vitest run packages/scim/test/ScimAtomicity.test.ts</automated></verify>
  <acceptance_criteria>The file passes under vitest (every `.fails` case fails as expected). `grep -c 'it.effect.fails' packages/scim/test/ScimAtomicity.test.ts` = 12 (baseline: the file does not exist). Comments lists the 12 observed failure messages.</acceptance_criteria>
  <done>Each of F1, F2, F3, F5, F6 is shown failing on the backends PLAN.md §2.6 names.</done>
</task>

<task type="tdd">
  <name>Task 3: ScimGroupsListing.test.ts, L1 and L2</name>
  <files>packages/scim/test/ScimGroupsListing.test.ts</files>
  <read_first>packages/scim/src/ScimRecords.ts (:388-397 list ordering), packages/organization/src/TeamRecords.ts (createTeam signature), packages/scim/test/ScimGroups.test.ts (:191-221 list filters)</read_first>
  <behavior>
    - L1 (memory, it.effect.fails, timeout 60 seconds): with one connection, seed 10,000 groups through the record stores directly (`TeamRecords.createTeam({ organizationId, name: "filler-n" })` then `ScimRecords.link({ connectionId, kind: "Group", resourceId, externalId: "filler-n" })`), then `TestClock.adjust` one second, then seed the needle the same way (name "Needle", externalId "needle"). `listGroups(filter displayName eq "Needle")` has totalResults 1 and the needle's id; `listGroups(filter externalId eq "needle")` likewise; `listGroups({ startIndex: 10001, count: 1 })` returns the needle.
    - L2 (memory and SQL, plain it.effect, passes at HEAD): connection A creates group "Eng"; an administrator creates a team "Eng" through `OrganizationTeams.create(OrganizationActor.application("test"), …)`; connection B (a second connection of the same organization, `ScimConnections.ScimConnectionStore.create`) creates its own group "Eng". `listGroups(A, displayName eq "Eng")` returns exactly A's group, totalResults 1.
  </behavior>
  <action>Create the file with a header naming BEH-EA-252 (and BEH-EA-351, which ticket 05 adds) and plan 32. Yield `TeamRecords.TeamRecords` from `@awthaq/organization/records` and `ScimRecords.ScimRecords` from `../src/ScimRecords.ts` out of the `ScimLive()` composition, as `ScimGroups.test.ts` and `ScimHttp.test.ts` do. Seed in a plain loop (`Effect.forEach` with the default sequential concurrency). Pass the 60-second timeout as the third argument of `it.effect.fails`. Before marking L1 `.fails`, run it once as `it.effect` and record in Comments which of its three assertions fails first and its message (expected: totalResults 0 for the displayName filter). L2 is the regression guard ticket 04 must keep green: it proves the name lookup stays scoped to the calling connection.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimGroupsListing.test.ts</automated></verify>
  <acceptance_criteria>The file passes. `grep -c 'it.effect.fails' packages/scim/test/ScimGroupsListing.test.ts` = 1 (baseline: no file). L2 runs in both record modes and passes.</acceptance_criteria>
  <done>F4 is shown failing; connection scoping is pinned before the listing changes.</done>
</task>

</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| directory → `/scim/v2` | A bearer-token holder sends PATCH/PUT bodies and filters it fully controls |

## STRIDE threat register

| Threat ID | Category | Where | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-32-01 | Tampering | group PATCH loop | high | mitigate | A1–A6 pin "nothing written" for every refusal; fixed by 02/03 |
| T-32-02 | Elevation of privilege | team roster after a vetoed rename | high | mitigate | A5 pins that a host veto refusal leaves no member added (SQL) |
| T-32-03 | Information disclosure | `displayName eq` lookup | medium | mitigate | L2 pins that another connection's or an administrator's same-named team is never listed |
</threat_model>

<verification>
npx vitest run packages/scim/test/ScimAtomicity.test.ts packages/scim/test/ScimGroupsListing.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
(knip: only `.reports/` files may be reported, IMPLEMENTING.md)
</verification>

<success_criteria>
13 `.fails` cases committed (12 + 1), each with its observed failure recorded below; L2 green on memory and SQL; full gate green.
</success_criteria>

## Comments

Done with deviations: BEH ids taken as BEH-EA-348/349 (plan 31 holds 347; spec:verify:strict rejects gaps). Red cases were written as passing tests after confirming each fails against HEAD (no it.effect.fails stage). L1 and A1-A8 as described; memory A5/A7 not applicable.
