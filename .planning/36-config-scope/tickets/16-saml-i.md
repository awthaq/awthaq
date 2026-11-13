---
plan: 36-config-scope
ticket: 16
title: "SAML I: SamlConfig and SsoConfig declarations, SSO reads, the admin gate read"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/saml/src/SamlConfig.ts
  - packages/saml/src/Sso.ts
  - packages/saml/src/SamlAdmin.ts
  - packages/saml/test/SamlTenantScope.types.test.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573, REQ-EA-1576]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "SamlConfig is declared per deployment, or per tenant with boot = every field except the gate's when plan 31 has made the gate read per operation (Q9, PLAN.md §8)"
    - "SsoConfig is declared Tenant.perDeployment and has a descriptor"
    - "Sso.ts and SamlAdmin.ts read both keys only through Tenant.inForce"
    - "A TenantConfig lookup that merges Sso.config(...) does not type-check (when SsoConfig is per deployment)"
  artifacts:
    - path: "packages/saml/src/SamlConfig.ts"
      provides: "SamlConfigScoped"
    - path: "packages/saml/src/Sso.ts"
      provides: "SsoConfigScoped and its descriptor"
      contains: "Tenant.perDeployment(SsoConfig)"
    - path: "packages/saml/test/SamlTenantScope.types.test.ts"
      provides: "the refusal on a real plugin constructor"
  key_links:
    - from: "SamlAdmin authorize"
      to: "Tenant.inForce(SamlConfigScoped)"
      via: "the gate's config read (plan 31 owns its semantics)"
      pattern: "inForce\\(SamlConfig\\.SamlConfigScoped\\)|inForce\\(SamlConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 04; Q9 (PLAN.md §10) answered or at its default (declare per deployment when plan 31 has not landed)

<!-- planner-discipline-allow: configInForce -->

