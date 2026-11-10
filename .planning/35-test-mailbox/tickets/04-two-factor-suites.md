---
plan: 35-test-mailbox
ticket: 04
title: "two-factor suites read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - packages/two-factor/test/support/harness.ts
  - packages/two-factor/test/AuthHttp.test.ts
  - packages/two-factor/test/TwoFactor.test.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "two-factor tests read verification and reset mail through TestMailbox.Mailbox, including over the SQL composition"
    - "The two-factor harness has no mail helper"
  artifacts:
    - path: packages/two-factor/test/support/harness.ts
      provides: "the composition, gates, codeFor; no letForkedFibersRun, awaitMail or tokenOf"
  key_links:
    - from: packages/two-factor/test/TwoFactor.test.ts
      to: TestMailbox.Mailbox
      via: "waitFor({ template })"
      pattern: "waitFor"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Replace the two-factor harness's `awaitMail` (200 × 10 ms poll that returns `undefined` at the end), `letForkedFibersRun` and `tokenOf` with `TestMailbox`.

Purpose: the harness's own comment (`support/harness.ts:90-94`) says fixed yields lose over a real database; the mailbox outwaits socket I/O by subscription.
Output: three files. `packages/two-factor/src/*` is NOT touched (someone else's uncommitted work lives there).
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@packages/two-factor/test/support/harness.ts:85-111
@packages/two-factor/test/AuthHttp.test.ts:18-30,65-80,125-140,250-265
@packages/two-factor/test/TwoFactor.test.ts:20-45,640-646
</context>

<tasks>
<task type="auto">
  <name>Task 1: the suites</name>
  <files>packages/two-factor/test/TwoFactor.test.ts, packages/two-factor/test/AuthHttp.test.ts</files>
  <action>`TwoFactor.test.ts:40` and `:643`: `awaitMail(template)` becomes `(yield* TestMailbox.Mailbox).mail.waitFor({ template })`; where the old code took the newest mail of a template already sent before, pass `nth` = matches recorded before the triggering call + 1 (read `messages` before the call). `tokenOf(mail)` becomes `TestMailbox.secret(mail)`. `AuthHttp.test.ts`: delete the `sentMail` delegate (`:29`); each "fixed yields then findLast" (`:71-72`, `:131-133`, `:256-257`) becomes one `testApp.run` (or `probe.run`) of `Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor(match, { nth }))`; `tokenOf` becomes `TestMailbox.secret`. Drop imports that become unused.</action>
  <verify><automated>npx vitest run packages/two-factor/test/TwoFactor.test.ts packages/two-factor/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Both suites pass, same test count as at HEAD.</acceptance_criteria>
  <done>No two-factor suite reads the mailer's `sent`.</done>
</task>

<task type="auto">
  <name>Task 2: the harness</name>
  <files>packages/two-factor/test/support/harness.ts</files>
  <action>Delete `letForkedFibersRun`, `awaitMail` and `tokenOf` (`:85-111`) and imports only they used. Keep `buildLayer`, `buildDurableAuditLayer`, `Gates`, `codeFor` and the `Sessions.issue` outage decorator (PLAN.md N1).</action>
  <verify><automated>npx vitest run packages/two-factor/test</automated></verify>
  <acceptance_criteria>`git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|letForkedFibersRun|awaitMail|tokenOf' -- packages/two-factor/test | wc -l` prints 0 (baseline at 04fa3526: 20).</acceptance_criteria>
  <done>The package's tests pass; the harness has no mail helper.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Gate 20 → 0; the 200 × 10 ms poller and one fixed-yield copy deleted.
</success_criteria>

## Comments

Result (done, uncommitted): two-factor suites and harness read TestMailbox (waitFor with to/template, nth for the second reset); harness lost letForkedFibersRun/awaitMail/tokenOf; AuthHttp also now serves per test via TestAuth.serve (kept from the working tree). Gate 20 -> 0. 110 tests pass.
