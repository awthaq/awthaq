---
plan: 40-residue
ticket: 21
title: "Red: the loader hands the three missed link errors over as ConfigUnavailable"
type: tdd
wave: 0
depends_on: []
files_modified:
  - packages/cli/test/ConfigLoader.test.ts
  - packages/cli/test/fixtures/user-field-invalid.config.ts
  - packages/cli/test/fixtures/conflicting-depends-on.config.ts
  - packages/cli/test/fixtures/sealed-column-invalid.config.ts
autonomous: true
requirements: [REQ-EA-1616]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Three fixtures each raise one missed link error while the module is evaluated"
    - "Three loader cases assert LinkProblem with code UserFields/InvalidDeclaration, ConflictingDependsOn, SealedColumn/InvalidDeclaration; they fail at HEAD with ConfigUnavailable"
  artifacts:
    - path: packages/cli/test/ConfigLoader.test.ts
      provides: "three red cases"
  key_links:
    - from: packages/cli/test/ConfigLoader.test.ts
      to: packages/cli/src/Config.ts
      via: "load(fixture) → asLoadFailure"
      pattern: "load\\(\"(user-field-invalid|conflicting-depends-on|sealed-column-invalid)\\.config\\.ts\"\\)"
---
Status: ready-for-agent
Blocked by: none

<objective>
Reproduce C-F1 (PLAN §2.C.4): `doctor` and every command misclassify three link errors.
Purpose: the red half of Part C. Plan 29 F4 fixed five misses by hand; these three are the next ones.
Output: three fixtures, three failing loader cases. Committed together with ticket 22 so the tree is never red (or in the same PR, test commit first).
</objective>

<context>
@packages/cli/test/ConfigLoader.test.ts (:40-80, the RouteConflict and EventTagConflict cases to copy)
@packages/cli/test/fixtures/event-conflict.config.ts (fixture shape)
@packages/core/src/UserFields.ts (:140-170 describe: a field name that is not `<letters/digits>` fails)
@packages/core/src/AuthPlugin.ts (:860-885 ConflictingDependsOn: a second AuthPlugin.layer for the same class with a different dependsOn)
@packages/sql/src/SealedColumn.ts (:55-70 validated: a non-identifier table fails)
@.planning/40-residue/PLAN.md §2.C
</context>

<tasks>
  <task type="auto">
    <name>Task 1: fixtures</name>
    <files>packages/cli/test/fixtures/user-field-invalid.config.ts, packages/cli/test/fixtures/conflicting-depends-on.config.ts, packages/cli/test/fixtures/sealed-column-invalid.config.ts</files>
    <read_first>packages/cli/test/fixtures/event-conflict.config.ts; packages/core/test/AuthPlugin.test.ts (how ConflictingDependsOn and userFields errors are provoked today)</read_first>
    <action>Each fixture has a two-line header comment (what it declares, and that the loader must hand it over as a `LinkProblem` that `doctor` reports) and default-exports `Auth.make([...])` over one minimal plugin, modelled on event-conflict.config.ts. user-field-invalid: the plugin declares `userFields: { "bad-name": Schema.String }` (a hyphen fails `FIELD_NAME`). conflicting-depends-on: two `AuthPlugin.layer(Plugin, …)` calls for one class with different `dependsOn` (the second throws at registration). sealed-column-invalid: `SealedColumn.column({ table: "not an identifier", column: "x", key: "id" }, …)` (or the exact public constructor `SealedColumn.ts` exports; check its signature) at module top level. Do not import from `../../src`; import the packages as a host would.</action>
    <verify><automated>for f in user-field-invalid conflicting-depends-on sealed-column-invalid; do test -f packages/cli/test/fixtures/$f.config.ts || echo missing $f; done</automated></verify>
    <done>Three fixtures.</done>
  </task>
  <task type="tdd">
    <name>Task 2: red loader cases</name>
    <files>packages/cli/test/ConfigLoader.test.ts</files>
    <read_first>packages/cli/test/ConfigLoader.test.ts:50-80</read_first>
    <behavior>
      - load("user-field-invalid.config.ts") fails with _tag "LinkProblem", code "UserFields/InvalidDeclaration", message includes "bad-name".
      - load("conflicting-depends-on.config.ts") fails with LinkProblem, code "ConflictingDependsOn".
      - load("sealed-column-invalid.config.ts") fails with LinkProblem, code "SealedColumn/InvalidDeclaration".
    </behavior>
    <action>Add the three `it.effect` cases after the EventTagConflict case, named "hands a <tag> raised where a plugin is defined over as a LinkProblem". Run them: each fails with `_tag` "ConfigUnavailable" at HEAD (the red evidence; paste the three failure lines into Comments).</action>
    <verify><automated>npx vitest run packages/cli/test/ConfigLoader.test.ts 2>&1 | grep -E 'Tests|ConfigUnavailable' | head -5   # expect 3 failed</automated></verify>
    <acceptance_criteria>Exactly 3 failures at HEAD, all `ConfigUnavailable` (baseline: 9 passing cases, 0 failing).</acceptance_criteria>
    <done>Red evidence recorded; commit with ticket 22.</done>
  </task>
</tasks>

<verification>npx vitest run packages/cli/test/ConfigLoader.test.ts (red by design until 22)</verification>

<success_criteria>3 red cases reproduce C-F1.</success_criteria>

## Comments
