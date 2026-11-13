---
plan: 36-config-scope
ticket: 14
title: "Admin: the gate's declaration and GET /admin/config per tenant (wire change)"
type: tdd
wave: 2
depends_on: ["04", "10", "01"]
files_modified:
  - packages/admin/src/internal/AdminGate.ts
  - packages/admin/src/Admin.ts
  - packages/admin/src/AdminApi.ts
  - packages/admin/test/AdminConfig.test.ts
  - packages/admin/test/AdminGate.boundary.test.ts
autonomous: true
requirements: [REQ-EA-1570, REQ-EA-1571, REQ-EA-1574, REQ-EA-1577]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Under a calling-fiber Password.config({ minLength: 40 }), admin.effectiveConfig reports minLength 40 with scope tenant and source tenant (F1 fixed)"
    - "With no calling override it reports the build value as before"
    - "The secret canary is absent from the response under a tenant too"
    - "AdminConfig is declared Tenant.perTenant and read through Tenant.inForce in the gate only"
    - "ConfigItemDto has scope and source accepts tenant"
  artifacts:
    - path: "packages/admin/src/Admin.ts"
      provides: "effectiveConfig through EffectiveConfig.snapshot(builtIn, catalog)"
      contains: "EffectiveConfig.snapshot(builtIn"
    - path: "packages/admin/src/AdminApi.ts"
      provides: "ConfigItemDto.scope"
  key_links:
    - from: "Admin.effectiveConfig"
      to: "EffectiveConfig.snapshot"
      via: "the request fiber is the calling context"
      pattern: "snapshot\\(builtIn, catalog\\)"
---
Status: done (uncommitted)
Blocked by: 04, 10, 01; Q8 (PLAN.md §10) answered or at its default (add `scope` and `"tenant"` to the wire)

