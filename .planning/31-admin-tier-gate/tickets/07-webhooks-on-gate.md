---
plan: 31-admin-tier-gate
ticket: 07
title: "Webhooks declares its gate"
type: execute
wave: 1
depends_on: [06]
files_modified:
  - packages/webhooks/src/Webhooks.ts
  - packages/webhooks/src/WebhooksConfig.ts
  - packages/webhooks/test/WebhooksAdmin.test.ts
  - .changeset/webhooks-admin-tier-gate.md
autonomous: true
requirements: [REQ-EA-1522]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Webhooks' nine admin operations behave exactly as before (fail-closed, 403 WebhooksActionDenied, actionDenied 'webhooks.<action>', 429 past adminRate, per-tenant configuration)"
    - "canManageWebhooks receives the ambient tenantId"
    - "Webhooks.ts publishes no auth.admin.actionDenied itself"
  artifacts:
    - path: "packages/webhooks/src/Webhooks.ts"
      provides: "the webhooks declaration passed to AdminTierGate.make"
  key_links:
    - from: "packages/webhooks/src/Webhooks.ts"
      to: "packages/core/src/AdminTierGate.ts"
      via: "AdminTierGate.make({ config: WebhooksConfig.WebhooksConfig, built: builtSettings, prefix: \"webhooks.\", … })"
      pattern: "AdminTierGate\\.make\\("
---
Status: ready-for-agent
Blocked by: 06

<objective>
Move webhooks onto the core gate with no behaviour change apart from `tenantId` in the predicate input.

Purpose: the simplest declaration first (no target), so the gate's interface is proven on a plugin before SAML and admin.
Output: `Webhooks.ts` without its `authorize`; `WebhooksConfig.ts` input type with `tenantId`; the throttle test replaced by a wiring case; a changeset.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.4 Webhooks, §5.3)
@packages/core/src/AdminTierGate.ts (from ticket 06)
@packages/webhooks/src/Webhooks.ts (lines 505-560 make, budget, authorize, existing, adminId; 608-830 the nine operations)
@packages/webhooks/src/WebhooksConfig.ts (lines 20-30 canManageWebhooks)
@packages/webhooks/test/WebhooksAdmin.test.ts (lines 63-133 fail-closed; 378-404 the throttle test; 406-… declared and registered)
</context>

<tasks>
<task type="auto">
  <name>Task 1: The declaration</name>
  <files>packages/webhooks/src/Webhooks.ts, packages/webhooks/src/WebhooksConfig.ts</files>
  <read_first>packages/webhooks/src/Webhooks.ts, packages/core/src/AdminTierGate.ts</read_first>
  <action>In `WebhooksConfig.ts`, add `readonly tenantId: Option.Option<string>` to `canManageWebhooks`'s input type with a one-line doc ("the ambient tenant of the request (ADR-EA-050)"); the default predicate is unchanged. In `Webhooks.ts` `make`, keep `builtSettings`, `configNow` and the budget (its `tune` still reads `configNow`). Replace `authorize` (lines 522-542) with `const gate = yield* AdminTierGate.make({ config: WebhooksConfig.WebhooksConfig, built: builtSettings, prefix: "webhooks.", predicate: (settings, asked) => settings.canManageWebhooks({ admin: makeSubject({ id: asked.adminUserId }), action: asked.action, tenantId: asked.tenantId }), names: () => ({}), denied: () => new WebhooksApi.WebhooksActionDenied(), throttle: (adminUserId, action) => limits.spend("admin", { userId: adminUserId }, { endpoint: action }) })`. Type the action parameter with a string-literal union of the nine operation names (declare it once, e.g. `type AdminAction = "createEndpoint" | …`) so a typo does not compile; the target type is `never`. Each operation calls `gate.named(caller, "<action>", Option.none())`; where it used `settings` it reads `cleared.config`; where it used `adminId(caller)` or `caller.ref.id` after the gate (events, `createdBy` at :633) it reads `cleared.adminUserId`. Delete the `adminId` helper. Keep `existing` and every store-scoping comment. Update the header comment line 22 to say the gate is core's `AdminTierGate`. If declaration emit fails with TS2883, follow plan 13's fix (an exported type alias naming the inferred type), never an annotation.</action>
  <verify><automated>npx vitest run packages/webhooks</automated></verify>
  <acceptance_criteria>
    - `grep -c '_tag: "auth.admin.actionDenied"' packages/webhooks/src/Webhooks.ts` → 0 (baseline 1).
    - `grep -c 'caller\.ref\.id' packages/webhooks/src/Webhooks.ts` → 0 (baseline 5).
    - `grep -c 'tenantId' packages/webhooks/src/WebhooksConfig.ts` ≥ 1 (baseline 0).
    - `grep -c 'gate.named(caller' packages/webhooks/src/Webhooks.ts` → 9 (baseline 0).
  </acceptance_criteria>
  <done>Every webhooks admin operation goes through the core gate; the package suite is green.</done>
</task>

<task type="auto">
  <name>Task 2: Replace the throttle test; changeset; gate</name>
  <files>packages/webhooks/test/WebhooksAdmin.test.ts, .changeset/webhooks-admin-tier-gate.md</files>
  <read_first>packages/webhooks/test/WebhooksAdmin.test.ts</read_first>
  <action>Delete "an administrator is limited per window once past the gate" (lines 379-404); core's suite covers per-administrator buckets and the window. Add in the "declared and registered (plan 06)" block one wiring case "the webhooks.admin rule is spent through the gate": allow-all, `adminRate: { limit: 1, window: Duration.minutes(1) }`, `RateLimiter.layerMemory`; one `listEndpoints` passes, the second is `RateLimited`. Add one case to the fail-closed block: under `Tenant.withTenant("t1")` the predicate is called with `tenantId: Option.some("t1")` (record it in a closure). Create `.changeset/webhooks-admin-tier-gate.md`: `"@awthaq/webhooks": minor`; "The admin group's gate is `@awthaq/core`'s `AdminTierGate`; `canManageWebhooks` also receives `tenantId`." `Migration: none (additive input field; behaviour unchanged).`</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/webhooks && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c "an administrator is limited per window once past the gate" packages/webhooks/test/WebhooksAdmin.test.ts` → 0 (baseline 1).
    - `grep -c "spent through the gate" packages/webhooks/test/WebhooksAdmin.test.ts` → 1 (baseline 0).
  </acceptance_criteria>
  <done>Green; one wiring case instead of a re-test of the mechanism.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → `webhooks.admin` | endpoint registration decides where event payloads are sent |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-11 | Elevation of privilege | webhooks admin operations after migration | high | mitigate | The fail-closed block (every operation denied by default) stays and must pass unchanged |
| T-31-12 | Information disclosure | `tenantId` in the predicate input | low | accept | The host already knows the tenant it serves; no new data leaves the process |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Webhooks' existing gate tests pass unchanged except the replaced throttle test; 0 hand-written denials in `Webhooks.ts`.
</success_criteria>

## Comments
