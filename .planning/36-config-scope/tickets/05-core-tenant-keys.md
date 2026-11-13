---
plan: 36-config-scope
ticket: 05
title: "Core's tenant-scoped keys: SessionConfig, AccountsPolicy, RateLimitOverrides"
type: execute
wave: 2
depends_on: ["04"]
files_modified:
  - packages/core/src/Sessions.ts
  - packages/core/src/Accounts.ts
  - packages/core/src/RateLimits.ts
  - packages/core/src/EffectiveConfig.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1574]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "SessionConfig, AccountsPolicy and RateLimitOverrides are each declared Tenant.perTenant next to their reference"
    - "Sessions, Accounts and RateLimits read them through Tenant.inForce"
    - "Accounts.config and RateLimits.overrides return the declaration's layer"
    - "EffectiveConfig.core lists descriptors for all three"
  artifacts:
    - path: "packages/core/src/EffectiveConfig.ts"
      provides: "core descriptors made from declarations"
  key_links:
    - from: "Sessions.ts:675-676"
      to: "Tenant.inForce(SessionConfigScoped)"
      via: "replaces the build read + old helper pair"
      pattern: "inForce\\(SessionConfigScoped\\)"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Declare core's three tenant-scoped keys (PLAN.md §2.3 rows 4–6), route their reads through the accessor, and list them in core's descriptors (F6).
Purpose: the views can then show what a tenant overrides in core.
Output: four edited core modules.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§2.3 rows 4-6, §3.5)
@packages/core/src/Sessions.ts (lines 105-115, 670-680)
@packages/core/src/Accounts.ts (lines 80-90, 228-235)
@packages/core/src/RateLimits.ts (lines 265-295, 375-382)
@packages/core/src/EffectiveConfig.ts (lines 81-101)
</context>

<tasks>
<task type="auto">
  <name>Task 1: declare and read through the accessor</name>
  <files>packages/core/src/Sessions.ts, packages/core/src/Accounts.ts, packages/core/src/RateLimits.ts</files>
  <read_first>the three files at the lines in context</read_first>
  <action>Next to each reference add an exported declaration: `SessionConfigScoped = Tenant.perTenant(SessionConfig)`, `AccountsPolicyScoped = Tenant.perTenant(AccountsPolicy)`, `RateLimitOverridesScoped = Tenant.perTenant(RateLimitOverrides)` (no boot fields: each is read only per operation, PLAN.md §2.3). Replace each build-read-plus-old-helper pair (`Sessions.ts:675-676`, `Accounts.ts:232`, `RateLimits.ts:378-379`) with one `yield* Tenant.inForce(<Declared>)` bound to the same local name, so the bodies that `yield*` it per operation do not change. Make `Accounts.config` (`Accounts.ts:86`) and `RateLimits.overrides` (`RateLimits.ts:287`) return the declaration's `layer`, keeping their merge and validation logic. `SessionConfig` has no constructor; leave that. Import `Tenant` from `@awthaq/ports` where the file does not already.</action>
  <verify><automated>npx vitest run packages/core/test/Sessions.test.ts packages/core/test/Accounts.test.ts packages/core/test/RateLimitBudget.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rnE 'yield\* *(SessionConfig|AccountsPolicy|RateLimitOverrides)\b' packages/core/src | wc -l` prints 0 (baseline 3)
    - `grep -rn 'configInForce' packages/core/src/Sessions.ts packages/core/src/Accounts.ts packages/core/src/RateLimits.ts | wc -l` prints 0 (baseline 3)
    - The tenant pins `Sessions.test.ts:617`, `:654`, `Accounts.test.ts:125`, `RateLimitBudget.test.ts:633` pass unchanged
  </acceptance_criteria>
  <done>Three keys declared and read through the accessor.</done>
</task>

<task type="auto">
  <name>Task 2: core's descriptors</name>
  <files>packages/core/src/EffectiveConfig.ts</files>
  <read_first>packages/core/src/EffectiveConfig.ts lines 81-101</read_first>
  <action>Make the `SessionConfig` descriptor from `Sessions.SessionConfigScoped` (keeping its audit). Add descriptors for `Accounts.AccountsPolicyScoped` and `RateLimits.RateLimitOverridesScoped` (no audit; the overrides value holds functions, which `flatten` renders as `[function]`). Leave `SessionCookie` and `MailDispatch` on the transitional bare-reference path; ticket 06 declares them. Update the doc comment of `core` to say it lists core's keys, tenant- and deployment-scoped.</action>
  <verify><automated>npx vitest run packages/core/test/EffectiveConfig.test.ts packages/admin/test/AdminConfig.test.ts packages/cli/test/Doctor.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "ConfigDescriptor.make(" packages/core/src/EffectiveConfig.ts` prints 5 (baseline 3)
    - The admin test "Core's own descriptors are listed too, as defaults" still passes
  </acceptance_criteria>
  <done>The views list every core key a tenant can override.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Raw reads 3 → 0 in core for these keys; 2 new descriptors; existing tenant pins green.
</success_criteria>

## Comments

Result: SessionConfigScoped, AccountsPolicyScoped, RateLimitOverridesScoped declared perTenant; reads via `yield* Tenant.inForce(...)`; Accounts.config/RateLimits.overrides return `.layer`; EffectiveConfig.core has 5 descriptors. RateLimits keeps `builtOverrides` (registry tuning at open) via `Effect.service(RateLimitOverridesScoped.reference)`. Tests green.
