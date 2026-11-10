---
plan: 31-admin-tier-gate
ticket: 06
title: "Core AdminTierGate module and its suite"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/core/src/AdminTierGate.ts
  - packages/core/src/index.ts
  - packages/core/test/AdminTierGate.test.ts
  - spec/overview.md
  - .changeset/admin-tier-gate.md
autonomous: true
requirements: [REQ-EA-1520, REQ-EA-1522, REQ-EA-1523]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "A refused call publishes exactly one auth.admin.actionDenied with prefix+action and what the call named, fails with the declaration's typed error and spends nothing"
    - "A passing call spends the declaration's throttle once, after the predicate, and yields a clearance carrying the configuration in force"
    - "A value provided for the configuration key in the calling fiber is what the predicate sees; otherwise the built value"
    - "found answers per the six rows of PLAN §3.3"
    - "ask publishes nothing and never throttles"
  artifacts:
    - path: "packages/core/src/AdminTierGate.ts"
      provides: "make, Clearance, Asked, Declaration, Named"
      exports: ["make", "Clearance", "Asked", "Declaration", "Named"]
    - path: "packages/core/test/AdminTierGate.test.ts"
      provides: "the 11 cases of PLAN §5.1"
  key_links:
    - from: "packages/core/src/AdminTierGate.ts"
      to: "packages/ports/src/Tenant.ts"
      via: "Tenant.configInForce(declaration.config, declaration.built) per call"
      pattern: "configInForce\\(declaration\\.config"
    - from: "packages/core/src/AdminTierGate.ts"
      to: "packages/core/src/AuthEventSchemas.ts"
      via: "events.publish({ _tag: \"auth.admin.actionDenied\", … })"
      pattern: "auth\\.admin\\.actionDenied"
---
Status: ready-for-human (Q7: build the core gate, reversing plan 13 Q5; Q1: the uniform answer)
Blocked by: none

<objective>
Build the deep module: one admin-tier gate in `@awthaq/core` with three operations over a plugin's declaration.

Purpose: the fail-closed ordering, the configuration-in-force read, the tenant in the predicate input, the read-then-ask ordering with the uniform answer, the denial event and the throttle are written once and tested once.
Output: `packages/core/src/AdminTierGate.ts`, its barrel export, its suite, the `spec/overview.md` row (the core inventory is diffed by `spec/scripts/check-drift.mjs`), a changeset.
</objective>

