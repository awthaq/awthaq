---
plan: 36-config-scope
ticket: 03
title: "The scope declaration, the resolution rule, the accessor and the deployment marker"
type: tdd
wave: 1
depends_on: []
files_modified:
  - packages/ports/src/Tenant.ts
  - packages/core/src/Tenant.ts
  - packages/ports/test/TenantConfigScope.test.ts
  - packages/organization/test/TenantConfigScope.types.test.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573, REQ-EA-1574]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Tenant.perTenant(ref, { boot }) and Tenant.perDeployment(ref) exist and are re-exported by @awthaq/core's Tenant"
    - "Tenant.inForce(declared) yields, once at build, an Effect that resolves per operation by Tenant.resolveConfig"
    - "A deployment-scoped declaration's layer provides Tenant.DeploymentConfigApplied"
    - "A TenantConfig lookup merging a deployment-scoped layer does not type-check at TenantMiddleware.layerWithConfig"
    - "Tenant.configInForce still exists (removed in ticket 20)"
  artifacts:
    - path: "packages/ports/src/Tenant.ts"
      provides: "ConfigScope, PerTenant, PerDeployment, Declared, perTenant, perDeployment, resolveConfig, inForce, DeploymentConfigApplied"
      contains: "export const inForce"
    - path: "packages/ports/test/TenantConfigScope.test.ts"
      provides: "the rule, both scopes, boot fields, two fibers over one build"
    - path: "packages/organization/test/TenantConfigScope.types.test.ts"
      provides: "the compile-time refusal"
  key_links:
    - from: "Tenant.inForce"
      to: "Tenant.resolveConfig"
      via: "the accessor applies the same pure rule the views use"
      pattern: "resolveConfig\\("
    - from: "PerDeployment.layer"
      to: "TenantMiddleware.TenantConfigTag"
      via: "LayerMap's invariant output refuses the marker"
      pattern: "DeploymentConfigApplied"
---
Status: done (uncommitted)
Blocked by: Q1 (PLAN.md §10) must be answered "compile time" or left at its recommended default

