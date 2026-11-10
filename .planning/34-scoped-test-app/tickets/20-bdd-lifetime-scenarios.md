---
plan: 34-scoped-test-app
ticket: 20
title: BDD scenarios REQ-EA-1550..1552 and the World-lifetime convention
type: tdd
wave: 4
depends_on: [05, 12]
files_modified:
  - features/features/08-tooling/25-testing-harness.feature
  - features/step-definitions/TestingHarnessComposeSteps.ts
  - features/traceability.md
  - features/STYLE.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1550, REQ-EA-1551, REQ-EA-1552]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "REQ-EA-1550: an app served in a scenario's scope is released when the scenario ends (TestAuth.openApps() back to its pre-scenario value)"
    - "REQ-EA-1551: configuring a lazy app cell after its first request fails the step, and the failure names the World"
    - "REQ-EA-1552: a fetch over a real socket reaches the composition the scenario serves, and requests() lists it"
    - "features/STYLE.md states the World rule: one TestAuth.lazyApp cell per World, configure before the first request, no app outlives its scenario"
  artifacts:
    - path: features/features/08-tooling/25-testing-harness.feature
      provides: "Rule @BEH-EA-356 @BEH-EA-357 @BEH-EA-358 with three scenarios"
  key_links:
    - from: "@REQ-EA-1550..1552 scenarios"
      to: "BEH-EA-356..358 in spec/behaviors/25-testing-harness.md"
      via: "features/traceability.md rows"
---
Status: done (uncommitted)
Blocked by: 05, 12

<objective>
Make the three behaviours of PLAN §6.2 executable in the acceptance suite (PLAN §5.1 row for ticket 20, §6.4). They go under one new `Rule` after the BEH-EA-333 rule (`25-testing-harness.feature:268-290`). The steps reuse the step file ticket 12 already moved onto `serve`.

Purpose: the lifetime contract is acceptance-tested, not only unit-tested.

