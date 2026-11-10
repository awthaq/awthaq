---
plan: 36-config-scope
ticket: 01
title: "Red tests: the admin view and EffectiveConfig.snapshot disagree with the operations"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/admin/test/AdminConfig.test.ts
  - packages/core/test/EffectiveConfig.test.ts
autonomous: true
requirements: [REQ-EA-1570, REQ-EA-1577]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "At HEAD, an it.effect.fails case shows GET /admin/config's implementation reporting the build value of PasswordConfig.minLength while a calling-fiber Password.config({ minLength: 40 }) is in force (F1)"
    - "At HEAD, an it.effect.fails case shows EffectiveConfig.snapshot reporting `default` for a key the build context overrides (F2)"
    - "pnpm test stays green (the cases are expected failures)"
  artifacts:
    - path: "packages/admin/test/AdminConfig.test.ts"
      provides: "F1 red case"
      contains: "it.effect.fails"
    - path: "packages/core/test/EffectiveConfig.test.ts"
      provides: "F2 red case"
      contains: "it.effect.fails"
  key_links:
    - from: "AdminConfig.test.ts F1 case"
      to: "packages/password/test/PasswordTenantConfig.test.ts:75"
      via: "the same calling-fiber override the operations already honour"
      pattern: "minLength: 40"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Reproduce plan 36's F1 and F2 (PLAN.md §2.7) as expected failures, so the fixing tickets (04, 14) flip them.
Purpose: the go/no-go gate (PLAN.md §1.1) rests on these two disagreements; they must be observable before anything moves.
Output: two `it.effect.fails` cases, green under `pnpm test` at HEAD.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§1.1, §2.4, §2.7)
@packages/admin/test/AdminConfig.test.ts
@packages/admin/test/AdminAccounts.test.ts (lines 75-90: composing Admin with Password)
@packages/password/test/PasswordTenantConfig.test.ts (line 75: the operations honour a calling-fiber override)
@packages/core/test/EffectiveConfig.test.ts
@packages/core/src/EffectiveConfig.ts
@packages/admin/src/Admin.ts (lines 690-725)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: F1, the admin view under a tenant's Password override</name>
  <files>packages/admin/test/AdminConfig.test.ts</files>
  <read_first>packages/admin/test/AdminConfig.test.ts; packages/admin/test/AdminAccounts.test.ts lines 75-90</read_first>
  <behavior>
    - Composition: `Auth.make([Admin.Admin, Password.Password])` through `TestAuth.layer` with services `Admin.config({ canManageUsers: () => Effect.succeed(true) })`, `Password.config({})` (minLength 12, the default) and `EffectiveConfig.layer(built.manifest)`. Add `TestAuth.httpClient.noBreach` to the services if building Password requires a breach client (AdminAccounts.test.ts does).
    - In the test fiber, `admin.effectiveConfig(caller)` piped through `Effect.provide(Password.config({ minLength: 40 }))`.
    - Expected (what the plan delivers): the item with key `awthaq/password/Config` has an entry with path `minLength` and value `"40"`.
    - At HEAD it reports `"12"`, so the case is declared with `it.effect.fails`.
  </behavior>
  <action>Add a new `describe` block "plan 36 F1: the view under a tenant" to AdminConfig.test.ts with one `it.effect.fails` case named "under a tenant's Password.config the view reports the minLength the tenant's operations enforce". Build the composition in a local helper next to the existing `buildLayer` (do not change `buildLayer`; its two cases stay as they are). Import `Password` from `@awthaq/password` (already a devDependency of `@awthaq/admin`). Put a one-line comment above the case: "it.effect.fails until plan 36 ticket 14; the operations already honour this override (PasswordTenantConfig.test.ts:75)".</action>
  <verify><automated>npx vitest run packages/admin/test/AdminConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "it.effect.fails" packages/admin/test/AdminConfig.test.ts` prints 1 (baseline at HEAD: 0)
    - The vitest run passes (the expected failure is reported as passing)
    - Temporarily changing `it.effect.fails` to `it.effect` makes the case fail with "12" vs "40" (prove once, record in Comments, revert)
  </acceptance_criteria>
  <done>The F1 case is an expected failure and the file's other two cases are untouched.</done>
</task>

<task type="tdd">
  <name>Task 2: F2, snapshot under a build-only override</name>
  <files>packages/core/test/EffectiveConfig.test.ts</files>
  <read_first>packages/core/test/EffectiveConfig.test.ts lines 20-60 and 118-140; packages/core/src/EffectiveConfig.ts lines 120-128</read_first>
  <behavior>
    - Build a context `built` that holds a `WidgetConfig` override (`minLength: 20`) with `Layer.build` inside `Effect.scoped`, as the file's other cases build contexts.
    - Run `EffectiveConfig.snapshot(owned)` in a fiber that does NOT carry the override (the shape of a request fiber under a composition whose plugin was built with `Layer.provide(config)`).
    - Expected (what the plan delivers): `source` is `override` and the `minLength` entry is `"20"`, i.e. what `Tenant.configInForce(WidgetConfig, builtValue)` yields in that fiber.
    - At HEAD snapshot reads only the calling fiber and reports `default`, so the case is `it.effect.fails`.
  </behavior>
  <action>Add one `it.effect.fails` case "plan 36 F2: snapshot reports the value an operation reads, a build-only override included". Because the plan changes `snapshot`'s signature (ticket 04 adds the build context as the first argument), write the case so the only line ticket 04 must change is the `snapshot` call; keep the expected values in local constants. Comment above the case: "it.effect.fails until plan 36 ticket 04".</action>
  <verify><automated>npx vitest run packages/core/test/EffectiveConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -c "it.effect.fails" packages/core/test/EffectiveConfig.test.ts` prints 1 (baseline: 0)
    - The vitest run passes
  </acceptance_criteria>
  <done>The F2 case is an expected failure; existing cases unchanged.</done>
</task>
</tasks>

<verification>
npx vitest run packages/admin/test/AdminConfig.test.ts packages/core/test/EffectiveConfig.test.ts
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Two expected-failure cases exist, each proven to fail for the stated reason when un-marked; the per-ticket gate is green.
</success_criteria>

## Comments
Result (uncommitted): F1 in AdminConfig.test.ts and F2 in EffectiveConfig.test.ts added as it.effect.fails. Proven once by un-marking: F1 fails "expected '12' to equal '40'", F2 fails "expected 'default' to equal 'override'"; reverted. Ticket 04 changes only the `snapshot(owned)` call in the F2 case (a `built` context is already built there, `void built` to be replaced by passing it).
