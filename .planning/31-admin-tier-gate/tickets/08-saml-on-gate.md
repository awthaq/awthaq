---
plan: 31-admin-tier-gate
ticket: 08
title: "SAML declares its gate; canManageSaml and adminRate per tenant"
type: tdd
wave: 2
depends_on: [02, 06]
files_modified:
  - packages/saml/src/SamlAdmin.ts
  - packages/saml/src/Saml.ts
  - packages/saml/src/SamlConfig.ts
  - packages/saml/test/SamlAdmin.test.ts
  - .changeset/saml-admin-tier-gate.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1521, REQ-EA-1522]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Ticket 02's by-id matrix stays green with the logic moved into the core gate"
    - "A SamlConfig provided in the calling fiber (a tenant's) decides canManageSaml and adminRate for that request"
    - "canManageSaml receives tenantId"
    - "SamlAdmin.ts publishes no auth.admin.actionDenied and asks no predicate itself"
  artifacts:
    - path: "packages/saml/src/SamlAdmin.ts"
      provides: "the SAML declaration; by-id operations through gate.found"
  key_links:
    - from: "packages/saml/src/SamlAdmin.ts"
      to: "packages/core/src/AdminTierGate.ts"
      via: "gate.found(caller, action, lookup(connectionId), (record) => record.organizationId, notFound)"
      pattern: "gate\\.found\\("
    - from: "packages/saml/src/Saml.ts"
      to: "packages/ports/src/Tenant.ts"
      via: "budget tune: Effect.map(Tenant.configInForce(SamlConfig.SamlConfig, settings), …)"
      pattern: "configInForce\\(SamlConfig\\.SamlConfig"
---
Status: ready-for-agent (Q5 default: only canManageSaml and adminRate become per tenant)
Blocked by: 02, 06

<objective>
Replace ticket 02's local gate with a declaration over the core gate, and close plan 13 Q4 (SAML's admin gate per tenant).

