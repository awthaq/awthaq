---
plan: 31-admin-tier-gate
ticket: 12
title: "Clearance carries the caller; core boundary and types tests"
type: execute
wave: 3
depends_on: [07, 08, 11]
files_modified:
  - packages/admin/src/Admin.ts
  - packages/admin/src/AdminAccounts.ts
  - packages/core/test/AdminTierGate.boundary.test.ts
  - packages/core/test/AdminTierGate.types.test.ts
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Across packages/*/src, only core/src/AdminTierGate.ts publishes auth.admin.actionDenied"
    - "A Clearance cannot be built outside the core module"
    - "Post-gate events in admin read the clearance's adminUserId, not caller.ref.id"
  artifacts:
    - path: "packages/core/test/AdminTierGate.boundary.test.ts"
      provides: "the only-denier guard"
    - path: "packages/core/test/AdminTierGate.types.test.ts"
      provides: "the clearance cannot be forged; targets are typed"
  key_links:
    - from: "packages/core/test/AdminTierGate.boundary.test.ts"
      to: "packages/*/src"
      via: "readdirSync scan as in ErasureClearance.boundary.test.ts"
      pattern: "auth\\\\.admin\\\\.actionDenied"
---
Status: ready-for-agent
Blocked by: 07, 08, 11 (if Q2 is "no": 07, 08, 09)

<objective>
Lock the deepening in and take the `caller.ref.id` residue the gate makes removable.

Purpose: a fifth hand-written denial must fail a test; a forged clearance must not compile; events after the gate name the administrator the gate saw.
Output: two core tests; `Admin.ts` and `AdminAccounts.ts` read `cleared.adminUserId` after the gate.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.6, §5.1)
@packages/core/test/ErasureClearance.boundary.test.ts (the scan pattern)
@packages/core/test/FederatedIdentity.types.test.ts (a core types test with @ts-expect-error)
@packages/admin/src/Admin.ts (caller.ref.id at :751, 762, 774, 790, 823, 846, 860, 873, 878, 885)
@packages/admin/src/AdminAccounts.ts (caller.ref.id at :169, 185, 216, 225, 265)
</context>

<tasks>
<task type="auto">
  <name>Task 1: Core boundary and types tests</name>
  <files>packages/core/test/AdminTierGate.boundary.test.ts, packages/core/test/AdminTierGate.types.test.ts</files>
  <read_first>packages/core/test/ErasureClearance.boundary.test.ts, packages/core/test/FederatedIdentity.types.test.ts</read_first>
  <action>Boundary test (header cites ADR-EA-050 and BEH-EA-347): scan every `packages/*/src/**/*.ts` as `ErasureClearance.boundary.test.ts` does; assert the files containing `_tag: "auth.admin.actionDenied"` are exactly `["core/src/AdminTierGate.ts"]`, and the files containing the literal `"auth.admin.actionDenied"` are exactly `["core/src/AdminTierGate.ts", "core/src/AuthEventSchemas.ts"]`. Types test: an object literal with `adminUserId`, `config` and `target` assigned to `AdminTierGate.Clearance<…>` is a `@ts-expect-error`; for a declaration whose target is `string`, `named(caller, action, Option.some(1))` is a `@ts-expect-error`; for an action union `"a" | "b"`, `named(caller, "c", …)` is a `@ts-expect-error`. Follow the file layout of the existing core types tests (they run under `pnpm typecheck` via `tsconfig.test.json`).</action>
  <verify><automated>npx vitest run packages/core/test/AdminTierGate.boundary.test.ts && pnpm typecheck</automated></verify>
  <acceptance_criteria>
    - `grep -rl '_tag: "auth.admin.actionDenied"' packages/*/src` prints only `packages/core/src/AdminTierGate.ts` (baseline: three plugin files).
    - Both test files exist (baseline: absent).
  </acceptance_criteria>
  <done>The deepening is guarded by tests, not by review.</done>
</task>

<task type="auto">
  <name>Task 2: Post-gate caller reads take the clearance</name>
  <files>packages/admin/src/Admin.ts, packages/admin/src/AdminAccounts.ts</files>
  <read_first>packages/admin/src/Admin.ts, packages/admin/src/AdminAccounts.ts</read_first>
  <action>In every operation that has a clearance in scope, replace `Users.UserId(caller.ref.id)` in event payloads and records with `cleared.adminUserId` (Admin.ts :751, 774, 790, 823, 846, 878, 885; AdminAccounts.ts :185, 216, 265, re-locate by symbol). Where an operation discards its clearance today (`yield* gate.user(...)` then uses `caller`), bind it. Leave the reads that run before the gate (self-ban :762, self-impersonation :860, AdminAccounts self checks :169, :225) and `actingAs` (:873, it needs the principal's `type`): they are plan 40's (`Actor`). No behaviour change: the gate's `adminUserId` is built from the same `caller.ref.id`.</action>
  <verify><automated>npx vitest run packages/admin && pnpm typecheck && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - `grep -c 'caller\.ref\.id' packages/admin/src/Admin.ts` ≤ 3 (baseline 10).
    - `grep -c 'caller\.ref\.id' packages/admin/src/AdminAccounts.ts` ≤ 2 (baseline 5).
    - Across admin, organization, saml and webhooks `src`, `caller.ref.id` totals ≤ 11 (baseline 43); list any remaining admin site in Comments with the reason it precedes the gate.
  </acceptance_criteria>
  <done>Residue down to the pre-gate reads plan 40 owns.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| any plugin source → `auth.admin.actionDenied` | a hand-written denial would bypass the gate's ordering |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-18 | Tampering | a new hand-written admin-tier gate | medium | mitigate | Boundary test fails on any `_tag: "auth.admin.actionDenied"` outside core's gate |
| T-31-08 | Spoofing | forged clearance | high | mitigate | Types test (`@ts-expect-error` on a literal clearance) |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Only-denier guard green; forged clearance does not compile; `caller.ref.id` ≤ 11 across the four packages.
</success_criteria>

## Comments
