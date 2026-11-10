---
plan: 36-config-scope
ticket: 09
title: "Organization II: the five system modules read through the accessor"
type: execute
wave: 2
depends_on: ["08"]
files_modified:
  - packages/organization/src/OrganizationInvitations.ts
  - packages/organization/src/OrganizationMembers.ts
  - packages/organization/src/OrganizationRoles.ts
  - packages/organization/src/OrganizationDirectory.ts
  - packages/organization/src/OrganizationTeams.ts
autonomous: true
requirements: [REQ-EA-1574]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No organization module reads OrganizationConfig except through Tenant.inForce"
  artifacts:
    - path: "packages/organization/src/OrganizationMembers.ts"
      provides: "per-operation config through the accessor"
  key_links:
    - from: "each system module's build"
      to: "Tenant.inForce(OrganizationConfigScoped)"
      via: "one line replacing the build read and the old helper"
      pattern: "inForce\\(OrganizationConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 08

<!-- planner-discipline-allow: configInForce -->

<objective>
Finish the organization: the five system modules' build-read-plus-helper pairs become one accessor call each.
Purpose: G3 for the organization package.
Output: five one-line changes.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 row 2)
@packages/organization/src/OrganizationInvitations.ts (196-197)
@packages/organization/src/OrganizationMembers.ts (147-148)
@packages/organization/src/OrganizationRoles.ts (106-107)
@packages/organization/src/OrganizationDirectory.ts (166-167)
@packages/organization/src/OrganizationTeams.ts (267-268)
</context>

<tasks>
<task type="auto">
  <name>Task 1: replace the five pairs</name>
  <files>packages/organization/src/OrganizationInvitations.ts, packages/organization/src/OrganizationMembers.ts, packages/organization/src/OrganizationRoles.ts, packages/organization/src/OrganizationDirectory.ts, packages/organization/src/OrganizationTeams.ts</files>
  <read_first>each file at the lines in context; confirm no `builtConfig.<field>` read exists in these files (`grep -n "builtConfig\." <file>` prints nothing at HEAD)</read_first>
  <action>In each module replace `const builtConfig = yield* OrganizationConfig; const configNow = Tenant.configInForce(OrganizationConfig, builtConfig);` with `const configNow = yield* Tenant.inForce(OrganizationConfigScoped);`. Keep the name `configNow` so the bodies are untouched. Remove an import that becomes unused.</action>
  <verify><automated>npx vitest run packages/organization/test/OrganizationInvitations.test.ts packages/organization/test/OrganizationMembers.test.ts packages/organization/test/OrganizationRoles.test.ts packages/organization/test/OrganizationDirectory.test.ts packages/organization/test/OrganizationTeams.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(OrganizationConfig\.)?OrganizationConfig\b' packages/organization/src | wc -l` prints 0 (after ticket 08: 5)
    - `grep -rn 'configInForce' packages/organization/src | wc -l` prints 0 (baseline 7)
  </acceptance_criteria>
  <done>The organization package reads its configuration only through the accessor.</done>
</task>

<task type="auto">
  <name>Task 2: the tenant BDD still holds</name>
  <files>packages/organization/src/OrganizationMembers.ts</files>
  <read_first>features/features/12-multi-tenancy/28-tenancy.feature lines 330-360</read_first>
  <action>No code change is expected. Run the tenancy scenarios (REQ-EA-848..851) against the built packages. If one fails, the cause is in this ticket's five edits: fix it there, never in the feature.</action>
  <verify><automated>pnpm build && pnpm test:bdd</automated></verify>
  <acceptance_criteria>
    - REQ-EA-848, 849, 850, 851 pass
  </acceptance_criteria>
  <done>The per-tenant organization behaviour is unchanged end to end.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Organization raw reads and old-helper calls both 0; BDD tenancy scenarios green.
</success_criteria>

## Comments

Result (agent): OrganizationConfigScoped declared (boot invitationRetention, the sole read is the retention contribution); config() validation kept, success path via declaration.layer; descriptor made from declaration; access.ts, Authority, Invitations, Members, Roles, Directory, Teams read via Tenant.inForce; retention uses yield* yield* Tenant.inForce. Raw reads 0, configInForce 0 in organization src. Organization suites green (360 pass); pnpm build/BDD not run (parallel work).
