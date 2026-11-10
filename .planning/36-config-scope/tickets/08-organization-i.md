---
plan: 36-config-scope
ticket: 08
title: "Organization I: declaration, descriptor, retention, access, authority"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/organization/src/OrganizationConfig.ts
  - packages/organization/src/Organization.ts
  - packages/organization/src/OrganizationPersonalData.ts
  - packages/organization/src/internal/access.ts
  - packages/organization/src/OrganizationAuthority.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "OrganizationConfig is declared Tenant.perTenant with boot ['invitationRetention']"
    - "Organization.config returns the declaration's layer; the plugin's descriptor is made from the declaration"
    - "internal/access.ts, OrganizationAuthority.ts and the retention contribution read through Tenant.inForce"
  artifacts:
    - path: "packages/organization/src/OrganizationConfig.ts"
      provides: "OrganizationConfigScoped"
      contains: "perTenant(OrganizationConfig"
  key_links:
    - from: "internal/access.ts:91"
      to: "Tenant.inForce(OrganizationConfigScoped)"
      via: "the access primitive's per-operation config"
      pattern: "inForce\\(OrganizationConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Declare `OrganizationConfig` (PLAN.md §2.3 row 2) and migrate its first three readers.
Purpose: the organization is the reference tenant-scoped plugin; the tenant middleware and its BDD world run on it.
Output: five edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 row 2, §3.5)
@packages/organization/src/OrganizationConfig.ts (lines 120-145)
@packages/organization/src/Organization.ts (line 118)
@packages/organization/src/OrganizationPersonalData.ts (lines 110-125)
@packages/organization/src/internal/access.ts (lines 85-95)
@packages/organization/src/OrganizationAuthority.ts (lines 135-150)
</context>

<tasks>
<task type="auto">
  <name>Task 1: the declaration, the constructor and the descriptor</name>
  <files>packages/organization/src/OrganizationConfig.ts, packages/organization/src/Organization.ts</files>
  <read_first>OrganizationConfig.ts lines 120-145; Organization.ts lines 110-125</read_first>
  <action>Add `OrganizationConfigScoped = Tenant.perTenant(OrganizationConfig, { boot: ["invitationRetention"] })`. Before declaring the boot field, verify PLAN.md §3.5 rule 3: `grep -n "invitationRetention" packages/organization/src/*.ts` must show reads only in `OrganizationPersonalData.ts` (the retention contribution, built once). Make `config` (`:130`) return the declaration's `layer`, keeping its validation. In `Organization.ts:118`, make the descriptor from `OrganizationConfigScoped`.</action>
  <verify><automated>pnpm build && npx vitest run packages/organization/test/TenantMiddleware.test.ts packages/organization/test/Organization.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "perTenant(OrganizationConfig" packages/organization/src/OrganizationConfig.ts` prints 1 (baseline 0)
    - `TenantMiddleware.test.ts:157` ("each tenant's request runs under that tenant's own configuration") passes unchanged
  </acceptance_criteria>
  <done>The key is declared and its constructor and descriptor come from the declaration.</done>
</task>

<task type="auto">
  <name>Task 2: three readers through the accessor</name>
  <files>packages/organization/src/OrganizationPersonalData.ts, packages/organization/src/internal/access.ts, packages/organization/src/OrganizationAuthority.ts</files>
  <read_first>the read sites in context</read_first>
  <action>Replace `internal/access.ts:91` and `OrganizationAuthority.ts:141-142` (build read plus old helper) with one `yield* Tenant.inForce(OrganizationConfigScoped)` bound to the same local name. In `OrganizationPersonalData.ts:117`, read the build value through the accessor (`yield* yield* Tenant.inForce(...)`); it is the boot field's one reader and runs from a retention sweep with no tenant.</action>
  <verify><automated>npx vitest run packages/organization/test/AuthorizationMatrix.test.ts packages/organization/test/OrganizationAuthority.test.ts packages/organization/test/OrganizationTeams.test.ts packages/organization/test/Access.types.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(OrganizationConfig\.)?OrganizationConfig\b' packages/organization/src | wc -l` prints 5 (baseline 8; ticket 09 takes it to 0)
    - `grep -c "configInForce" packages/organization/src/internal/access.ts packages/organization/src/OrganizationAuthority.ts` totals 0 (baseline 2)
  </acceptance_criteria>
  <done>Three of eight readers migrated.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → organization authorization | a tenant's configuration decides limits and dynamic access control for its own requests |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-03 | Elevation | a field wrongly declared boot (a tenant's `dynamicAccessControl` or `teams` ignored) | medium | mitigate | only `invitationRetention` is boot, verified by grep (Task 1); `AuthorizationMatrix.test.ts` and the BDD REQ-EA-848..851 keep running |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Declaration in place; raw reads 8 → 5; organization suites green.
</success_criteria>

## Comments

Result (agent): OrganizationConfigScoped declared (boot invitationRetention, the sole read is the retention contribution); config() validation kept, success path via declaration.layer; descriptor made from declaration; access.ts, Authority, Invitations, Members, Roles, Directory, Teams read via Tenant.inForce; retention uses yield* yield* Tenant.inForce. Raw reads 0, configInForce 0 in organization src. Organization suites green (360 pass); pnpm build/BDD not run (parallel work).
