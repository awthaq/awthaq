---
plan: 35-test-mailbox
ticket: 19
title: "ADR-EA-054, BEH-EA-359, traceability"
type: execute
wave: 6
depends_on: [14, 17]
files_modified:
  - spec/decisions/054-test-observation-off-the-ports.md
  - spec/decisions/index.yaml
  - spec/behaviors/25-testing-harness.md
  - spec/behaviors/26-cli.md
  - spec/traceability.md
autonomous: true
requirements: [REQ-EA-1560, REQ-EA-1561, REQ-EA-1562]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "ADR-EA-054 is Accepted — implemented and indexed"
    - "BEH-EA-359 exists in 25-testing-harness.md with its REQUIREMENT and Implementation lines"
    - "BEH-EA-193/195 and 26-cli no longer name Mailer.layerMemory"
    - "pnpm spec:verify:strict passes"
  artifacts:
    - path: spec/decisions/054-test-observation-off-the-ports.md
      provides: "ADR-EA-054 (PLAN.md §6.1 draft)"
  key_links:
    - from: spec/traceability.md
      to: spec/decisions/054-test-observation-off-the-ports.md
      via: "§4 ADR row"
      pattern: "ADR-EA-054"
---
Status: done (uncommitted)
Blocked by: 14, 17

<objective>
Record the decision and the behaviour: write ADR-EA-054 from the PLAN.md §6.1 draft, add BEH-EA-359, revise BEH-EA-193/195 and 26-cli, and trace them.

Purpose: PLAN.md §6.1–§6.3; Q1's default (a new ADR). If Q1 was answered "revise ADR-EA-010", write ADR-EA-010 revision 1.5 instead of the new file and leave the index unchanged (PLAN.md §10).
Output: five spec files.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§6.1, §6.2, §6.3, §10 Q1)
@spec/decisions/049-plugins-own-event-definitions.md (format)
@spec/decisions/index.yaml
@spec/behaviors/25-testing-harness.md:1-30,60-80
@spec/behaviors/26-cli.md:1-15,40-46
@spec/traceability.md:1-15,255-265
</context>

<tasks>
<task type="auto">
  <name>Task 1: the ADR and its index entry</name>
  <files>spec/decisions/054-test-observation-off-the-ports.md, spec/decisions/index.yaml</files>
  <action>First check the ids: `ls spec/decisions` and `git grep -n 'ADR-EA-05[0-9]' -- spec` must show no other ADR-EA-054 (plans 31–40 may have added 050–053). Write `054-test-observation-off-the-ports.md` in the format of `049-…` (Document Control table, Context, Decision, Alternatives considered, Consequences, Related) from PLAN.md §6.1, status "Accepted — implemented". Append its entry to `index.yaml` in id order with the title "A Port's Interface Carries Only What a Production Adapter Implements; Test Observation Lives in `@awthaq/test`".</action>
  <verify><automated>pnpm spec:verify</automated></verify>
  <acceptance_criteria>`git grep -c 'ADR-EA-054' -- spec/decisions/index.yaml` prints 1 (baseline 0).</acceptance_criteria>
  <done>The decision is recorded.</done>
</task>

<task type="auto">
  <name>Task 2: behaviours and traceability</name>
  <files>spec/behaviors/25-testing-harness.md, spec/behaviors/26-cli.md, spec/traceability.md</files>
  <action>`25-testing-harness.md` to revision 1.11 (change history entry citing plan 35 and ADR-EA-054): add BEH-EA-359 as drafted in PLAN.md §6.2 (title, example, REQUIREMENT, *Implementation* with `packages/test/src/TestMailbox.ts`, `packages/test/test/TestMailbox.test.ts`, `TestAuthApp.test.ts`, BDD REQ-EA-1560..1562), placed after the highest-numbered entry in the file. BEH-EA-193: the code comment at `:20` and the REQUIREMENT at `:25` say `TestMailbox.layer` instead of `Mailer.layerMemory`; add an *As shipped (plan 35)* note that the output also holds `SmsSender` and `TestMailbox.Mailbox`. BEH-EA-195: the example becomes `Layer.mock(RateLimiter.RateLimiter)({ consume })`; say `Mailer` has one member since ADR-EA-054; `:75`'s "lighter-weight alternative to `Mailer.layerMemory`" names `TestMailbox`. `26-cli.md:44` (revision bump): "a `Mailer.layerMemory` left in production" becomes "a development `Mailer` (`layerNoop`, `layerConsole`, a test mailbox) left in production". `spec/traceability.md` to revision 1.78: §1 row for file 25 adds BEH-EA-359; §4 adds the ADR-EA-054 row (tests: `packages/test/test/TestMailbox.test.ts`, `packages/ports/test/Mailer.test.ts`, `packages/ports/test/SmsSender.test.ts`); §5 rewrites the `Mailer.test.ts` row at `:263` (no read-back; `layerNoop` dies; `layerConsole` logs and keeps nothing) and adds a `TestMailbox.test.ts` row; §6 row for file 25 lists REQ-EA-1560..1562. Re-read each revision number before bumping: another batch-4 plan may have bumped it first.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>Passes. `git grep -nE 'Mailer\.layerMemory|SmsSender\.layerMemory' -- spec | wc -l` prints 0 (baseline at 04fa3526: 4, in `25-testing-harness.md` ×3 and `26-cli.md` ×1). `git grep -c 'BEH-EA-359' -- spec/behaviors/25-testing-harness.md` prints at least 1 (baseline 0). M7: `git grep -nE '(Mailer|SmsSender)\.layerMemory' -- packages features examples docs README.md spec | wc -l` prints 0 (baseline 43).</acceptance_criteria>
  <done>The spec, ADR and traceability match the code.</done>
</task>
</tasks>

<verification>
pnpm check && pnpm spec:verify:strict
</verification>

<success_criteria>
ADR-EA-054 indexed; BEH-EA-359 traced to code and REQ-EA-1560..1562; M7 43 → 0; `pnpm check` green.
</success_criteria>

## Comments
- Result: ADR-EA-054 (ids 050-053 are unused; the index has a gap), BEH-EA-354, 25-testing-harness 1.13, 26-cli bump, spec/traceability 1.81, spec/README 1.19; spec:verify:strict 32/32.
