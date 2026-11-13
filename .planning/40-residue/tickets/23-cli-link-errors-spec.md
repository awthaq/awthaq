---
plan: 40-residue
ticket: 23
title: "BEH-EA-201 implementation note, traceability, changeset"
type: execute
wave: 0
depends_on: [22]
files_modified:
  - spec/behaviors/26-cli.md
  - spec/traceability.md
  - .changeset/cli-link-errors.md
autonomous: true
requirements: [REQ-EA-1616]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-201 says the loader classifies link problems with core's Auth.isLinkError and keeps no list"
    - "spec/traceability.md maps packages/core/test/LinkErrors.test.ts to BEH-EA-201"
    - "A changeset with a Migration line names the doctor exit-code change for the three misconfigurations"
  artifacts:
    - path: .changeset/cli-link-errors.md
      provides: "@awthaq/core minor, @awthaq/cli patch, @awthaq/api patch (Q8)"
  key_links:
    - from: spec/traceability.md
      to: packages/core/test/LinkErrors.test.ts
      via: "test-file row"
      pattern: "LinkErrors\\.test\\.ts"
---
Status: done (uncommitted)
Blocked by: 22

<objective>
Write Part C down. Purpose: spec and changeset convention. Output: BEH-EA-201 rev 1.7, traceability row, changeset.
No BDD change: the CLI BDD world runs `Cli.run` over `Config.layerFixed` (`features/step-definitions/CliWorld.ts:309`, `:377-385`) and never evaluates a configuration module, so the loader's classification is unreachable there; `ConfigLoader.test.ts` is the right level, and the existing scenario REQ-EA-573 keeps its meaning.
</objective>

<context>
@spec/behaviors/26-cli.md (:1-15 document control, :17-75 BEH-EA-201)
@spec/traceability.md (:337 the Doctor.test.ts row)
@.changeset/adr-041-decision-9.md (format)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: BEH-EA-201 and traceability</name>
    <files>spec/behaviors/26-cli.md, spec/traceability.md</files>
    <read_first>the ranges in context</read_first>
    <action>26-cli.md: Revision 1.7; change history `1.7 (<today>): BEH-EA-201 Implementation: the loader classifies a link problem with core's Auth.isLinkError, which covers refusals raised where a plugin, a user field or a sealed column is declared (architecture plan 40)`; add that sentence to BEH-EA-201's *Implementation* text (do not touch the REQUIREMENT block). traceability.md: add a row `packages/core/test/LinkErrors.test.ts` → BEH-EA-201 ("every link error is recognised; a new one cannot be added without the guard") and extend the ConfigLoader row if one exists; bump the document revision and change history.</action>
    <verify><automated>pnpm spec:verify:strict</automated></verify>
    <done>Spec current.</done>
  </task>
  <task type="auto">
    <name>Task 2: changeset</name>
    <files>.changeset/cli-link-errors.md</files>
    <read_first>.changeset/adr-041-decision-9.md</read_first>
    <action>`"@awthaq/core": minor` (Auth.LinkError, Auth.linkErrorTags, Auth.isLinkError), `"@awthaq/cli": patch`, `"@awthaq/api": patch` (only if ticket 22 task 3 ran: SessionLifecycle.Conflict). Body: `awthaq doctor` now reports an invalid user field, a conflicting dependsOn and an invalid sealed column (and an endpoint with two session lifecycles) as link-<code> findings. `Migration: a script that matched exit 9 from doctor for these misconfigurations now sees exit 3 and a link-<code> finding; other commands still exit 9, with the error tag LinkProblem instead of ConfigUnavailable.`</action>
    <verify><automated>grep -c '^Migration:' .changeset/cli-link-errors.md</automated></verify>
    <done>Changeset present.</done>
  </task>
</tasks>

<verification>pnpm check</verification>

<success_criteria>`pnpm check` green with Part C complete.</success_criteria>

## Comments
Done. 26-cli.md was at 1.8, so BEH-EA-201 Implementation note went in as rev 1.9 (not 1.7). traceability.md bumped from its current revision (LinkErrors.test.ts row added, ConfigLoader row extended). Changeset .changeset/cli-link-errors.md (core minor, cli patch, api patch; Migration line).
