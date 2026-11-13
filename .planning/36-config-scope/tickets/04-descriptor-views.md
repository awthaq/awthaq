---
plan: 36-config-scope
ticket: 04
title: "Descriptors carry the scope; EffectiveConfig resolves through the rule"
type: tdd
wave: 1
depends_on: ["03", "01"]
files_modified:
  - packages/core/src/ConfigDescriptor.ts
  - packages/core/src/EffectiveConfig.ts
  - packages/core/test/EffectiveConfig.test.ts
autonomous: true
requirements: [REQ-EA-1577]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "ConfigDescriptor.make accepts a scope declaration and copies its scope and boot fields; a bare Context.Reference is still accepted and declared deployment-scoped (transitional, removed in ticket 20)"
    - "view(built, calling) renders Tenant.resolveConfig's result; source is tenant, override or default"
    - "EffectiveConfig.snapshot(built, descriptors) reads the ambient fiber as the calling context"
    - "Ticket 01's F2 case passes as a plain it.effect"
    - "The CLI's read(context, descriptors) is unchanged in behaviour"
  artifacts:
    - path: "packages/core/src/ConfigDescriptor.ts"
      provides: "View.scope, source tenant, view(built, calling)"
    - path: "packages/core/src/EffectiveConfig.ts"
      provides: "read(built, descriptors, calling), snapshot(built, descriptors)"
  key_links:
    - from: "ConfigDescriptor view"
      to: "Tenant.resolveConfig"
      via: "the same rule as Tenant.inForce"
      pattern: "resolveConfig\\("
---
Status: done (uncommitted)
Blocked by: 03, 01

<objective>
Make the descriptor and the views read the same rule the operations read (PLAN.md §3.4).
Purpose: fixes F2 and is the half of F1 that lives in core.
Output: changed `ConfigDescriptor`, `EffectiveConfig`, and their test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§3.2, §3.4, §4.1 on the transitional overload)
@packages/core/src/ConfigDescriptor.ts
@packages/core/src/EffectiveConfig.ts
@packages/core/test/EffectiveConfig.test.ts
@packages/ports/src/Tenant.ts (ticket 03's exports)
@packages/cli/src/ConfigList.ts and packages/cli/src/Doctor.ts (callers of read/audit; must keep working)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: tests at the new interface</name>
  <files>packages/core/test/EffectiveConfig.test.ts</files>
  <read_first>packages/core/test/EffectiveConfig.test.ts</read_first>
  <behavior>
    - Ticket 01's F2 case becomes `it.effect` and calls `snapshot(built, owned)`.
    - The existing "snapshot reads the ambient context of a running application" case (lines ~122-137) is rewritten: a tenant-scoped widget declaration, a calling-fiber value, `snapshot(emptyBuilt, owned)` reports `source: "tenant"`, `scope: "tenant"` and the calling value.
    - A deployment-scoped declaration with a calling-fiber value: `source` is `default` (or `override` when built holds it) and the entries are the build value.
    - A tenant-scoped declaration with a boot field: under a calling value, the boot entry shows the build value and the other entries the calling value.
    - A calling-fiber value holding a `Redacted` renders `<redacted>`; the existing secret cases keep passing.
    - `read(context, owned)` with no calling context: unchanged output (the existing `read`/`audit` cases pass with only the declaration added to the widget's descriptor).
  </behavior>
  <action>Write the cases first; they fail to compile until Task 2. Make the widget's descriptor from `Tenant.perTenant(WidgetConfig, ...)` (import `Tenant` from `@awthaq/ports`, which core already depends on) and add a second, deployment-scoped widget.</action>
  <verify><automated>npx vitest run packages/core/test/EffectiveConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "it.effect.fails" packages/core/test/EffectiveConfig.test.ts` prints 0 after the ticket (baseline after ticket 01: 1)
  </acceptance_criteria>
  <done>The new cases describe the target and fail before Task 2.</done>
</task>

<task type="auto">
  <name>Task 2: descriptor and views</name>
  <files>packages/core/src/ConfigDescriptor.ts, packages/core/src/EffectiveConfig.ts</files>
  <read_first>packages/core/src/ConfigDescriptor.ts lines 56-168; packages/core/src/EffectiveConfig.ts</read_first>
  <action>In ConfigDescriptor: add `scope` and `source: "tenant"` to `View`, `scope` and `boot` to `ConfigDescriptor`; change `view` to `(built, calling?)` per PLAN.md §3.2. `make` takes either a tenant/deployment declaration whose `reference` is a `Context.Reference` or, transitionally, a bare `Context.Reference` treated as `Tenant.perDeployment(reference)` (an overload or a union narrowed with a type guard on the `scope` property; no assertion). `view` reads the build value from `built` (default when absent), resolves with `Tenant.resolveConfig`, applies `project`, renders with `flatten`, and sets `source` per PLAN.md §3.4. `audit` keeps reading one context (the CLI's). In EffectiveConfig: `read(built, descriptors, calling?)` passes both contexts to `view`; `snapshot(built, descriptors)` is `Effect.contextWith` over `read`; update the module header (lines 5-13) so it no longer claims the ambient read alone. Mark the bare-reference path with a one-line `shortcut:` comment naming ticket 20. Leave `core` (the descriptor list) as is; ticket 05 declares its keys.</action>
  <verify><automated>npx vitest run packages/core/test/EffectiveConfig.test.ts packages/cli/test/Doctor.test.ts packages/admin/test/AdminConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "resolveConfig" packages/core/src/ConfigDescriptor.ts` is at least 1 (baseline 0)
    - `grep -n "export const snapshot" packages/core/src/EffectiveConfig.ts` shows the two-argument signature
    - `packages/admin/src/Admin.ts` still compiles unchanged (it calls `read(builtIn, catalog)`, whose behaviour without a calling context is the same)
    - AdminConfig.test.ts's F1 case is still an expected failure (ticket 14 flips it)
  </acceptance_criteria>
  <done>Views and operations share one rule in core.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| running application → an administrator reading the effective configuration | configuration values, some secret, leave the process as text |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-36-04 | Information disclosure | `ConfigDescriptor.view` rendering a calling-fiber value | medium | mitigate | the resolved value goes through the same `flatten` (declared-sensitive fields and every `Redacted` render `<redacted>`); Task 1 asserts a calling-fiber `Redacted` is redacted |
</threat_model>

<verification>
pnpm build
npx vitest run packages/core/test/EffectiveConfig.test.ts packages/cli/test/Doctor.test.ts packages/cli/test/ConfigLoader.test.ts packages/admin/test/AdminConfig.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
F2 fixed and its case un-marked; CLI output unchanged; gate green.
</success_criteria>

## Comments
- Result: ConfigDescriptor.make takes a declaration (bare Reference still accepted, shortcut for ticket 20); View.scope, source "tenant"; read(built, descriptors, calling?), snapshot(built, descriptors). Declared/PerTenant/PerDeployment gained a third type parameter K so the declaration keeps the Reference type (a Context.Key would lose `defaultValue`). Early wire edit from ticket 14: ConfigItemDto gained `scope` and source "tenant", Admin passes item.scope; Admin.effectiveConfig still calls `read` (ticket 14 flips it to snapshot).
