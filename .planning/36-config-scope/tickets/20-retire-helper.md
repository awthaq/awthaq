---
plan: 36-config-scope
ticket: 20
title: "Retire the old helper and the transitional descriptor overload; repository guard"
type: tdd
wave: 3
depends_on: ["05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"]
files_modified:
  - packages/ports/src/Tenant.ts
  - packages/core/src/Tenant.ts
  - packages/core/src/ConfigDescriptor.ts
  - packages/core/test/ConfigScope.guard.test.ts
autonomous: true
requirements: [REQ-EA-1572, REQ-EA-1575]
estimate: {tasks: 3, size: S}
must_haves:
  truths:
    - "The old per-operation helper no longer exists in ports or core, and no source file names it"
    - "ConfigDescriptor.make accepts only a scope declaration"
    - "A repository guard fails when a source file names the old helper, or defines a Config reference without a scope declaration in the same file"
  artifacts:
    - path: "packages/core/test/ConfigScope.guard.test.ts"
      provides: "the static guard (BEH-EA-362)"
  key_links:
    - from: "ConfigScope.guard.test.ts"
      to: "packages/*/src and examples/*/src"
      via: "a file scan modelled on ErasureClearance.boundary.test.ts"
      pattern: "readdirSync"
---
Status: ready-for-agent
Blocked by: 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19

<!-- planner-discipline-allow: configInForce -->

<objective>
Delete the old helper and ticket 04's transitional `ConfigDescriptor.make(reference)` overload, and add a guard so neither the helper nor an undeclared key comes back.
Purpose: replace, don't layer: one rule, one accessor (PLAN.md §3.8 last bullet).
Output: three edited modules and one guard test.
</objective>

<context>
@.planning/36-config-scope/PLAN.md (§3.7, §5.4 first two rows)
@packages/ports/src/Tenant.ts (the old helper and its doc comment, lines 72-85 at `04fa3526`)
@packages/core/src/Tenant.ts (line 14, its re-export)
@packages/core/src/ConfigDescriptor.ts (ticket 04's transitional overload)
@packages/core/test/ErasureClearance.boundary.test.ts (the scan shape to copy)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: the guard, red first</name>
  <files>packages/core/test/ConfigScope.guard.test.ts</files>
  <read_first>packages/core/test/ErasureClearance.boundary.test.ts</read_first>
  <behavior>
    - Case 1: no `.ts` file under `packages/*/src` or `examples/*/src` mentions `configInForce`. At the start of this ticket it fails, listing `ports/src/Tenant.ts` and `core/src/Tenant.ts` only (every caller is gone after tickets 05-19); any other file listed means a Wave-2 ticket is incomplete: stop and report it.
    - Case 2: every source file that defines a configuration reference (a `Context.Reference` or `Context.Service` whose key string ends in `Config"`, `Policy"` or `Overrides"`; match the key strings listed in PLAN.md §2.3) also contains `Tenant.perTenant(` or `Tenant.perDeployment(`. Passes after tickets 05-19.
    - Case 3: every file that calls `ConfigDescriptor.make(` passes it an identifier ending in `Scoped` (regex on the first argument).
  </behavior>
  <action>Copy the scan from the ErasureClearance guard, widened to `examples/*/src`. Name the offending files in each assertion message so a failure says where to look. Cite BEH-EA-362 and ADR-EA-018 D8 in the header comment. Run it: case 1 is red until Task 2.</action>
  <verify><automated>npx vitest run packages/core/test/ConfigScope.guard.test.ts</automated></verify>
  <acceptance_criteria>
    - Case 1 fails before Task 2 and names exactly the two files above; cases 2 and 3 pass
  </acceptance_criteria>
  <done>The guard exists and is red for the right reason.</done>
</task>

<task type="auto">
  <name>Task 2: delete the helper and the overload</name>
  <files>packages/ports/src/Tenant.ts, packages/core/src/Tenant.ts, packages/core/src/ConfigDescriptor.ts</files>
  <read_first>the three files</read_first>
  <action>Remove the old helper and its doc comment from `ports/src/Tenant.ts`, and update any comment in that file that names it (the `TenantConfigApplied` comment at `:58-65` may; point it to `inForce`). Remove its re-export from `core/src/Tenant.ts`. In `ConfigDescriptor.ts` remove ticket 04's transitional overload that accepts a bare `Context.Reference` (it treated the key as per deployment), leaving the declaration-only signature of PLAN.md §3.2.</action>
  <verify><automated>pnpm build && npx vitest run packages/core/test/ConfigScope.guard.test.ts packages/ports/test/TenantConfigScope.test.ts packages/core/test/EffectiveConfig.test.ts</automated></verify>
  <acceptance_criteria>
    - `grep -rn 'configInForce' packages/*/src examples/*/src --include='*.ts' | grep -v /lib/ | wc -l` prints 0 (baseline 26 at `04fa3526`; 2 at the start of this ticket)
    - `grep -rn 'ConfigDescriptor.make(' packages/*/src examples/*/src --include='*.ts' | grep -v /lib/ | wc -l` prints 21 (baseline 14)
    - All three guard cases pass
  </acceptance_criteria>
  <done>One accessor remains.</done>
</task>

<task type="auto">
  <name>Task 3: prove the guard bites</name>
  <files>packages/core/test/ConfigScope.guard.test.ts</files>
  <read_first>none</read_first>
  <action>Plant, one at a time, a throwaway mention of the old helper's name in `packages/magic-link/src/MagicLink.ts`, and a throwaway `ConfigDescriptor.make(MagicLinkConfig)` in the same file; run the guard; confirm cases 1 and 3 fail naming that file; revert each plant. Record both runs in Comments. No committed change.</action>
  <verify><automated>npx vitest run packages/core/test/ConfigScope.guard.test.ts</automated></verify>
  <acceptance_criteria>
    - After reverting, the guard passes and `git diff --stat packages/magic-link` is empty
  </acceptance_criteria>
  <done>The guard is proven to catch both regressions.</done>
</task>
</tasks>

<verification>
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Helper mentions 26 → 0; descriptors 21; perTenant/perDeployment calls 30 (`grep -rnE 'Tenant\.(perTenant|perDeployment)\(' packages/*/src examples/*/src --include='*.ts' | grep -v /lib/ | wc -l`, baseline 0); guard proven.
</success_criteria>

## Comments
