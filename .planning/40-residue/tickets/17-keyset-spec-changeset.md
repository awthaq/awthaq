---
plan: 40-residue
ticket: 17
title: "Keyset: BEH-EA-036 implementation note, traceability, changeset (gate GO only)"
type: execute
wave: 4
depends_on: [15, 16]
files_modified:
  - spec/behaviors/05-persistence-stratum.md
  - spec/traceability.md
  - .changeset/keyset-module.md
autonomous: true
requirements: [REQ-EA-1615]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-036 names Keyset as the one place the order, predicate, page and limit rule live"
    - "spec/traceability.md maps packages/ports/test/Keyset.test.ts to BEH-EA-036"
  artifacts:
    - path: .changeset/keyset-module.md
      provides: "@awthaq/ports minor, Migration: none"
  key_links:
    - from: spec/traceability.md
      to: packages/ports/test/Keyset.test.ts
      via: "test-file row"
      pattern: "Keyset\\.test\\.ts"
---
Status: ready-for-human
Blocked by: 15, 16 (and the Part B gate)

<objective>
Write down the module. Purpose: replace-don't-layer applies to the spec too. Output: BEH-EA-036 *Implementation* note, traceability row, changeset.
</objective>

<context>
@spec/behaviors/05-persistence-stratum.md (BEH-EA-036, ticket 13's note)
@spec/traceability.md (test-file table near :337)
</context>

<tasks>
  <task type="auto">
    <name>Task 1: spec and traceability</name>
    <files>spec/behaviors/05-persistence-stratum.md, spec/traceability.md</files>
    <read_first>the BEH-EA-036 section; spec/traceability.md test-file rows</read_first>
    <action>Revision bump + change history. BEH-EA-036 *Implementation*: `Keyset` (`@awthaq/ports`) holds the order, the follows predicate, the SQL fragment and ORDER BY, the page assembly, the limit rule and the cursor codec; users, organizations and impersonation episodes use it. Add a traceability row for `packages/ports/test/Keyset.test.ts` → BEH-EA-036.</action>
    <verify><automated>pnpm spec:verify:strict</automated></verify>
    <done>Spec current.</done>
  </task>
  <task type="auto">
    <name>Task 2: changeset</name>
    <files>.changeset/keyset-module.md</files>
    <read_first>.changeset/adr-041-decision-9.md</read_first>
    <action>`"@awthaq/ports": minor`, `"@awthaq/sql"`, `"@awthaq/core"`, `"@awthaq/admin"`, `"@awthaq/organization"`: patch. Body: new `Keyset` export; no wire change (cursor bytes identical). `Migration: none.`</action>
    <verify><automated>grep -c '^Migration:' .changeset/keyset-module.md</automated></verify>
    <done>Changeset present.</done>
  </task>
</tasks>

<verification>pnpm check && pnpm test:pg</verification>

<success_criteria>`pnpm check` green.</success_criteria>

## Comments