<objective>
Build the seam of PLAN.md §3.2 in `@awthaq/ports` `Tenant`: the scope declaration, the one resolution rule, the accessor and the marker that makes a deployment-scoped `config(...)` unusable in a `TenantConfig` lookup.
Purpose: every later ticket declares keys and reads through this; the views (ticket 04) reuse the rule.
Output: new exports in `ports/src/Tenant.ts`, re-exports in `core/src/Tenant.ts`, one behaviour test and one type test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§3.1-3.3, §3.6)
@packages/ports/src/Tenant.ts (lines 58-85: TenantConfigApplied, configApplied, configInForce)
@packages/core/src/Tenant.ts
@packages/organization/src/TenantMiddleware.ts (lines 47-51, 148-170)
@packages/organization/test/TenantMiddleware.test.ts (lines 125-175: a LayerMap TenantConfig)
@packages/admin/test/AdminGate.types.test.ts (the repo's @ts-expect-error type-test shape)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: the rule and the accessor, test first</name>
  <files>packages/ports/test/TenantConfigScope.test.ts, packages/ports/src/Tenant.ts</files>
  <read_first>packages/ports/src/Tenant.ts; PLAN.md §3.2 and §3.6</read_first>
  <behavior>
    - A test `Context.Reference` `Knobs` with fields `limit: number`, `key: string`, and `perTenant(Knobs, { boot: ["key"] })`.
    - Built with `{ limit: 5, key: "built" }`; a calling fiber providing `{ limit: 9, key: "tenant" }` reads `{ limit: 9, key: "built" }`.
    - No calling value reads the built value.
    - `perDeployment(Knobs)`: a calling value is ignored; the built value is read.
    - One `inForce` yielded once at build, then run in two fibers with different calling values, returns each fiber's own value.
    - `resolveConfig(declared, built, calling)` equals what `inForce` yields in that fiber, for both scopes.
    - A `Context.Service` key (a test service with required fields) works with `perTenant` and `inForce`, and `inForce` requires it in R.
    - `perDeployment(Knobs).layer(v)` provides `Knobs = v` and `DeploymentConfigApplied` with `key` equal to `Knobs.key`; `perTenant(Knobs).layer(v)` provides only `Knobs`.
  </behavior>
  <action>Write the test file first (it fails to compile). Then add to `ports/src/Tenant.ts`, below `configApplied`: the `ConfigScope` type; the `DeploymentConfigApplied` service (key `awthaq/ports/DeploymentConfigApplied`, shape `{ readonly key: string }`); the `PerTenant` and `PerDeployment` interfaces and their union `Declared`, each with its own `layer` method so the return types differ without a conditional type or an assertion; `perTenant` (boot defaults to an empty list) and `perDeployment`; `resolveConfig`, which returns the build value for a deployment-scoped declaration, and for a tenant-scoped one returns the calling context's value (via `Context.getOrUndefined`, as the old helper does) with each boot field copied from the build value, else the build value; `inForce`, which reads the key once with `Effect.service` and returns `Effect.contextWith` over `resolveConfig`, wrapping the value in `Effect.succeed`. Copy boot fields with an object spread over the generic shape (no assertion; PLAN.md §3.6 probed this). Leave the old helper and its doc comment in place. Doc comments: one per export, citing ADR-EA-018 D8 and BEH-EA-362; the marker's comment says why it exists (a `LayerMap` output is invariant, so a tenant lookup carrying it does not type-check). No return-type annotations on the new consts.</action>
  <verify><automated>npx vitest run packages/ports/test/TenantConfigScope.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "export const inForce\|export const perTenant\|export const perDeployment\|export const resolveConfig\|export class DeploymentConfigApplied" packages/ports/src/Tenant.ts` prints 5 (baseline 0)
    - `grep -c " as " packages/ports/src/Tenant.ts` is unchanged from its baseline (run it before editing and record it)
    - All behaviour bullets pass
  </acceptance_criteria>
  <done>The rule and the accessor exist in ports with a passing test.</done>
</task>

<task type="tdd">
  <name>Task 2: the compile-time refusal (type test)</name>
  <files>packages/organization/test/TenantConfigScope.types.test.ts</files>
  <read_first>packages/organization/src/TenantMiddleware.ts lines 47-51 and 148-170; packages/admin/test/AdminGate.types.test.ts</read_first>
  <behavior>
    - A `LayerMap.Service` whose lookup merges `perTenant(Knobs).layer(...)` and `Tenant.configApplied(id)` is accepted by `TenantMiddleware.layerWithConfig`.
    - A `LayerMap.Service` whose lookup merges `perDeployment(Knobs).layer(...)` and `Tenant.configApplied(id)` is refused (`@ts-expect-error` on the `layerWithConfig` call).
    - `Tenant.perTenant(Knobs, { boot: ["notAField"] })` is refused (`@ts-expect-error`).
  </behavior>
  <action>Create the type test in the organization package (it owns `TenantMiddleware`). Follow AdminGate.types.test.ts: declarations and expressions inside a function that is never called, plus one trivial `it` so vitest collects the file. Define the test `Knobs` reference locally. Ticket 15 adds a case with a real plugin constructor once one is declared.</action>
  <verify><automated>pnpm build && npx tsc -p tsconfig.test.json && npx vitest run packages/organization/test/TenantConfigScope.types.test.ts</automated></verify>
  <acceptance_criteria>
    - `npx tsc -p tsconfig.test.json` passes (each `@ts-expect-error` is consumed)
    - Removing the `@ts-expect-error` above the deployment case makes `tsc` fail with TS2379 or TS2345 (prove once, record in Comments, revert)
  </acceptance_criteria>
  <done>The refusal is a checked type test.</done>
</task>

<task type="auto">
  <name>Task 3: core re-exports</name>
  <files>packages/core/src/Tenant.ts</files>
  <read_first>packages/core/src/Tenant.ts</read_first>
  <action>Re-export `perTenant`, `perDeployment`, `resolveConfig`, `inForce` and `DeploymentConfigApplied` the way the file re-exports the existing names (one `export const` per value). Types: re-export `ConfigScope`, `PerTenant`, `PerDeployment` and `Declared` as type exports so `@awthaq/core` users can name them. Keep the old helper's re-export until ticket 20.</action>
  <verify><automated>pnpm typecheck</automated></verify>
  <acceptance_criteria>
    - `grep -c "inForce\|perTenant\|perDeployment\|resolveConfig\|DeploymentConfigApplied" packages/core/src/Tenant.ts` is at least 5 (baseline 0)
  </acceptance_criteria>
  <done>`import { Tenant } from "@awthaq/core"` reaches the new names.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → a plugin's operations | an application-authored per-tenant configuration reaches the operations of one request |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-02 | Tampering / Elevation | a deployment-scoped security setting (a tenant's stricter `TwoFactor.config`) placed in a tenant lookup | medium | mitigate | the marker makes the lookup fail to type-check (Task 2); the residual raw `Layer.succeed` bypass is documented (PLAN.md R3) |
| T-36-05 | Denial of service | `resolveConfig` per operation | low | accept | one context lookup and at most one object spread per read, the cost of today's helper |
</threat_model>

<verification>
pnpm build
npx vitest run packages/ports/test/TenantConfigScope.test.ts packages/organization/test/TenantConfigScope.types.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Five new exports in ports with a behaviour test; the refusal proven by a type test that fails when its expect-error is removed; gate green.
</success_criteria>

## Comments
- Result: seam added; ports test 7 pass; type test proven to bite (TS2379 when the expect-error is removed).
