---
plan: 36-config-scope
ticket: 18
title: "Two-factor and roles: deployment-scoped declarations"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/two-factor/src/TwoFactorConfig.ts
  - packages/two-factor/src/TwoFactor.ts
  - packages/two-factor/src/SecondFactor.ts
  - packages/roles/src/Roles.ts
  - packages/roles/src/RolesAdmin.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573, REQ-EA-1576]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "TwoFactorConfig and RolesConfig are declared Tenant.perDeployment"
    - "Both config(...) constructors return the declaration's layer (Roles.config loses its Layer.Layer<never> annotation)"
    - "Every TwoFactorConfig and RolesConfig read goes through Tenant.inForce"
    - "Both descriptors are made from the declarations"
  artifacts:
    - path: "packages/two-factor/src/TwoFactorConfig.ts"
      provides: "TwoFactorConfigScoped"
      contains: "Tenant.perDeployment(TwoFactorConfig)"
    - path: "packages/roles/src/Roles.ts"
      provides: "RolesConfigScoped"
      contains: "Tenant.perDeployment(RolesConfig)"
  key_links:
    - from: "TwoFactor.sessionGate, SecondFactor, Roles.validatedCatalog, RolesAdmin builds"
      to: "the declarations"
      via: "Tenant.inForce"
      pattern: "inForce\\((TwoFactorConfigScoped|RolesConfigScoped|Roles\\.RolesConfigScoped)\\)"
---
Status: ready-for-agent
Blocked by: 04; precondition: someone else's uncommitted edits in `packages/two-factor` and `packages/roles` are committed (see Task 1)

<objective>
Declare `TwoFactorConfig` and `RolesConfig` per deployment (PLAN.md §2.3 rows for two-factor and roles) and route their six build reads through the accessor.
Purpose: G1 and G3 for two packages whose settings are not applied per tenant today.
Output: five edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3, §3.5, §8 last row)
@packages/two-factor/src/TwoFactorConfig.ts (lines 50-65)
@packages/two-factor/src/TwoFactor.ts (lines 183-192, 440-475)
@packages/two-factor/src/SecondFactor.ts (lines 190-202)
@packages/roles/src/Roles.ts (lines 110-145, 185-196, 283-295)
@packages/roles/src/RolesAdmin.ts (lines 85-100)
</context>

<tasks>
<task type="auto">
  <name>Task 1: precondition, then the declarations</name>
  <files>packages/two-factor/src/TwoFactorConfig.ts, packages/roles/src/Roles.ts</files>
  <read_first>`git status --porcelain packages/two-factor packages/roles`</read_first>
  <action>Run `git status --porcelain packages/two-factor packages/roles`. If it prints anything, stop: those are someone else's uncommitted edits (at `04fa3526`: `TwoFactor.ts`, `TwoFactorStore.ts`, `Roles.ts`, `RoleAssignments.ts`); set this ticket's Status to `ready-for-human`, name the files in Comments, and do nothing else. Otherwise re-locate every line number below with grep (they may have moved), then add `TwoFactorConfigScoped = Tenant.perDeployment(TwoFactorConfig)` next to the reference (`TwoFactorConfig.ts:57`) and make `config` (`:61`) return its `layer`. Add `RolesConfigScoped = Tenant.perDeployment(RolesConfig)` next to `Roles.ts:114`; make `config` (`:142`) return `RolesConfigScoped.layer({ catalog })` and remove its `Layer.Layer<never>` annotation (it would hide the marker; house rule).</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `git status --porcelain packages/two-factor packages/roles` printed nothing before the first edit (recorded in Comments)
    - `grep -c 'Tenant.perDeployment(TwoFactorConfig)' packages/two-factor/src/TwoFactorConfig.ts` prints 1 and `grep -c 'Tenant.perDeployment(RolesConfig)' packages/roles/src/Roles.ts` prints 1 (baselines 0)
    - `grep -c 'Layer.Layer<never>' packages/roles/src/Roles.ts` is one less than its value before the ticket (baseline at `04fa3526`: measure and record)
  </acceptance_criteria>
  <done>Two declarations on a clean tree.</done>
</task>

<task type="auto">
  <name>Task 2: reads and descriptors</name>
  <files>packages/two-factor/src/TwoFactor.ts, packages/two-factor/src/SecondFactor.ts, packages/roles/src/Roles.ts, packages/roles/src/RolesAdmin.ts</files>
  <read_first>the read sites: TwoFactor.ts:189, :471; SecondFactor.ts:199; Roles.ts:130, :193; RolesAdmin.ts:95; descriptors TwoFactor.ts:444, Roles.ts:287</read_first>
  <action>Every site is a build read: replace `yield* <Key>` with `yield* yield* Tenant.inForce(<Key>Scoped)` keeping the local names (`config`, `rolesConfig`); in `RolesAdmin.ts` use `Roles.RolesConfigScoped`. Make the two descriptors from the declarations with their options unchanged.</action>
  <verify><automated>npx vitest run packages/two-factor/test/TwoFactor.test.ts packages/two-factor/test/TwoFactor.types.test.ts packages/roles/test/Roles.test.ts packages/roles/test/RolesAdmin.test.ts packages/roles/test/AuthComposition.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *TwoFactorConfig\b' packages/two-factor/src | wc -l` prints 0 (baseline 3)
    - `grep -rnE 'yield\* *(Roles\.)?RolesConfig\b' packages/roles/src | wc -l` prints 0 (baseline 3)
    - `grep -rnE 'ConfigDescriptor\.make\((TwoFactorConfigScoped|RolesConfigScoped)' packages/two-factor/src packages/roles/src | wc -l` prints 2 (baseline 0)
  </acceptance_criteria>
  <done>Both packages read only through the accessor.</done>
</task>

<task type="auto">
  <name>Task 3: the passwordless and admin suites that compose them</name>
  <files>packages/two-factor/src/TwoFactor.ts</files>
  <read_first>`grep -rln "TwoFactor.config\|Roles.config" packages/*/test features/step-definitions | head`</read_first>
  <action>No code change is expected. Run the suites outside the two packages that pass `TwoFactor.config(...)` or `Roles.config(...)` through `TestAuth.layer({ services })` or `Layer.provide`: the marker adds an output to those layers, which every `Layer<never>` site accepts (PLAN.md §3.2). If one fails to compile, the site has an explicit `Layer.Layer<never>`-typed collection that is not the cause; report it in Comments instead of adding an assertion.</action>
  <verify><automated>pnpm build && npx tsc -p tsconfig.test.json && npx vitest run packages/magic-link/test/MagicLink.test.ts packages/admin/test/AdminGate.test.ts</automated></verify>
  <acceptance_criteria>
    - `npx tsc -p tsconfig.test.json` passes
  </acceptance_criteria>
  <done>The composing suites compile and pass.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → two-factor and role catalog settings | a tenant's stricter second-factor policy or role catalog placed in a lookup was never applied |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-02 | Elevation | an operator believes a tenant requires two-factor, or has a narrower role catalog, when the deployment's applies | high | mitigate | the marker makes such a lookup a type error (ticket 03's rule; ticket 16's real-plugin pin); the changeset's Migration line names two-factor and roles |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 6 → 0 across both packages; 2 declarations; no edit made while the precondition failed.
</success_criteria>

## Comments
