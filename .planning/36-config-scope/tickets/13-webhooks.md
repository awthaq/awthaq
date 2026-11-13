---
plan: 36-config-scope
ticket: 13
title: "Webhooks: tenant-scoped administration, boot-scoped delivery worker"
type: execute
wave: 2
depends_on: ["04", "02"]
files_modified:
  - packages/webhooks/src/WebhooksConfig.ts
  - packages/webhooks/src/Webhooks.ts
  - packages/webhooks/src/WebhookDelivery.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574, REQ-EA-1576]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "WebhooksConfig is declared Tenant.perTenant with the worker's fields as boot and allowPrivateTargets not boot"
    - "The plugin, the retention contribution, the relay transport and the worker read the key through Tenant.inForce at build"
    - "The four function bodies fed by re-provision keep reading from their context"
    - "Ticket 02's webhooks pin passes unchanged"
  artifacts:
    - path: "packages/webhooks/src/WebhooksConfig.ts"
      provides: "WebhooksConfigScoped"
  key_links:
    - from: "Webhooks.ts:516-517"
      to: "Tenant.inForce(WebhooksConfigScoped)"
      via: "maxEndpoints, canManageWebhooks, adminRate per tenant"
      pattern: "inForce\\(WebhooksConfig(\\.WebhooksConfig)?Scoped\\)"
---
Status: done (uncommitted)
Blocked by: 04, 02

<objective>
Declare `WebhooksConfig` (PLAN.md §2.3 row 10) and route its build reads through the accessor, keeping the background pattern (build value re-provided to the relay and worker fibers).
Purpose: G1 and G3 for webhooks; the boot list makes the view truthful for the worker's settings (F8).
Output: three edited modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 row 10, §3.5 rule 2 exception, Q6)
@packages/webhooks/src/WebhooksConfig.ts (lines 20-100)
@packages/webhooks/src/Webhooks.ts (lines 326-342, 400-410, 505-530, 560-580, 605-640, 745-755)
@packages/webhooks/src/WebhookDelivery.ts (lines 70-150, 184-260, 326-395)
@packages/webhooks/test/WebhooksTenant.test.ts (ticket 02's pin)
</context>

<tasks>
<task type="auto">
  <name>Task 1: declaration, constructor, descriptor</name>
  <files>packages/webhooks/src/WebhooksConfig.ts, packages/webhooks/src/Webhooks.ts</files>
  <read_first>WebhooksConfig.ts lines 20-100; Webhooks.ts line 406; PLAN.md §3.5 rule 3 and Q6</read_first>
  <action>Add `WebhooksConfigScoped = Tenant.perTenant(WebhooksConfig, { boot: [...] })` with the worker's fields: `maxAttempts`, `retryBase`, `retryFactor`, `retryMax`, `requestTimeout`, `batchSize`, `concurrency`, `pollInterval`, `lease`, `disableAfterConsecutiveDead`, `deliveryRetention`, `includeClientContext`, `platformEndpointsHearAllTenants`, `deliveryRate`, `userAgent`. Verify each with rule 3: none may be read from `configNow`'s value in `Webhooks.ts` (the per-operation reads at HEAD are `canManageWebhooks`, `adminRate`, `allowPrivateTargets`, `maxEndpoints`, `secretGrace`). `allowPrivateTargets` is NOT boot (Q6). Make `config` (`WebhooksConfig.ts:97`) return the declaration's `layer`, and the descriptor (`Webhooks.ts:406`) from the declaration.</action>
  <verify><automated>pnpm build && npx vitest run packages/webhooks/test/WebhooksTenant.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "perTenant(WebhooksConfig" packages/webhooks/src/WebhooksConfig.ts` prints 1 (baseline 0)
  </acceptance_criteria>
  <done>Declared with the worker's fields as boot.</done>
</task>

<task type="auto">
  <name>Task 2: build reads through the accessor</name>
  <files>packages/webhooks/src/Webhooks.ts, packages/webhooks/src/WebhookDelivery.ts</files>
  <read_first>Webhooks.ts:330-340 and :513-520; WebhookDelivery.ts:132-150 and :366-370</read_first>
  <action>Replace `Webhooks.ts:516-517` with `const configNow = yield* Tenant.inForce(WebhooksConfigScoped)`. In the three background owners (`Webhooks.ts:334`, the retention contribution; `WebhookDelivery.ts:137`, the relay transport; `WebhookDelivery.ts:368`, the worker) read the build value through the accessor in the build (`const settings = yield* yield* Tenant.inForce(WebhooksConfigScoped)`) and keep re-providing it exactly as today. Leave the four function bodies (`WebhookDelivery.ts:83` `enqueue`, `:190` `attempt`, `:334` `drainDue`, `:352` `pruneAt`) reading from their context, and add a one-line comment at each: "runs in a background fiber; reads the build value its owner re-provides (PLAN 36 §3.5 rule 2)".</action>
  <verify><automated>npx vitest run packages/webhooks/test/WebhooksTenant.test.ts packages/webhooks/test/WebhooksAdmin.test.ts packages/webhooks/test/WebhookDelivery.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *WebhooksConfig\.WebhooksConfig\b' packages/webhooks/src | wc -l` prints 4 (baseline 8)
    - `grep -rn 'configInForce' packages/webhooks/src | wc -l` prints 0 (baseline 1)
  </acceptance_criteria>
  <done>Webhooks reads through the accessor at every build; background bodies documented.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → webhook administration and delivery | a tenant's configuration governs who may manage endpoints and where deliveries may go |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-03 | Elevation | `canManageWebhooks` or `maxEndpoints` declared boot by mistake | medium | mitigate | rule 3 verdicts; ticket 02's pin and `WebhooksAdmin.test.ts` keep running |
| T-36-06 | Server-side request forgery | `allowPrivateTargets` per tenant at creation | low | accept | the worker checks the deployment's value at delivery (`WebhookDelivery.ts:255`, `:286`), so a tenant cannot reach a private target the deployment forbids (Q6) |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 8 → 4; webhooks pin green; boot list verified.
</success_criteria>

## Comments

Result: WebhooksConfigScoped (15 boot fields; allowPrivateTargets not boot) declared; config() via .layer; descriptor, retention, relay transport, worker and Webhooks.ts configNow read via Tenant.inForce. Four background bodies commented. Raw reads 8 -> 4, configInForce 0. Webhooks/magic-link/api-key/device-auth tests green (757), tsc clean for these packages.
