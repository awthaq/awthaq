---
plan: 36-config-scope
ticket: 06
title: "Core's host-level keys I: SessionCookie, MailDispatch, AuditChain, Erasure, Retention"
type: execute
wave: 2
depends_on: ["05"]
files_modified:
  - packages/core/src/SessionCookie.ts
  - packages/core/src/MailDispatch.ts
  - packages/core/src/AuditChain.ts
  - packages/core/src/Erasure.ts
  - packages/core/src/Retention.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1573]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Each of the five keys is declared Tenant.perDeployment and its config(...) returns the declaration's layer"
    - "Build reads go through Tenant.inForce; the ambient reads of SessionCookieConfig and Retention.sweep are unchanged"
    - "EffectiveConfig.core makes the SessionCookie and MailDispatch descriptors from the declarations"
  artifacts:
    - path: "packages/core/src/SessionCookie.ts"
      provides: "SessionCookieConfigScoped"
  key_links:
    - from: "SessionCookie.config"
      to: "Tenant.DeploymentConfigApplied"
      via: "the declaration's layer provides the marker"
      pattern: "SessionCookieConfigScoped\\.layer\\("
---
Status: done (uncommitted)
Blocked by: 05; Q2 (PLAN.md §10) answered "per deployment" or left at its default

<objective>
Declare five core host-level keys (PLAN.md §2.3 rows 20–24) per deployment, so their `config(...)` cannot go in a `TenantConfig` lookup.
Purpose: closes F4 and F5 for core; per Q2, a per-tenant `SessionCookie.config` (accidentally effective today) becomes a type error.
Output: five edited modules and the two descriptor entries in `EffectiveConfig.core`.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 20-24, §1.4 on ambient reads, Q2)
@packages/core/src/SessionCookie.ts (lines 70-90, 165-175)
@packages/core/src/MailDispatch.ts (lines 45-60, 85-95)
@packages/core/src/AuditChain.ts (lines 38-50, 84-90)
@packages/core/src/Erasure.ts (lines 80-90, 140-150)
@packages/core/src/Retention.ts (lines 70-95, 130-140, 195-205)
@packages/core/src/EffectiveConfig.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1: declare, mark the constructors, route build reads</name>
  <files>packages/core/src/SessionCookie.ts, packages/core/src/MailDispatch.ts, packages/core/src/AuditChain.ts, packages/core/src/Erasure.ts, packages/core/src/Retention.ts</files>
  <read_first>each file at the lines in context</read_first>
  <action>For each key add an exported `<Key>Scoped = Tenant.perDeployment(<Key>)` next to the reference. Make each `config(...)` return `<Key>Scoped.layer(value)`, keeping its merge logic. `SessionCookie.config` and `MailDispatch.config` are annotated `Layer.Layer<never>` today: remove the annotation (house rule, and the annotation would hide the marker). Route the build reads through the accessor: `MailDispatch.ts:90`, `AuditChain.ts:88`, `Erasure.ts:148`, `Retention.ts:201` become `yield* yield* Tenant.inForce(<Key>Scoped)` (or bind the inner effect to a name and yield it once). Leave the ambient reads unchanged (`SessionCookie.ts:171`, `Retention.ts:135`) and add a one-line comment at each saying it reads the host's value from the ambient fiber (PLAN.md §1.4). Do not touch the server, oauth or migrate-better-auth readers of `SessionCookieConfig`.</action>
  <verify><automated>pnpm build && npx tsc -p tsconfig.test.json && npx vitest run packages/core/test/SessionCookie.test.ts packages/core/test/MailDispatch.test.ts packages/core/test/Retention.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "Tenant.perDeployment(" packages/core/src/SessionCookie.ts packages/core/src/MailDispatch.ts packages/core/src/AuditChain.ts packages/core/src/Erasure.ts packages/core/src/Retention.ts` totals 5 (baseline 0)
    - `grep -n "config = .*: Layer.Layer<never>" packages/core/src/SessionCookie.ts packages/core/src/MailDispatch.ts | wc -l` prints 0 (baseline 2)
    - Every test file that provides `SessionCookie.config(...)` through `TestAuth.layer({ services })` still compiles (`npx tsc -p tsconfig.test.json`)
  </acceptance_criteria>
  <done>Five host-level keys declared per deployment with marked constructors.</done>
</task>

<task type="auto">
  <name>Task 2: descriptors from the declarations</name>
  <files>packages/core/src/EffectiveConfig.ts</files>
  <read_first>packages/core/src/EffectiveConfig.ts lines 81-110</read_first>
  <action>Make the `SessionCookie` and `MailDispatch` descriptors in `core` from `SessionCookie.SessionCookieConfigScoped` and `MailDispatch.MailDispatchConfigScoped`. `AuditChainConfig`'s descriptor lives in `@awthaq/admin` (`Admin.ts:670`) and moves to the declaration in ticket 14. No new descriptors for `Erasure` or `Retention` (PLAN.md Q10).</action>
  <verify><automated>npx vitest run packages/core/test/EffectiveConfig.test.ts packages/cli/test/Doctor.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "Scoped" packages/core/src/EffectiveConfig.ts` is at least 5 (after ticket 05: 3)
    - `doctor`'s cookie findings are unchanged (Doctor.test.ts passes)
  </acceptance_criteria>
  <done>Core's descriptor list is fully declaration-based.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| application `TenantConfig` lookup → cookie attributes of a response | a per-tenant cookie configuration would change how credentials are written and read |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-02 | Tampering | `SessionCookie.config` in a tenant lookup changing cookie name or `SameSite` per tenant while the credential reader runs with another | medium | mitigate | declared per deployment; the lookup no longer type-checks (Q2) |
</threat_model>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Five declarations; two constructors un-annotated and marked; ambient reads documented and unchanged; gate green.
</success_criteria>

## Comments

Result: five keys declared perDeployment; configs return `.layer` (SessionCookie/MailDispatch un-annotated; Retention.config uses Layer.unwrap to keep its merge with defaults); build reads via `yield* yield* Tenant.inForce`; ambient reads commented. Core descriptors from declarations. Tests green.