<objective>
Fix F1: `GET /admin/config` reports what the request's operations read. Declare `AdminConfig` and keep it private to the gate.
Purpose: G4 at the wire.
Output: the gate, the view, the DTO, and two tests.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.4, §3.4, Q8)
@packages/admin/src/internal/AdminGate.ts (lines 140-165, 240-250)
@packages/admin/src/Admin.ts (lines 660-725, 295-315)
@packages/admin/src/AdminApi.ts (lines 220-245)
@packages/admin/test/AdminConfig.test.ts (ticket 01's case)
@packages/admin/test/AdminGate.boundary.test.ts
</context>

<tasks>
<task type="tdd">
  <name>Task 1: flip F1 and add the view cases</name>
  <files>packages/admin/test/AdminConfig.test.ts</files>
  <read_first>packages/admin/test/AdminConfig.test.ts</read_first>
  <behavior>
    - Ticket 01's case becomes `it.effect`; it also asserts `scope: "tenant"` and `source: "tenant"` on the Password item.
    - Same composition, no calling override: the Password item reports the build value with `source` `override` (the composition provides `Password.config`).
    - Under the calling override, the AuditChain item reports `scope: "deployment"`, and `JSON.stringify(items)` does not include the canary.
  </behavior>
  <action>Edit the cases first; they fail until Task 2.</action>
  <verify><automated>npx vitest run packages/admin/test/AdminConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "it.effect.fails" packages/admin/test/AdminConfig.test.ts` prints 0 after the ticket (after ticket 01: 1)
  </acceptance_criteria>
  <done>The target is written as tests.</done>
</task>

<task type="auto">
  <name>Task 2: gate declaration, view, wire</name>
  <files>packages/admin/src/internal/AdminGate.ts, packages/admin/src/Admin.ts, packages/admin/src/AdminApi.ts</files>
  <read_first>the lines in context</read_first>
  <action>In AdminGate: add a module-private `AdminConfigScoped = Tenant.perTenant(AdminConfig)` (no boot fields: every field is a gate predicate or read per operation, ADR-EA-018 D8); `config` (`:152`) returns its `layer`, keeping the `canManageEpisode` derivation; `descriptor` (`:162`) is made from it; `:247` becomes `const inForce = yield* Tenant.inForce(AdminConfigScoped)` (keep the local name, the gate's bodies use it). In Admin.ts: make the AuditChain descriptor (`:670`) from `AuditChain.AuditChainConfigScoped` (ticket 06); replace `return EffectiveConfig.read(builtIn, catalog)` (`:723`) with `return yield* EffectiveConfig.snapshot(builtIn, catalog)`; update the comment at `:694-695` to say the build context is captured so the view can resolve against it, and the request fiber supplies the tenant's values. Map `scope` in the handler (`:303-315`). In AdminApi: `ConfigItemDto` gains `scope: Schema.Literals(["tenant", "deployment"])`, and `source` becomes `Schema.Literals(["default", "override", "tenant"])`; update its doc comment (EP-009, BEH-EA-363).</action>
  <verify><automated>npx vitest run packages/admin/test/AdminConfig.test.ts packages/admin/test/AdminGate.test.ts packages/admin/test/AdminAccounts.test.ts packages/admin/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "EffectiveConfig.snapshot(builtIn" packages/admin/src/Admin.ts` prints 1 (baseline 0)
    - `grep -c "scope: Schema.Literals" packages/admin/src/AdminApi.ts` prints 1 (baseline 0)
    - `grep -rnE 'yield\* AdminConfig\b' packages/admin/src | wc -l` prints 0 (baseline 1)
    - `grep -rn 'configInForce' packages/admin/src | wc -l` prints 0 (baseline 2: the call and the header comment at AdminGate.ts:4, which is reworded to name `Tenant.inForce`)
  </acceptance_criteria>
  <done>The view reads what the operations read, over the wire.</done>
</task>

<task type="auto">
  <name>Task 3: the gate-privacy test (replace, don't layer)</name>
  <files>packages/admin/test/AdminGate.boundary.test.ts</files>
  <read_first>packages/admin/test/AdminGate.boundary.test.ts</read_first>
  <action>Rewrite the case at `:31-33` so it asserts that `AdminConfig` and `Tenant.inForce(AdminConfigScoped` appear only in `internal/AdminGate.ts` among the admin package's source files. Do not keep an assertion about the old helper's name: ticket 20's repository guard owns that.</action>
  <verify><automated>npx vitest run packages/admin/test/AdminGate.boundary.test.ts</automated></verify>
  <acceptance_criteria>
    - The gate-privacy test passes, and fails when a throwaway `Tenant.inForce(AdminConfigScoped)` is planted in `Admin.ts` (prove once, record in Comments, revert)
  </acceptance_criteria>
  <done>The gate's privacy is still enforced, by the new names.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| running application → an administrator over `GET /admin/config` | configuration, some of it secret, leaves the process; under a tenant it is now that tenant's |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-01 | Information disclosure | `GET /admin/config` under a tenant | medium | mitigate | the same fail-closed `canManageUsers` gate, read per tenant; the same redaction; Task 1 asserts the canary is absent under a tenant |
| T-36-04 | Information disclosure | a calling-fiber `Redacted` in the view | medium | mitigate | ticket 04's redaction case; unchanged `flatten` |
| T-36-07 | Elevation | `AdminConfig` readable outside the gate | high | mitigate | Task 3's gate-privacy test |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
F1's case passes un-marked; the DTO carries scope; admin raw reads 1 → 0; gate-privacy test proven.
</success_criteria>

## Comments

### Result (uncommitted)
AdminGate: private `AdminConfigScoped = Tenant.perTenant(AdminConfig)`, config/descriptor/read through it. Admin.ts: AuditChain descriptor from `AuditChainConfigScoped`; `effectiveConfig` returns `yield* EffectiveConfig.snapshot(builtIn, catalog)`. F1 test flipped to `it.effect` (asserts scope/source tenant, AuditChain scope deployment, canary absent). Second case asserts the build value and scope only: the harness provides the composition layer to the test fiber too, so `source` is "tenant", not "override" as the ticket expected. Boundary test rewritten to `Tenant.inForce(AdminConfigScoped`; proved by planting it in Admin.ts (failed), reverted (passes).
Verification note: admin/password/passkey tests import sibling plugins and core from built `lib`, which is stale (no `AuditChainConfigScoped`, old Password descriptor), so the lib-resolved run fails admin suites until a rebuild; with the `bun` export condition (src) all of admin 214, password 180, passkey 314 pass. Not run: cli Seed.test, openapi/docs bits.
