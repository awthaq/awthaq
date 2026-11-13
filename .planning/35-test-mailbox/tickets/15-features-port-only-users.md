---
plan: 35-test-mailbox
ticket: 15
title: "features compositions that only need a Mailer"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - features/step-definitions/CliSteps.ts
  - features/step-definitions/CompileTimeGates.ts
  - features/step-definitions/CompositionSteps.ts
  - features/step-definitions/RegistriesSteps.ts
  - features/step-definitions/TestingHarnessComposeSteps.ts
autonomous: true
requirements: [REQ-EA-1562]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No features composition uses Mailer.layerMemory; each uses TestMailbox.layer, Mailer.layerNoop or Mailer.layerConsole by what it needs"
    - "The doctor scenario still sees a development mailer (layerConsole sets development: true)"
    - "TestingHarnessComposeSteps' host-vs-harness comparison composes TestMailbox.layer on the host side so the key sets still agree"
  artifacts:
    - path: features/step-definitions/TestingHarnessComposeSteps.ts
      provides: "the host composition over TestMailbox.layer"
  key_links:
    - from: features/step-definitions/TestingHarnessComposeSteps.ts
      to: packages/test/src/TestMailbox.ts
      via: "Layer.mergeAll(..., TestMailbox.layer, ...)"
      pattern: "TestMailbox\\.layer"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Replace the six `Mailer.layerMemory` uses in features step files that compose a `Mailer` only to satisfy a requirement. None reads `sent`.

Purpose: they must not depend on `layerMemory` when ticket 17 deletes it.
Output: five step files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§4.1 wave 2)
@packages/test/src/TestMailbox.ts
@packages/ports/src/Mailer.ts:95-152
@features/step-definitions/CliSteps.ts:255-275
@features/step-definitions/CompileTimeGates.ts:280-292
@features/step-definitions/CompositionSteps.ts:530-540,865-880
@features/step-definitions/RegistriesSteps.ts:380-390
@features/step-definitions/TestingHarnessComposeSteps.ts:60-90
</context>

<tasks>
<task type="auto">
  <name>Task 1: doctor and type-level compositions</name>
  <files>features/step-definitions/CliSteps.ts, features/step-definitions/CompileTimeGates.ts, features/step-definitions/RegistriesSteps.ts</files>
  <action>`CliSteps.ts:263`: the scenario wants doctor's `mailer-development` finding (`:271`); use `Mailer.layerConsole`, which also sets `development: true`. `CompileTimeGates.ts:288`: the composition proves a `Mailer` closes the requirement; use `Mailer.layerNoop` if the step only builds or type-checks it, `TestMailbox.layer` if it runs a plugin that sends. `RegistriesSteps.ts:387`: `NotifierFixture.layer` only needs `Mailer` to build; use `Mailer.layerNoop` (its `notify` reads nothing once ticket 13 lands, and only `sent` before that, which `layerNoop` stubs until ticket 17).</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>`pnpm test:bdd` passes.</acceptance_criteria>
  <done>Three files compose a non-recording `Mailer`.</done>
</task>

<task type="auto">
  <name>Task 2: compositions that run a plugin</name>
  <files>features/step-definitions/CompositionSteps.ts, features/step-definitions/TestingHarnessComposeSteps.ts</files>
  <action>`CompositionSteps.ts:536` and `:873`: these build hosted apps (`:873` an `AuthHost.layer` over SQLite) that may send mail during the scenario; use `TestMailbox.layer` (import `{ TestMailbox }` from `@awthaq/test`, already a dependency of `@awthaq/features`). `TestingHarnessComposeSteps.ts:76`: this host composition is compared with `TestAuth.layer`'s output (BEH-EA-344-style key parity); use `TestMailbox.layer` so both sides hold `Mailer`, `SmsSender` and `TestMailbox.Mailbox`. If a step there lists keys explicitly, add the two new keys to both sides' expectation, never one.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.steps.test.ts && pnpm test:bdd</automated></verify>
  <acceptance_criteria>Both pass. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory' -- features/step-definitions/CliSteps.ts features/step-definitions/CompileTimeGates.ts features/step-definitions/CompositionSteps.ts features/step-definitions/RegistriesSteps.ts features/step-definitions/TestingHarnessComposeSteps.ts | wc -l` prints 0 (baseline at 04fa3526: 6).</acceptance_criteria>
  <done>No port-only features composition depends on `layerMemory`.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 6 → 0; `pnpm test:bdd` green.
</success_criteria>

## Comments

Result: CliSteps -> layerConsole; CompileTimeGates, RegistriesSteps -> layerNoop; CompositionSteps (2) and TestingHarnessComposeSteps -> TestMailbox.layer. Also CompositionSteps:845 type-gate fragment `${port}.layerMemory` -> `layerNoop` (follows CompileTimeGates). Unused Mailer imports dropped. Feature suites 02, 03, 25, 26 green, leak-guard 0/0.