Purpose: the uniform answer and the read-first ordering live in core; SAML only says how to read a connection and what its organization is.
Output: `SamlAdmin.ts` with no `authorize`/`authorizeFound`; `makeAdmin` builds the gate; `Saml.ts` tunes the `admin` rule per operation; `SamlConfig.ts` input with `tenantId`; tests.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.3, §3.4 SAML, §10 Q5)
@packages/core/src/AdminTierGate.ts (from ticket 06)
@packages/saml/src/SamlAdmin.ts (after ticket 02: allows/refuse/authorize/lookup/authorizeFound)
@packages/saml/src/Saml.ts (lines 680-711 the rule table; 810-835 the budget and makeAdmin)
@packages/saml/src/SamlConfig.ts (lines 61-72 canManageSaml and adminRate; 80-82 the Context.Service)
@packages/saml/test/SamlAdmin.test.ts (ticket 02's matrix; "past the gate each administrator is limited per window" :173-199)
@packages/admin/test/AdminGate.test.ts (tenant opens/tightens cases: how per-request configuration is provided with Effect.provide)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: Red — a tenant's SamlConfig governs the gate</name>
  <files>packages/saml/test/SamlAdmin.test.ts</files>
  <read_first>packages/saml/test/SamlAdmin.test.ts, packages/saml/src/SamlConfig.ts</read_first>
  <behavior>
    - Build allows every action; a request run with `Effect.provide(SamlConfig.config({ baseUrl, canManageSaml: deny }))` around one call is refused `SamlActionDenied` (tenant tightens).
    - Build denies; a request with a tenant SamlConfig allowing every action passes (tenant opens).
    - A tenant SamlConfig with `adminRate: { limit: 1, … }` and `MemoryLimiter`: the second call in that tenant is `RateLimited`.
    - The predicate sees `tenantId: Option.some("t1")` under `Tenant.withTenant("t1")` (the organization must be "t1"'s for listConnections to be in reach; use the org id as the tenant id).
  </behavior>
  <action>Add a describe block "the gate reads the configuration in force (ADR-EA-018 D8, BEH-EA-318)" with the four cases. Use the same `baseUrl` as `SamlLive`'s (read `support.ts`). Run: the first three are red at the start of this ticket (SAML reads its gate at build).</action>
  <verify><automated>npx vitest run packages/saml/test/SamlAdmin.test.ts 2>&1 | grep -E "Tests +[0-9]+ failed"</automated></verify>
  <acceptance_criteria>
    - The four new cases exist; at least the tighten, open and rate cases fail before Task 2.
  </acceptance_criteria>
  <done>Red tests for the per-tenant gate.</done>
</task>

<task type="tdd">
  <name>Task 2: The declaration</name>
  <files>packages/saml/src/SamlAdmin.ts, packages/saml/src/Saml.ts, packages/saml/src/SamlConfig.ts</files>
  <read_first>packages/core/src/AdminTierGate.ts, packages/saml/src/SamlAdmin.ts, packages/saml/src/Saml.ts</read_first>
  <action>In `SamlConfig.ts`, add `readonly tenantId: Option.Option<string>` to `canManageSaml`'s input with a one-line doc, and rewrite the doc of `canManageSaml` (lines 61-65): create/list pass the organization the request names, by-id operations the connection's (BEH-EA-348), absent means "the action in general"; the predicate and `adminRate` are read per operation, so a tenant's `config(...)` governs them; the other fields are read at build (boot-scoped). In `SamlAdmin.ts`, `makeAdmin` keeps its `throttle` parameter and its `settings` read (still used for `spEntityId`/`baseUrl` in `toDto`, boot-scoped). Build `const gate = yield* AdminTierGate.make({ config: SamlConfig.SamlConfig, built: settings, prefix: "saml.", predicate: (config, asked) => config.canManageSaml({ admin: makeSubject({ id: asked.adminUserId }), action: asked.action, organizationId: Option.getOrUndefined(asked.target), tenantId: asked.tenantId }), names: (_, organizationId) => ({ organizationId }), denied: () => new SamlApi.SamlActionDenied(), throttle: (adminUserId, action) => throttle(adminUserId, action) })` with a string-literal union of the eight operation names as the action type and `string` (organization id) as the target. `createConnection` and `listConnections` call `gate.named(caller, action, Option.some(organizationId))`; the six by-id operations call `gate.found(caller, action, lookup(connectionId), (record) => record.organizationId, () => new SamlApi.SamlConnectionNotFound())` and use `cleared.record`. Delete `allows`, `refuse`, `authorize`, `authorizeFound` and `adminId`; events read `cleared.adminUserId`. Update the header comment (lines 3-8): the gate is core's `AdminTierGate`. In `Saml.ts` (lines 823-833), tune the budget per operation: `tune: Effect.map(Tenant.configInForce(SamlConfig.SamlConfig, settings), (current) => ({ login: settings.rateLimits.login, acs: settings.rateLimits.acs, slo: settings.rateLimits.slo, admin: current.adminRate }))` (the unauthenticated rules stay build-time per Q5). If TS2883 appears, follow plan 13's alias fix.</action>
  <verify><automated>npx vitest run packages/saml</automated></verify>
  <acceptance_criteria>
    - `grep -c '_tag: "auth.admin.actionDenied"' packages/saml/src/SamlAdmin.ts` → 0 (baseline at HEAD 1).
    - `grep -v '^\s*//' packages/saml/src/SamlAdmin.ts | grep -c 'settings.canManageSaml'` → 0 (baseline 1).
    - `grep -c 'gate.found(' packages/saml/src/SamlAdmin.ts` → 6 and `grep -c 'gate.named(' packages/saml/src/SamlAdmin.ts` → 2 (baselines 0).
    - `grep -c 'caller\.ref\.id' packages/saml/src/SamlAdmin.ts` → 0 (baseline 4).
    - `grep -c 'tenantId' packages/saml/src/SamlConfig.ts` ≥ 1 (baseline 0).
    - Ticket 02's matrix and Task 1's cases are green.
  </acceptance_criteria>
  <done>SAML's admin group is a declaration over the core gate; per-tenant gate fields work.</done>
</task>

<task type="auto">
  <name>Task 3: Replace the throttle test; changeset; gate</name>
  <files>packages/saml/test/SamlAdmin.test.ts, .changeset/saml-admin-tier-gate.md</files>
  <read_first>packages/saml/test/SamlAdmin.test.ts</read_first>
  <action>Delete "past the gate each administrator is limited per window" (lines 173-199 at HEAD); core's suite covers per-administrator buckets. Keep ticket 02's delegated throttle case (it is the SAML wiring case). Create `.changeset/saml-admin-tier-gate.md`: `"@awthaq/saml": minor`, text and `Migration:` line of PLAN §6.6 row 4, plus "`canManageSaml` also receives `tenantId`". Run the gate.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/saml && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c "past the gate each administrator is limited per window" packages/saml/test/SamlAdmin.test.ts` → 0 (baseline 1).
  </acceptance_criteria>
  <done>Green; changeset present.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → `saml.admin` | connection trust anchors (certificates, entity id) are written here |
| tenant configuration → gate | a tenant's `SamlConfig` now decides its own admin gate |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-01 | Elevation of privilege | by-id operations after the move | critical | mitigate | Ticket 02's matrix must stay green unchanged |
| T-31-09 | Elevation of privilege | build-time gate ignoring a tightening tenant | medium | mitigate | `configInForce` in the core gate; Task 1 tighten case |
| T-31-13 | Denial of service | per-tenant `adminRate` | low | mitigate | Budget `tune` reads the configuration in force (Task 1 rate case) |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 0 hand-written gates in `SamlAdmin.ts`; matrix and per-tenant cases green.
</success_criteria>

## Comments
