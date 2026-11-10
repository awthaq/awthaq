---
plan: 37-store-contract-runner
ticket: 03
title: BEH-EA-336 revision and docs for ticket 02
type: execute
wave: 1
depends_on: [02]
files_modified:
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - docs/plugin-authoring.md
  - packages/test/README.md
  - .changeset/test-pg-every-suite.md
autonomous: true
requirements: [REQ-EA-1586]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No doc or spec tells a plugin author to list a file in scripts/test-pg.sh"
    - "BEH-EA-336 states that pnpm test:pg runs every suite and that the check refuses a list"
    - "spec/traceability.md §6's file-25 crosswalk names REQ-EA-1580–1581"
  artifacts:
    - path: "spec/behaviors/25-testing-harness.md"
      provides: "BEH-EA-336 revised; Document Control 1.11"
    - path: ".changeset/test-pg-every-suite.md"
      provides: "empty changeset (scripts, spec and docs only)"
  key_links:
    - from: "spec/traceability.md"
      to: "features/features/08-tooling/25-testing-harness.feature"
      via: "§6 crosswalk row for 08-tooling/25-testing-harness.feature"
      pattern: "REQ-EA-158[01]"
---
Status: ready-for-agent
Blocked by: 02

<objective>
Ticket 02 removed the list and changed rule 3. The spec and the plugin-author docs still say to list a records-passing `Contract.test.ts` in `scripts/test-pg.sh`.

Purpose: make every description match the script.

Output: BEH-EA-336 revised, two doc sentences, the test README sentence, traceability rows, and an empty changeset.
</objective>

<context>
@.planning/37-store-contract-runner/PLAN.md (§6.2 BEH-EA-336 row, §6.3, §6.5)
@spec/behaviors/25-testing-harness.md (Document Control at the top; BEH-EA-336 at ~273-288)
@spec/traceability.md (Document Control line 13; §6 rows for REQ-EA-1500/1501)
@docs/plugin-authoring.md (lines 271 and 286)
@packages/test/README.md (line 8)
@.changeset/adr-041-decision-9.md (empty-front-matter format)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: BEH-EA-336 and traceability</name>
    <files>spec/behaviors/25-testing-harness.md, spec/traceability.md</files>
    <read_first>spec/behaviors/25-testing-harness.md lines 1-15 and 273-290; spec/traceability.md line 13 (change history format) and every line containing REQ-EA-1500 or test-pg</read_first>
    <action>In BEH-EA-336, replace the sentence "`pnpm check:contract-tests` fails when a `Contract.test.ts` that passes `records` is missing from `scripts/test-pg.sh`" with: `pnpm test:pg` runs every vitest project and the BDD suite against `AWTHAQ_POSTGRES_URL`, the set CI's `pnpm check` runs, and `pnpm check:contract-tests` fails when `scripts/test-pg.sh` names a test file (a hand-kept list had drifted: plan 37 measured 9 files it missed). Bump Document Control to revision 1.11 and add a change-history entry: "1.11 (2026-11-xx): BEH-EA-336: `pnpm test:pg` runs every suite; the check refuses a hand-kept list (architecture plan 37 tickets 02–03)". In spec/traceability.md §6, the crosswalk row for `08-tooling/25-testing-harness.feature` (line ~430) has a REQ-EA cell reading "545–572, 699, 1325, 1332–1333". It names neither 1500/1501 nor the other plan-25/08 ids. Add "1580–1581" to that cell, and leave its count columns to what `pnpm spec:verify:strict` accepts. Fix any other row that says a file is "listed in `scripts/test-pg.sh`" (for example the ADR-EA-041 decision-9 cell, which ends "listed in `scripts/test-pg.sh`") so it says the file runs on Postgres under `pnpm test:pg`. Bump to 1.78 with a change-history entry.</action>
    <verify><automated>pnpm spec:verify:strict &amp;&amp; grep -q '1580–1581' spec/traceability.md &amp;&amp; ! grep -n 'listed in `scripts/test-pg.sh`' spec/traceability.md spec/behaviors/25-testing-harness.md</automated></verify>
    <acceptance_criteria>Baseline at HEAD: `grep -c 'listed in `scripts/test-pg.sh`' spec/traceability.md` is 1, and `grep -c '1580–1581' spec/traceability.md` is 0. After: 0 and 1. spec:verify:strict passes.</acceptance_criteria>
    <done>The spec states the new rule.</done>
  </task>

  <task type="auto">
    <name>Task 2: plugin-author docs, test README, changeset</name>
    <files>docs/plugin-authoring.md, packages/test/README.md, .changeset/test-pg-every-suite.md</files>
    <read_first>docs/plugin-authoring.md lines 265-290; packages/test/README.md line 8</read_first>
    <action>In docs/plugin-authoring.md:271, replace the instruction to list the Contract.test.ts in scripts/test-pg.sh (and the parenthetical about check:contract-tests failing on an unlisted file) with this: `pnpm test:pg` runs every suite against Postgres, as CI does, so a records-passing `Contract.test.ts` runs there with nothing to add. Make the same change in checklist item 6 (:286), which ends with "the file listed in `scripts/test-pg.sh`", and in packages/test/README.md:8. Add .changeset/test-pg-every-suite.md with empty front matter (two lines of three dashes) and one sentence: pnpm test:pg runs every suite, and the check refuses a hand-kept list (plan 37; scripts, spec and docs only).</action>
    <verify><automated>pnpm check:readmes &amp;&amp; ! grep -rn 'test-pg.sh' docs/plugin-authoring.md packages/test/README.md</automated></verify>
    <acceptance_criteria>Baseline: `grep -c 'test-pg.sh' docs/plugin-authoring.md` is 2 and `packages/test/README.md` is 1. After: 0 and 0. check:readmes passes.</acceptance_criteria>
    <done>No doc asks for a list.</done>
  </task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm spec:verify:strict && pnpm check:readmes
</verification>

<success_criteria>
- `test-pg.sh` mentions in docs and the test README: 3 → 0.
- "listed in `scripts/test-pg.sh`" in spec/traceability.md: 1 → 0; the file-25 crosswalk cell names 1580–1581.
- `pnpm spec:verify:strict` passes.
</success_criteria>

## Comments
