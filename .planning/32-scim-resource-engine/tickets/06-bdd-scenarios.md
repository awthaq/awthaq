---
plan: 32-scim-resource-engine
ticket: 06
title: "BDD: REQ-EA-1530 to 1533 (atomic group writes, path-less object, scoped name filter)"
type: execute
wave: 4
depends_on: [03, 04]
files_modified:
  - features/features/13-enterprise-federation/30-scim.feature
  - features/step-definitions/ScimSteps.ts
  - features/step-definitions/ScimWorld.ts
  - features/traceability.md
autonomous: true
requirements: [REQ-EA-1530, REQ-EA-1531, REQ-EA-1532, REQ-EA-1533]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "Four scenarios tagged REQ-EA-1530..1533 pass over HTTP in pnpm test:bdd"
    - "features/traceability.md lists them against BEH-EA-350/351"
  artifacts:
    - path: "features/features/13-enterprise-federation/30-scim.feature"
      provides: "the four scenarios"
      contains: "@REQ-EA-1533"
    - path: "features/step-definitions/ScimWorld.ts"
      provides: "vetoUpdateTeam option, a BeforeUpdateTeam tap refusing one name"
  key_links:
    - from: "30-scim.feature"
      to: "ScimSteps.ts"
      via: "existing group steps (:758-945) plus the few new ones"
      pattern: "patches the group"
---
Status: done (uncommitted)
Blocked by: 03, 04

<objective>
Add the four acceptance scenarios of PLAN.md §6.4 to the SCIM feature, reusing the existing group steps and adding only what is missing.

Purpose: BDD is the wire-level record of BEH-EA-350/351 (shared conventions: every behaviour change updates the BDD where it exists).
Output: four scenarios, a `vetoUpdateTeam` world option, regenerated `features/traceability.md`.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§6.4)
@features/features/13-enterprise-federation/30-scim.feature (:520-620 the group scenarios)
@features/step-definitions/ScimWorld.ts (:56-71 the veto taps and their options)
@features/step-definitions/ScimSteps.ts (:255-278 veto Givens, :479-536 admin team Givens, :758-945 group steps)
@features/scripts/allocate-req-ea.py (:1-12: an existing tag is kept)
@features/STYLE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: world option and steps</name>
  <files>features/step-definitions/ScimWorld.ts, features/step-definitions/ScimSteps.ts</files>
  <read_first>features/step-definitions/ScimWorld.ts, features/step-definitions/ScimSteps.ts, features/STYLE.md</read_first>
  <action>In `ScimWorld.ts` add a `vetoUpdateTeam?: string` option beside `vetoCreateTeam`: when set, an `OrganizationHooks.BeforeUpdateTeam` tap refuses a rename to that exact name (`HookPoint.HookAbort` with code "TEAM_POLICY"), and passes every other input through; wire it where `VetoCreateTeam` is wired. In `ScimSteps.ts` add only the steps the four scenarios need and that do not exist yet: a Given "a beforeUpdateTeam hook that refuses renaming a team to {string}" (calls `configureApp({ vetoUpdateTeam })`); a When "{string} patches the group {string} renaming it to {string} and adding the members {string}" (one PATCH, two operations, rename first); a When "{string} patches the group {string} with a path-less object renaming it to {string} with the members {string}"; a When "{string} replaces the group {string} with displayName {string} and externalId {string}"; a When "{string} lists groups with the filter {string}" if the existing list step (:945) cannot carry a filter; Then steps "the group {string} still has displayName {string}" and "the group {string} still has externalId {string}" if no equivalent exists. Follow STYLE.md for wording.</action>
  <verify><automated>npx tsc -p features/tsconfig.json --noEmit</automated></verify>
  <acceptance_criteria>`grep -c 'vetoUpdateTeam' features/step-definitions/ScimWorld.ts` ≥ 2 (baseline 0).</acceptance_criteria>
  <done>The world can veto a rename; the new steps compile.</done>
</task>

<task type="auto">
  <name>Task 2: the four scenarios and traceability</name>
  <files>features/features/13-enterprise-federation/30-scim.feature, features/traceability.md</files>
  <read_first>features/features/13-enterprise-federation/30-scim.feature (:486-620)</read_first>
  <action>After REQ-EA-1293's scenario add, tagged by hand: @REQ-EA-1530 "A PATCH that renames a group and then adds a user the connection did not provision is 400 and the group keeps its name" (Then 400, scimType invalidValue, the group still has displayName "Eng"); @REQ-EA-1531 "A PUT whose rename a veto hook refuses is 403 and the group keeps its externalId" (group "Eng" with externalId "grp-1"; the hook refuses "Vetoed"; PUT displayName "Vetoed", externalId "grp-2"; Then 403 and externalId "grp-1"); @REQ-EA-1532 "A path-less PATCH object renames the group and replaces its members together"; @REQ-EA-1533 "A displayName filter lists only the connection's own group, never a same-named team an administrator created" (use the existing Given "a team {string} that an organization admin created in the organization of {string}", :479). Then regenerate `features/traceability.md` with `python3 features/scripts/allocate-req-ea.py`; confirm the four rows name BEH-EA-350 or BEH-EA-351 (ticket 05 adds those anchors; if this ticket lands first, the rows name BEH-EA-251/252 and ticket 11 re-runs the generator).</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`grep -c '@REQ-EA-153[0-3]' features/features/13-enterprise-federation/30-scim.feature` = 4 (baseline 0). `grep -c 'REQ-EA-153[0-3]' features/traceability.md` = 4 (baseline 0).</acceptance_criteria>
  <done>The four scenarios pass over HTTP and are traced.</done>
</task>

</tasks>

<verification>
pnpm test:bdd
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Four tagged scenarios green; traceability regenerated; no existing scenario changes its tag.
</success_criteria>

## Comments
