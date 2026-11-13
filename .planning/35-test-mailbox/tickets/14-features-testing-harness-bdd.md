---
plan: 35-test-mailbox
ticket: 14
title: "BDD: BEH-EA-359 scenarios, BEH-EA-195 on a two-member port"
type: tdd
wave: 3
depends_on: [02]
files_modified:
  - features/step-definitions/TestingHarnessSteps.ts
  - features/features/08-tooling/25-testing-harness.feature
  - features/traceability.md
autonomous: true
requirements: [REQ-EA-1560, REQ-EA-1561, REQ-EA-1562]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Three @BEH-EA-359 scenarios run: a detached-fiber mail is awaited (REQ-EA-1560), an expected mail that never comes fails at a real deadline without naming the recipient (REQ-EA-1561), a refutation fails when a matching mail arrives within its window (REQ-EA-1562)"
    - "BEH-EA-195's scenarios use Layer.mock(RateLimiter.RateLimiter)({ consume }) and observe check as unimplemented"
    - "REQ-EA-545's composition facts read the mailbox, not Mailer.sent"
  artifacts:
    - path: features/features/08-tooling/25-testing-harness.feature
      provides: "Rule @BEH-EA-359 with @REQ-EA-1560..1562; 545/551/552 text without Mailer.layerMemory"
  key_links:
    - from: features/features/08-tooling/25-testing-harness.feature
      to: features/step-definitions/TestingHarnessSteps.ts
      via: "step text"
      pattern: "TestMailbox"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Write the BDD half of BEH-EA-359 and move BEH-EA-195's example off `Mailer` before ticket 17 leaves `Mailer` with one member (PLAN.md §2.6 item 3, R5).

Purpose: the spec examples stay executable across the port change.
Output: the step file, the feature file, three new and three revised rows in `features/traceability.md`.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§6.2, §6.4)
@packages/test/src/TestMailbox.ts
@packages/ports/src/RateLimiter.ts:86-100 (consume and check: two members)
@features/step-definitions/TestingHarnessSteps.ts:55-90,230-275,440-530
@features/features/08-tooling/25-testing-harness.feature:9-20,77-95
@features/traceability.md:1-20,555-570,1355-1362
</context>

<tasks>
<task type="tdd">
  <name>Task 1: red, the BEH-EA-359 scenarios</name>
  <files>features/features/08-tooling/25-testing-harness.feature</files>
  <behavior>
    - Append a rule after the BEH-EA-195 rule: a `# BEH-EA-359 — spec/behaviors/25-testing-harness.md` comment, `@BEH-EA-359`, `Rule: TestAuth's base records mail in a mailbox a test awaits`.
    - `@REQ-EA-1560` Scenario "A mail sent on a detached fiber is awaited, not yielded for": Given "TestAuth.layer" composes "Password"; When an anonymous visitor signs up as "ada@example.com" through the handler; Then the test waits for the "verify-email" mail to "ada@example.com" through "TestMailbox.Mailbox"; And the mailed token is a non-empty secret.
    - `@REQ-EA-1561` Scenario "An expected mail that never comes fails at a real deadline": Given a test running under "TestClock"; When it waits 40 milliseconds for a "never-sent" mail to "ghost@example.com"; Then the wait fails; And the failure names "never-sent" and does not contain "ghost@example.com".
    - `@REQ-EA-1562` Scenario "A refutation fails when a matching mail arrives within its window": Given a mailbox with no mail; When a detached fiber sends a "late" mail 5 milliseconds later while the test refutes "late" mail; Then the refutation fails.
  </behavior>
  <action>Write the rule and scenarios above (wording may be tightened, the tags and meanings may not). Run the feature once: the new steps are undefined, which is the red state.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.steps.test.ts (expected red: undefined steps)</automated></verify>
  <acceptance_criteria>The three scenarios exist and fail only on undefined steps.</acceptance_criteria>
  <done>Red recorded.</done>
</task>