<context>
@.planning/31-admin-tier-gate/PLAN.md (§3.1–§3.3, §5.1)
@packages/admin/src/internal/AdminGate.ts (the design this generalizes: clearances :213-240, `refuse`/`decide` :258-301)
@packages/core/src/FederatedIdentity.ts (a core `make` effect yielded in plugins' `make`)
@packages/core/src/internal/signInSteps.ts (lines 37-45: the `Clearance` brand idiom)
@packages/core/src/Tenant.ts and packages/ports/src/Tenant.ts (lines 74-85: configInForce)
@packages/core/src/AuthEventSchemas.ts (lines 389-415: AdminActionDeniedEvent)
@packages/core/src/index.ts
@packages/webhooks/test/WebhooksAdmin.test.ts (lines 63-100: capturing published events with `AuthEvents.is`)
@spec/overview.md (Domain stratum table, `FederatedIdentity` row :166)
</context>

<tasks>
<task type="tdd">
  <name>Task 1: Tracer — `named` end to end with one test</name>
  <files>packages/core/src/AdminTierGate.ts, packages/core/src/index.ts, packages/core/test/AdminTierGate.test.ts</files>
  <read_first>packages/admin/src/internal/AdminGate.ts, packages/core/src/FederatedIdentity.ts, packages/core/src/internal/signInSteps.ts</read_first>
  <behavior>
    - Case 1 of PLAN §5.1 (deny-all default: one event, typed error, no throttle call) and case 3 (a pass throttles once and yields a clearance with the configuration in force).
  </behavior>
  <action>Create `AdminTierGate.ts` with a header comment citing ADR-EA-050 and BEH-EA-347 (both written later in this plan; the comment may cite them now). Export the types `Asked`, `Named`, `Declaration` and `Clearance` exactly as PLAN §3.2 sketches them; the clearance brand constructor is a module-private `Brand.nominal` (not exported). Export `make` as a generic function returning `Effect.gen`, with no return-type annotation: it yields `AuthEvents.AuthEvents` once and returns `{ named, found, ask }`. Write `named` first (PLAN §3.3): read `Tenant.configInForce(declaration.config, declaration.built)` and `Tenant.TenantContext` on every call; convert the caller once with `Users.UserId(caller.ref.id)`; ask `declaration.predicate`; on a refusal either run the optional `refuse` or publish `auth.admin.actionDenied` with `action: declaration.prefix + action` and the spread of `Option.match(target, { onNone: () => ({}), onSome: (t) => declaration.names(action, t) })`, then fail `declaration.denied()`; on a pass call `declaration.throttle(adminUserId, action)` and mint the clearance. Use `Effect.fnUntraced` like admin's gate. Add `export * as AdminTierGate from "./AdminTierGate.ts";` to `packages/core/src/index.ts` next to `FederatedIdentity`, with a one-line header comment in the barrel's style. In the test file, declare a test configuration with `Context.Reference` (default: predicate always false) and a recording throttle built on a `Ref`; provide `AuthEvents.layer`.</action>
  <verify><automated>npx vitest run packages/core/test/AdminTierGate.test.ts</automated></verify>
  <acceptance_criteria>
    - `test -f packages/core/src/AdminTierGate.ts` (baseline: absent).
    - `grep -c 'AdminTierGate' packages/core/src/index.ts` ≥ 1 (baseline 0).
    - Cases 1 and 3 pass.
  </acceptance_criteria>
  <done>`named` works end to end through a real `AuthEvents` and a recording throttle.</done>
</task>

<task type="tdd">
  <name>Task 2: `found`, `ask` and the rest of the suite</name>
  <files>packages/core/src/AdminTierGate.ts, packages/core/test/AdminTierGate.test.ts</files>
  <read_first>.planning/31-admin-tier-gate/PLAN.md</read_first>
  <behavior>
    - Cases 2 and 4–11 of PLAN §5.1, including the six-row `found` table of §3.3 (answer, number of events, throttle calls per row).
    - A predicate that dies makes the call die (assert with `Effect.exit` and `Exit.isFailure` plus a defect cause); never a clearance.
  </behavior>
  <action>Write the failing cases first, then `found` and `ask`. `found(caller, action, find, targetOf, notFound)`: run `find` first (its error passes through unchanged and nothing else runs); with `Some(record)` ask the predicate with `Option.some(targetOf(record))`, pass → throttle → clearance plus `record`; on a refusal publish one denial naming `declaration.names(action, targetOf(record))`, then ask the general question (`target: Option.none()`): true → throttle, fail `notFound()`; false → fail `denied()` without publishing again. With `None` ask the general question: true → throttle, fail `notFound()`; false → publish a denial with no names, fail `denied()`. `ask(caller, question)` reads the configuration in force and tenant and returns `question(config, asked)` with `target: Option.none()`; it publishes nothing, throttles nothing and has no error channel. Keep one private helper for "publish and fail" so `named` and `found` share it. No `as`; narrow with `Option.match`. If declaration emit reports TS2883 for a consumer later, export a named type alias rather than annotating `make` (plan 13 Decisions taken).</action>
  <verify><automated>npx vitest run packages/core/test/AdminTierGate.test.ts</automated></verify>
  <acceptance_criteria>
    - All 11 cases pass; `grep -c 'it.effect(' packages/core/test/AdminTierGate.test.ts` ≥ 11.
    - `pnpm lint` passes: `.oxlintrc.json:37` (`consistent-type-assertions: never`) rejects any `as` in library source.
  </acceptance_criteria>
  <done>The gate's whole behaviour is pinned at its interface.</done>
</task>

<task type="auto">
  <name>Task 3: Overview row, changeset, package gate</name>
  <files>spec/overview.md, .changeset/admin-tier-gate.md</files>
  <read_first>spec/overview.md, .changeset/admin-denied-target.md</read_first>
  <action>Add a Domain-stratum row to `spec/overview.md` after `FederatedIdentity`: "`AdminTierGate` | `make` (like `SignIn`/`FederatedIdentity`): the one admin-tier gate; a plugin declares its configuration, predicate adapter, denial names, typed refusal and throttle; `named`, `found` (read first, uniform answer) and `ask`; a pass mints a clearance carrying the configuration in force (ADR-EA-050) | `AdminTierGate.ts`", and a Document Control revision line (plan 31 ticket 06). Create `.changeset/admin-tier-gate.md` with `"@awthaq/core": minor`, a two-sentence summary and `Migration: none (a new module; no existing interface changes).` Run the gate.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/core && pnpm lint && pnpm knip && pnpm circular && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c 'AdminTierGate' spec/overview.md` ≥ 1 (baseline 0).
    - knip reports nothing outside `.reports/` (the new exports are used by the test; if knip flags them as unused until ticket 07, add the module to knip's ignore for exports only in this ticket and remove it in ticket 07, noting it in Comments).
  </acceptance_criteria>
  <done>Core green; inventory and changeset in place.</done>
</task>
</tasks>

<threat_model>
## Trust crossings

| Crossing | Description |
|---|---|
| plugin operation → core gate | the gate is the only thing between an authenticated administrator and an admin-tier write |
| host predicate → gate | host code decides; its failure modes must never open the gate |

## STRIDE threat register

| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |
|---|---|---|---|---|---|
| T-31-07 | Elevation of privilege | predicate defect | high | mitigate | Predicates have no error channel; a defect propagates and the call dies (case 11); no default-allow path exists |
| T-31-08 | Spoofing | forged clearance | high | mitigate | The brand constructor is module-private; ticket 12's types test pins it |
| T-31-09 | Elevation of privilege | stale configuration | high | mitigate | `configInForce` on every call (case 5); never read at build |
| T-31-02 | Information disclosure | `found` answers | medium | mitigate | The six-row table is tested row by row (case 7) |
| T-31-05 | Denial of service | probing | low | mitigate | Not-found answers to a holder of the action spend the throttle (case 7) |
| T-31-10 | Information disclosure | denial event fields | low | accept | Identifiers only (`pii: []` on the definition); the same fields admin already publishes |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- 11 interface cases green; `AdminTierGate` exported from `@awthaq/core`; overview and changeset updated.
</success_criteria>

## Comments
