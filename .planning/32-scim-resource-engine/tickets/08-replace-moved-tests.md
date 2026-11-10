---
plan: 32-scim-resource-engine
ticket: 08
title: "Replace, don't layer: delete the composition cases ScimProtocol.test.ts now proves"
type: execute
wave: 6
depends_on: [07]
files_modified:
  - packages/scim/test/ScimFilter.property.test.ts
  - packages/scim/test/ScimUsers.test.ts
  - packages/scim/test/ScimGroups.test.ts
autonomous: true
requirements: [REQ-EA-1530]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Every parser-only assertion lives in ScimProtocol.test.ts, not also in a composition suite"
    - "Every composition case that remains tests something only a composition can show (store, team module, sessions)"
  artifacts:
    - path: "packages/scim/test/ScimFilter.property.test.ts"
      provides: "the two end-to-end filter properties only"
  key_links:
    - from: "deleted assertions"
      to: "packages/scim/test/ScimProtocol.test.ts"
      via: "each deleted assertion has a named pure counterpart"
      pattern: "parseFilter|interpretUserPatch|interpretGroupPatch"
---
Status: ready-for-agent
Blocked by: 07

<objective>
Delete the composition-level assertions that re-test behaviour ticket 07 moved to the pure protocol module (shared convention: replace, don't layer).

Purpose: one place proves each rule; the composition suites keep only what needs a composition, and the slowest property tests stop building a composition per run.
Output: three edited test files; a mapping of each deletion to its pure counterpart in Comments.
</objective>

<context>
@.planning/32-scim-resource-engine/PLAN.md (§5.2)
@packages/scim/test/ScimProtocol.test.ts
@packages/scim/test/ScimFilter.property.test.ts (:38, :50, :81, :112)
@packages/scim/test/ScimUsers.test.ts (:368-397)
@packages/scim/test/ScimGroups.test.ts (:156-189)
</context>

<tasks>

<task type="auto">
  <name>Task 1: delete the parser-only filter properties</name>
  <files>packages/scim/test/ScimFilter.property.test.ts</files>
  <read_first>packages/scim/test/ScimFilter.property.test.ts, packages/scim/test/ScimProtocol.test.ts</read_first>
  <action>Delete the property "only `attr eq "value"` is supported: any other operator on a supported attribute is 400 invalidFilter" (`:50-79`) and the property "an attribute the resource type does not support (userName on Groups, displayName on Users) is 400 invalidFilter, whatever the value" (`:112-128`), after confirming each has a pure counterpart in `ScimProtocol.test.ts` (name it in Comments). Keep the "never a defect" property (`:38`) and the "finds exactly the user" property (`:81`): they exercise the list path end to end. Update the header comment to say the parser's own properties are in `ScimProtocol.test.ts`. Remove imports that become unused.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimFilter.property.test.ts packages/scim/test/ScimProtocol.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'it.effect.prop' packages/scim/test/ScimFilter.property.test.ts` = 2 (baseline at HEAD: 4).</acceptance_criteria>
  <done>The filter parser is property-tested once, purely.</done>
</task>

<task type="auto">
  <name>Task 2: trim the PATCH-form assertions</name>
  <files>packages/scim/test/ScimUsers.test.ts, packages/scim/test/ScimGroups.test.ts</files>
  <read_first>packages/scim/test/ScimUsers.test.ts (:368-397), packages/scim/test/ScimGroups.test.ts (:156-189), packages/scim/test/ScimAtomicity.test.ts (A1)</read_first>
  <action>In `ScimUsers.test.ts`, in the case "PATCH accepts Okta's path-less object, Entra's capitalized ops and string booleans, and ignores attributes it does not manage" (`:368`): delete the `malformed` unknown-op assertion and the `title` ignored-attribute part of the Okta call (both proven by `ScimProtocol.test.ts`); keep the Okta displayName apply, the Entra given-name join with the stored family name, the `"False"` suspension and the externalId clear (they test `applyUserChanges` against the user store); rename the case to say it tests how those forms are applied. In `ScimGroups.test.ts`, in "PATCH adds, removes and replaces members and renames (RFC 7644 forms)" (`:156`): delete the trailing non-member assertion (A1 in `ScimAtomicity.test.ts` proves it with the stronger "nothing written"). List each deletion and its counterpart in Comments.</action>
  <verify><automated>npx vitest run packages/scim/test/ScimUsers.test.ts packages/scim/test/ScimGroups.test.ts</automated></verify>
  <acceptance_criteria>`grep -c 'frobnicate' packages/scim/test/ScimUsers.test.ts` = 0 (baseline at HEAD: 1). `grep -c 'not-a-user' packages/scim/test/ScimGroups.test.ts` = 0 (baseline at HEAD: 1, at `:185`).</acceptance_criteria>
  <done>No PATCH-form rule is asserted in two places.</done>
</task>

</tasks>

<verification>
npx vitest run packages/scim/test
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Two filter properties and two form assertions removed, each mapped to a pure counterpart; every SCIM suite green.
</success_criteria>

## Comments