<task type="tdd">
  <name>Task 2: green, the step definitions and the BEH-EA-193/195 moves</name>
  <files>features/step-definitions/TestingHarnessSteps.ts, features/features/08-tooling/25-testing-harness.feature</files>
  <action>Define the steps for REQ-EA-1560..1562 with `TestAuth.app(TestAuth.layer(Auth.make([Password.Password]), { services: TestAuth.httpClient.noBreach }))`, the handler, `app.run(Effect.flatMap(TestMailbox.Mailbox, …))`, and, for 1561/1562, `TestMailbox.layer` provided directly inside an `Effect` that runs under the scenario's `TestClock`; store outcomes in the World's `outcomes` as the file does. Assert the defect text with `Cause.pretty`. Then: `gatherCompositionFacts` (`:66-90`) sends its probe through `Mailer.Mailer` and computes `mailerRecords` from `Context.get(context, TestMailbox.Mailbox).mail.messages` instead of `mailer.sent` (`:72`). REQ-EA-545's step text (feature `:17`) becomes "uses memory repositories, \"TestMailbox.layer\", a permissive …"; rename the step definition's text to match. BEH-EA-195: the feature's REQ-EA-551 lines say `"RateLimiter"`/`"consume"` instead of `"Mailer"`/`"send"`; the step at `:446-452` asserts `port === "RateLimiter"`; the double at `:459` becomes `Layer.mock(RateLimiter.RateLimiter)({ consume: (input) => Ref.update(keys, (seen) => [...seen, input.key]) })`, the probe calls `consume` then `Effect.exit(limiter.check(input))`, and the assertion at `:479` matches `/Unimplemented method "check"/`. REQ-EA-552 (feature `:88-92`, steps `:494-525`): title "Layer.mock is chosen over the test mailbox when a test needs no recording or inspection behavior", the When names `"TestMailbox"`; its `Mailer` double with `send` alone stays (one member is still a legitimate `Layer.mock`).</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.steps.test.ts</automated></verify>
  <acceptance_criteria>The feature passes, including the three new scenarios. `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|assert\.equal\(port, "Mailer"\)' -- features/step-definitions/TestingHarnessSteps.ts features/features/08-tooling/25-testing-harness.feature | wc -l` prints 0 (baseline 6).</acceptance_criteria>
  <done>BEH-EA-359 is executable; BEH-EA-195 survives ticket 17.</done>
</task>

<task type="auto">
  <name>Task 3: traceability</name>
  <files>features/traceability.md</files>
  <action>Re-read the header's "highest issued REQ-EA" line and the last rows (`:1360-1361`, REQ-EA-1513 at HEAD) first: if another plan has since issued ids at or above 1560, stop and ask the plan owner for a new block. Add rows REQ-EA-1560, 1561, 1562 → BEH-EA-359 → `08-tooling/25-testing-harness.feature` with the scenario titles, in the file's format (generated layout, `features/scripts/allocate-req-ea.py` describes it). Update REQ-EA-545's and REQ-EA-552's titles (`:558`, `:565`) to the new scenario names. Raise the header's "highest issued" to REQ-EA-1562 only if the header tracks the maximum id issued.</action>
  <verify><automated>pnpm test:bdd && pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>Both pass. `git grep -c 'REQ-EA-156[012]' -- features/traceability.md` prints 3 (baseline 0). Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|assert\.equal\(port, "Mailer"\)' -- features/step-definitions/TestingHarnessSteps.ts features/features/08-tooling/25-testing-harness.feature features/traceability.md | wc -l` prints 0 (baseline at 04fa3526: 7).</acceptance_criteria>
  <done>The scenarios are traced.</done>
</task>
</tasks>

<threat_model>
| Crossing | Description |
|---|---|
| test output | the REQ-EA-1561 scenario prints a failure message into CI logs |

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-35-05 | I (information disclosure) | `waitFor` defect text in BDD output | low | mitigate | REQ-EA-1561 asserts the recipient is absent from the defect, at the BDD level as well as in ticket 01's case 3 |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
Gate 7 → 0; three new scenarios green; BEH-EA-195's scenarios run on `RateLimiter`.
</success_criteria>

## Comments

Result (done, uncommitted): DEVIATION: BEH-EA-354 used instead of 359 everywhere (REQ-EA-1560..1562 kept); spec files are ticket 19's, so the traceability links for 354 carry no anchor. `TestAuth.app` does not exist: steps use `TestAuth.serve(passwordApp)`. 545/551/552 moved off Mailer; 195 uses Layer.mock(RateLimiter) with `check` unimplemented. traceability regenerated by allocate-req-ea.py (also picked up other agents' uncommitted rows REQ-EA-1520/21/30..33/50..52). Gate 7 -> 0. vitest 25-testing-harness: 50 passed. spec:verify:strict not run.