<objective>
Declare `SamlConfig` and `SsoConfig` (PLAN.md §2.3 rows 16-17), route the SSO and SAML-admin reads through the accessor, give SSO a descriptor, and pin the refusal on a real plugin.
Purpose: G1 and G3 for the SAML package, without blocking or racing plan 31.
Output: three edited modules and one type test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 16-17, §8 row 31, Q9)
@.planning/31-admin-tier-gate/PLAN.md (its SAML gate ticket, to know which fields it makes per operation)
@packages/saml/src/SamlConfig.ts (lines 30-160)
@packages/saml/src/Sso.ts (lines 95-106, 170-185, the plugin class)
@packages/saml/src/SamlAdmin.ts (lines 120-160)
@packages/organization/src/TenantMiddleware.ts (lines 40-60, 149-175)
@packages/organization/test/TenantConfigScope.types.test.ts (ticket 03's shape)
</context>

<tasks>
<task type="auto">
  <name>Task 1: read the tree, then declare</name>
  <files>packages/saml/src/SamlConfig.ts, packages/saml/src/Sso.ts</files>
  <read_first>packages/saml/src/SamlAdmin.ts lines 120-160</read_first>
  <action>First decide SamlConfig's scope from the tree and record the outcome in Comments. Run `grep -n "configInForce\|Tenant.inForce" packages/saml/src/SamlAdmin.ts`. If it prints nothing (plan 31 not landed; HEAD state), declare `SamlConfigScoped = Tenant.perDeployment(SamlConfig)`. If it prints a hit (plan 31 landed), declare `SamlConfigScoped = Tenant.perTenant(SamlConfig, { boot })` with `boot` = every field of `SamlConfigShape` except `canManageSaml` and any other field plan 31's ticket names as read per operation; never put a `can*` predicate in `boot`. `SamlConfig.config` (`:103`) is a `Layer.effect` that validates `baseUrl` and `clockSkew`: turn it into `Layer.unwrap(Effect.gen(...))` whose body keeps the validation and the value construction unchanged and returns `SamlConfigScoped.layer(value)`. In `Sso.ts` add `SsoConfigScoped = Tenant.perDeployment(SsoConfig)` and make `config` (`:104`) return its `layer`. Drop the `Context.Reference<SsoConfigShape>` annotation only if the declaration's type inference needs it (it should not).</action>
  <verify><automated>pnpm build</automated></verify>
  <acceptance_criteria>
    - `grep -cE 'Tenant\.(perDeployment|perTenant)\(SamlConfig' packages/saml/src/SamlConfig.ts` prints 1 (baseline 0)
    - `grep -c 'Tenant.perDeployment(SsoConfig)' packages/saml/src/Sso.ts` prints 1 (baseline 0)
    - `grep -c 'Layer.succeed(SsoConfig' packages/saml/src/Sso.ts` prints 0 (baseline 1)
    - Comments record which branch was taken and the `grep` output that decided it
  </acceptance_criteria>
  <done>Both keys declared; SamlConfig's scope follows plan 31's state.</done>
</task>

<task type="auto">
  <name>Task 2: SSO and SAML-admin reads, SSO descriptor</name>
  <files>packages/saml/src/Sso.ts, packages/saml/src/SamlAdmin.ts</files>
  <read_first>Sso.ts:170-185; SamlAdmin.ts:125-160</read_first>
  <action>In `Sso.ts`'s build (`:177-178`) read both keys with `yield* yield* Tenant.inForce(<Key>Scoped)`, keeping the names `settings` and `preference`. In `SamlAdmin.ts`: if Task 1 took the per-deployment branch, replace `:132` the same way; if it took the per-tenant branch, plan 31's per-operation read is already there, so replace only the old helper call with `Tenant.inForce(SamlConfig.SamlConfigScoped)` bound to plan 31's names and leave its semantics alone. Add a `config:` list to the SSO plugin class with `ConfigDescriptor.make(SsoConfigScoped)` (one field, `preferred`, not sensitive). Do not add a SamlConfig descriptor (a `Context.Service` key, PLAN.md Q5).</action>
  <verify><automated>npx vitest run packages/saml/test/Sso.test.ts packages/saml/test/SamlAdmin.test.ts packages/saml/test/AuthComposition.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -cE 'yield\* *(SamlConfig\.SamlConfig|SsoConfig)\b' packages/saml/src/Sso.ts packages/saml/src/SamlAdmin.ts` prints 0 for each file (baselines 2 and 1)
    - `grep -c 'ConfigDescriptor.make(SsoConfigScoped' packages/saml/src/Sso.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>The two SAML modules read through the accessor; SSO is visible in the views.</done>
</task>

<task type="tdd">
  <name>Task 3: a real deployment constructor in a tenant lookup is refused</name>
  <files>packages/saml/test/SamlTenantScope.types.test.ts</files>
  <read_first>packages/organization/test/TenantConfigScope.types.test.ts (ticket 03)</read_first>
  <behavior>
    - A `LayerMap.Service` whose lookup merges `Sso.config({ preferred: "oidc" })` with `Tenant.configApplied(id)` is refused by `TenantMiddleware.layerWithConfig` (`@ts-expect-error` on the call).
    - The same lookup without the SSO layer is accepted.
  </behavior>
  <action>Copy ticket 03's case shape and swap the synthetic deployment key for `Sso.config`. Include one runtime `it` so vitest collects the file. If Task 1 declared SamlConfig per deployment, add the same refused case for `SamlConfig.config(...)` (with a valid `baseUrl`).</action>
  <verify><automated>npx vitest run packages/saml/test/SamlTenantScope.types.test.ts && npx tsc -p tsconfig.test.json</automated></verify>
  <acceptance_criteria>
    - The file compiles (each `@ts-expect-error` is used) and its runtime case passes
    - Removing the SSO layer from the refused lookup makes `npx tsc -p tsconfig.test.json` report an unused `@ts-expect-error` (prove once, record in Comments, revert)
  </acceptance_criteria>
  <done>The refusal is pinned on a shipped plugin, not only on a synthetic key.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| an administrator → SAML connection management (`SamlAdmin`) | the `canManageSaml` gate decides who may change an organization's identity provider |
| application `TenantConfig` lookup → SAML and SSO settings | a tenant lookup could carry settings that are not applied per tenant |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-03 | Elevation | `canManageSaml` declared boot in the per-tenant branch (a tenant's stricter gate ignored) | high | mitigate | Task 1 forbids predicates in `boot`; `SamlAdmin.test.ts` runs unchanged; plan 31 owns the gate's semantics |
| T-36-02 | Tampering | an SSO or SAML setting placed in a tenant lookup and silently unused | medium | mitigate | the marker; Task 3's type test |
| T-36-08 | Denial of service | `SamlConfig.config` validation lost in the `Layer.unwrap` rewrite (a malformed `baseUrl` accepted) | medium | mitigate | the body is moved unchanged; `Saml.test.ts`'s configuration-defect cases run in ticket 17's verify and in this ticket's gate |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
SAML raw reads 10 → 7 (Sso 2, SamlAdmin 1 removed); SSO descriptor added; the refusal pinned on `Sso.config`.
</success_criteria>

## Comments

Result: grep found no configInForce/inForce in SamlAdmin.ts (the gate read raw SamlConfig at build), so SamlConfig is declared Tenant.perDeployment (Q9 default); Layer.effect became Layer.unwrap with validation unchanged. SsoConfigScoped added with a descriptor. SamlAdmin, Sso read via Tenant.inForce. Type test: Sso and SamlConfig lookups refused; removing the Sso layer produced the unused @ts-expect-error (proved, reverted).
