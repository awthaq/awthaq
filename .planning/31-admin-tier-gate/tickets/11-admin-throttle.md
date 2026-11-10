---
plan: 31-admin-tier-gate
ticket: 11
title: "Admin declares its rate rules; the gate spends them (Q2)"
type: tdd
wave: 2
depends_on: [09, 10]
files_modified:
  - packages/admin/src/internal/AdminGate.ts
  - packages/admin/src/Admin.ts
  - packages/admin/src/AdminAccounts.ts
  - packages/admin/src/AdminTenants.ts
  - packages/admin/test/AdminGate.test.ts
autonomous: false
requirements: [REQ-EA-1523]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "Past the gate, each administrator spends one call of the admin, admin.accounts or admin.tenants rule (Key.user, endpoint '*', 60 per minute by default)"
    - "A refused call spends nothing; the list/forceStop filter paths (ask) spend nothing"
    - "The three rules are declared, registered and listed in the manifest like any plugin's"
  artifacts:
    - path: "packages/admin/src/Admin.ts"
      contains: "rateLimitRules"
  key_links:
    - from: "packages/admin/src/Admin.ts"
      to: "packages/admin/src/internal/AdminGate.ts"
      via: "AdminGate.make((adminUserId, action) => limits.spend(\"admin\", { userId: adminUserId }, { endpoint: action }))"
      pattern: "AdminGate\\.make\\("
---
Status: ready-for-human (Q2)
Blocked by: 09, 10

<objective>
Give admin the throttle SAML and webhooks already have, through the core gate.

Purpose: every admin-tier plugin declares a rate rule (ADR-EA-050 decision 1); admin was the one without.
Output: three declared rules, three budgets, `AdminGate.make` taking the throttle closure, the no-op from ticket 09 gone, tests.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§10 Q2)
@packages/webhooks/src/Webhooks.ts (lines 364-390: the declared `admin` rule and `rateLimitRules: rules`; 518-520: `RateLimits.budget`)
@packages/saml/src/Saml.ts (lines 823-833: a budget handed to a module as a closure, the precedent that avoids an import cycle)
@packages/admin/src/internal/AdminGate.ts (after ticket 09: the `shortcut:` no-op throttle)
@packages/admin/src/Admin.ts (:650 plugin class; make), AdminAccounts.ts (:139), AdminTenants.ts
@packages/webhooks/test/WebhooksAdmin.test.ts (lines 406-… "declared and registered (plan 06)")
</context>

<tasks>
<task type="tdd">
  <name>Task 1: Red, then wire</name>
  <files>packages/admin/test/AdminGate.test.ts, packages/admin/src/internal/AdminGate.ts, packages/admin/src/Admin.ts, packages/admin/src/AdminAccounts.ts, packages/admin/src/AdminTenants.ts</files>
  <read_first>packages/admin/src/internal/AdminGate.ts, packages/admin/src/Admin.ts, packages/webhooks/src/Webhooks.ts</read_first>
  <behavior>
    - With `canManageUsers` allowing and `RateLimits.overrides` setting the `admin` rule to 2 per minute (memory limiter), the third `listUsers` by one administrator is `RateLimited`; another administrator still passes.
    - The same for `admin.accounts` (`setUserEmail`) and `admin.tenants` (`listOrganizations`), one case each.
    - A refused call (deny-all) never counts: three refused calls, then allow, then two passes.
    - The manifest lists three rules with `key: user`, `endpoint: "*"`, limit 60.
  </behavior>
  <action>Write the cases in a new describe block "BEH-EA-349: each administrator is rate limited past the gate" and run them red. Then: in each of `Admin.ts`, `AdminAccounts.ts` and `AdminTenants.ts` declare a module-level `rules` table with one rule, `admin: RateLimits.rule({ group: "<the group: admin | admin.accounts | admin.tenants>", endpoint: "*", key: RateLimits.Key.user, limit: 60, window: Duration.minutes(1) })`, add `rateLimitRules: rules` to the plugin class options, and in `make` open `const limits = yield* RateLimits.budget(<Plugin>)` before yielding the gate. Change `AdminGate.make` from an Effect to a function taking `throttle: (adminUserId: Users.UserId, action: string) => Effect.Effect<void, Api.RateLimited>` and pass it into the core declaration; delete the `shortcut:` no-op and its comment. Each plugin calls `AdminGate.make((adminUserId, action) => limits.spend("admin", { userId: adminUserId }, { endpoint: action }))`. Keep the closure shape (SAML's precedent): `AdminGate.ts` must not import the plugin classes, or `pnpm circular` fails. Header comments of the three plugins cite BEH-EA-349.</action>
  <verify><automated>npx vitest run packages/admin</automated></verify>
  <acceptance_criteria>
    - `grep -rl 'RateLimits' packages/admin/src | wc -l` → 3 (baseline 0).
    - `grep -c 'shortcut:' packages/admin/src/internal/AdminGate.ts` → 0 (it was 1 after ticket 09).
    - The new describe block is green.
  </acceptance_criteria>
  <done>Admin throttles per administrator per group, through the gate.</done>
</task>

<task type="auto">
  <name>Task 2: Gate</name>
  <files>packages/admin/src/Admin.ts, packages/admin/src/AdminAccounts.ts, packages/admin/src/AdminTenants.ts</files>
  <read_first>.planning/IMPLEMENTING.md</read_first>
  <action>Run the ticket gate. If `Contract.test.ts` or the plugin contract runner checks declared rules against groups, make it pass by fixing the rule (never the test). If TS2883 appears, use plan 13's exported-alias fix.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/admin && pnpm lint && pnpm knip && pnpm circular</automated></verify>
  <acceptance_criteria>
    - All commands exit 0.
  </acceptance_criteria>
  <done>Green.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| administrator → admin groups | a stolen administrator session can script erasures, bans and credential changes |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-16 | Denial of service / Tampering at scale | admin groups | medium | mitigate | 60 calls per administrator per minute per group, past the gate (Task 1 cases) |
| T-31-17 | Denial of service | legitimate bulk jobs | low | accept | Tunable per tenant with `RateLimits.overrides`; changeset Migration line |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- Three registered rules; pass spends, refusal does not; admin suite green.
</success_criteria>

## Comments