Output: three passing scenarios, their traceability rows, and the World-lifetime paragraph in `features/STYLE.md`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§3.2, §5.1, §6.2, §6.3, §6.4)
@features/features/08-tooling/25-testing-harness.feature (:268-290, the BEH-EA-333 rule to sit after)
@features/step-definitions/TestingHarnessComposeSteps.ts (after ticket 12)
@features/step-definitions/TestingHarnessComposeFixtures.ts (the small plugins to reuse; read only)
@features/traceability.md (:1344-1355, row format)
@features/STYLE.md (## File structure, ## What not to do)
@spec/traceability.md (:430, §6 row for file 25)
@features/scripts/allocate-req-ea.py (check how a hand-tagged REQ id is accepted before tagging)
</context>

<tasks>
<task type="tdd">
  <name>Task 1 (tracer): three scenarios, red then green</name>
  <files>features/features/08-tooling/25-testing-harness.feature, features/step-definitions/TestingHarnessComposeSteps.ts</files>
  <read_first>the feature file :260-300; TestingHarnessComposeSteps.ts; features/STYLE.md ## Tagging; allocate-req-ea.py (does it re-number hand-tagged ids? See Q in Comments)</read_first>
  <behavior>
    - REQ-EA-1550: Given a composition served through "TestAuth.serve" in the scenario's scope, When the scenario's scope closes, Then no test app is left open. The step reads `TestAuth.openApps()` before serving and compares after closing an inner `Effect.scoped`; it never asserts an absolute 0, because other Worlds of the run may be mid-scenario.
    - REQ-EA-1551: Given a World's app cell that has served a request, When the scenario configures the cell, Then the step fails naming the World. Assert on the defect message carrying `settings.name`, through `Effect.exit` so the scenario itself passes.
    - REQ-EA-1552: Given a composition served through "TestAuth.listen", When a client fetches "/session" over the socket, Then it is refused with 401 and the app's request log lists "GET /session".
  </behavior>
  <action>Add one `Rule` after the BEH-EA-333 rule, headed `# BEH-EA-356..358 — spec/behaviors/25-testing-harness.md (architecture plan 34)`. Tag it `@BEH-EA-356 @BEH-EA-357 @BEH-EA-358` and title it "A test app lives as long as the scope that serves it". Add three scenarios tagged `@REQ-EA-1550`, `@REQ-EA-1551` and `@REQ-EA-1552`, phrased in the domain voice of STYLE.md (no type names in Then lines beyond the harness entry points the existing rule already names).

Run them red first: the steps are undefined. Then add the step definitions to `TestingHarnessComposeSteps.ts` over the fixture plugins `TestingHarnessComposeFixtures.ts` already exports; no new fixture file. The 1552 step uses the real `fetch` against `listening.url`, and the socket closes with the scenario's scope.

Keep the existing step texts and the BEH-EA-333 rule title unchanged. Their anchor is cited by REQ-EA-1298/1333/1334 rows, and ticket 22 keeps the heading.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/25-testing-harness.feature</automated></verify>
  <acceptance_criteria>grep -c '@REQ-EA-155[012]' features/features/08-tooling/25-testing-harness.feature returns 3 (baseline at HEAD: 0); grep -c 'Scenario' on the same file returns 43 (baseline at HEAD: 40); the three scenarios pass and the 40 existing ones keep their outcome (26 wired, 10 pruned per spec/traceability.md:430).</acceptance_criteria>
  <done>REQ-EA-1550..1552 pass.</done>
</task>

<task type="auto">
  <name>Task 2: traceability rows and the World-lifetime convention</name>
  <files>features/traceability.md, spec/traceability.md, features/STYLE.md</files>
  <read_first>features/traceability.md :1340-1356; spec/traceability.md :430 and the Change History cell at :13; features/STYLE.md</read_first>
  <action>In `features/traceability.md`, add three rows in REQ order, in the format of `:1355`. They map REQ-EA-1550 to BEH-EA-356, 1551 to 357 and 1552 to 358, with the anchors as ticket 03/04/05 wrote the headings. Use the file `08-tooling/25-testing-harness.feature` and a one-line summary each.

In `spec/traceability.md:430`, add `356–358` to the BEH column, `1550–1552` to the REQ column, and raise the scenario counts by 3 (26 / 36 becomes 29 / 39 if all three are wired). Add one Change History entry: `1.78 (2026-11-…): §6 row for file 25 lists REQ-EA-1550..1552 (architecture plan 34 ticket 20)`. If another plan has taken 1.78 since, take the next free number.

In `features/STYLE.md`, add a short section `## World lifetime` before `## What not to do`. It says:
- a World that serves an `Auth.make` composition holds exactly one `TestAuth.lazyApp` cell, named after the World;
- every option is configured before the first request (a late `configure` is a defect naming the World);
- no app or SQL client outlives its scenario, and the leak guard (`shared/LeakGuard.ts`) checks this after every feature file;
- a scenario that needs a socket uses `TestAuth.listen`, never a hand-built server.

Keep it to six lines at most.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>grep -c 'REQ-EA-155[012]' features/traceability.md returns 3 (baseline at HEAD: 0); grep -c '^## World lifetime' features/STYLE.md returns 1 (baseline: 0); spec:verify:strict is clean.</acceptance_criteria>
  <done>The scenarios are traced and the convention is written down.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd && pnpm spec:verify:strict
</verification>

<success_criteria>
Three new scenarios pass; three traceability rows; the STYLE.md section; no existing scenario changes outcome.
</success_criteria>

## Comments
- Result: the Rule tags the shipped ids `@BEH-EA-351 @BEH-EA-352 @BEH-EA-353` (the plan said 356-358); `allocate-req-ea.py` maps all three scenarios to the first tag (BEH-EA-351). Steps live in `TestingHarnessComposeSteps.ts`; feature file passes (47 tests), leak guard 0/0. Scenario counts 29 / 39 in `spec/traceability.md`. `## World lifetime` added to `features/STYLE.md`.
