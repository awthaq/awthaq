---
plan: 35-test-mailbox
ticket: 09
title: "core, server and cli stop composing Mailer.layerMemory"
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/core/test/AuthPlugin.test.ts
  - packages/server/test/support/HostPorts.ts
  - packages/cli/src/Doctor.ts
  - packages/cli/test/Doctor.test.ts
autonomous: true
requirements: [REQ-EA-1562]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "core and server tests compose Mailer.layerNoop (they cannot depend on @awthaq/test and read no mail)"
    - "doctor's mailer-development finding names layerNoop, layerConsole or a test mailbox"
  artifacts:
    - path: packages/cli/src/Doctor.ts
      provides: "the updated mailer-development message"
  key_links:
    - from: packages/cli/test/Doctor.test.ts
      to: packages/cli/src/Doctor.ts
      via: "the mailer-development finding over a development: true Mailer"
      pattern: "layerConsole"
---
Status: done (uncommitted)
Blocked by: none

<objective>
Remove the three uses of `Mailer.layerMemory` that only need *a* `Mailer`, and update the doctor message that names it. Independent of every other ticket.

Purpose: `core` and `server` cannot import `@awthaq/test` (neither lists it, and `server` is what `TestAuth` is built on), so they must stop needing `layerMemory` before ticket 17 deletes it.
Output: three test files and one message string in `Doctor.ts`.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§2.2, §4.1 wave 1)
@packages/ports/src/Mailer.ts:95-152 (layerNoop dies on send; layerConsole sets development: true)
@packages/core/test/AuthPlugin.test.ts:300-330 (the Evil plugin, type-level JH-008)
@packages/server/test/support/HostPorts.ts:30-50
@packages/cli/src/Doctor.ts:190-210
@packages/cli/test/Doctor.test.ts:245-265
</context>

<tasks>
<task type="auto">
  <name>Task 1: core and server</name>
  <files>packages/core/test/AuthPlugin.test.ts, packages/server/test/support/HostPorts.ts</files>
  <action>`AuthPlugin.test.ts:315`: the `Mailer` in that list only satisfies a port requirement at the type level (JH-008); use `Mailer.layerNoop`. `HostPorts.ts:42`: use `Mailer.layerNoop`; server tests send no mail. If a server test now dies with layerNoop's "no Mailer was provided" defect, that test sends mail: give it `Mailer.layerConsole` in its own composition (it has `development: true` and logs) rather than restoring a recorder, and say so in `## Comments`.</action>
  <verify><automated>npx vitest run packages/core/test/AuthPlugin.test.ts && pnpm --filter @awthaq/server test</automated></verify>
  <acceptance_criteria>Both pass. `git grep -n 'Mailer.layerMemory' -- packages/core packages/server | wc -l` prints 0 (baseline 2).</acceptance_criteria>
  <done>core and server compose no recording mailer.</done>
</task>

<task type="auto">
  <name>Task 2: cli</name>
  <files>packages/cli/src/Doctor.ts, packages/cli/test/Doctor.test.ts</files>
  <action>`Doctor.ts:203`: replace "(layerNoop or layerMemory)" with "(layerNoop, layerConsole or a test mailbox)" and "is dropped or kept in memory" with "is dropped, only logged or kept for a test"; change nothing else in the finding (its id, severity and condition stay). `Doctor.test.ts:257`: replace `Mailer.layerMemory` with `Mailer.layerConsole`, which also sets `development: true`, so the test keeps proving the finding fires; if the test asserts the message text, update the expected text to match.</action>
  <verify><automated>npx vitest run packages/cli/test/Doctor.test.ts</automated></verify>
  <acceptance_criteria>Passes. Ticket gate: `git grep -nE 'Mailer\.layerMemory|layerNoop or layerMemory' -- packages/core/test/AuthPlugin.test.ts packages/server/test/support/HostPorts.ts packages/cli/src/Doctor.ts packages/cli/test/Doctor.test.ts | wc -l` prints 0 (baseline at 04fa3526: 4).</acceptance_criteria>
  <done>The doctor finding no longer names an adapter that ticket 17 deletes.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Gate 4 → 0; core, server and cli tests green.
</success_criteria>

## Comments

Result: core/server HostPorts use Mailer.layerNoop (no server test sent mail; 319 pass); Doctor message and Doctor.test use layerConsole/new wording (37 pass).
