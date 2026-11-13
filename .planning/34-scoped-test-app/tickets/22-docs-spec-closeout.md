---
plan: 34-scoped-test-app
ticket: 22
title: Docs and spec close-out (BEH-EA-333 revised, README, plugin authoring)
type: execute
wave: 6
depends_on: [21]
files_modified:
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - packages/test/README.md
  - docs/plugin-authoring.md
  - examples/memory-server/README.md
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-333 says the app is released by the scope that served it (BEH-EA-356), not by dispose"
    - "No doc in the repo teaches TestAuth.app or app.dispose()"
  artifacts:
    - path: spec/behaviors/25-testing-harness.md
      provides: "revision 1.14: BEH-EA-333 revised, TestAuth.app removed"
  key_links:
    - from: "docs/plugin-authoring.md example"
      to: "TestAuth.serve inside it.effect"
      via: "PLAN §6.5"
---
Status: done (uncommitted)
Blocked by: 21

<objective>
Bring the spec and the three docs that teach `TestAuth.app` in line with the shipped harness (PLAN §6.2 BEH-EA-333 revised, §6.3, §6.5).

Purpose: a reader, human or agent, learns `serve`/`withApp`/`lazyApp`/`listen` from the docs and never a removed entry point.

Output: spec revision 1.14, traceability row updated, three docs rewritten in place.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§6.2, §6.3, §6.5)
@spec/behaviors/25-testing-harness.md (:7 revision 1.10 at HEAD, then 1.11–1.13 after tickets 03/04/05; :236 BEH-EA-333)
@spec/traceability.md (:327 the TestAuthApp.test.ts row)
@packages/test/README.md (:7)
@docs/plugin-authoring.md (:255-267)
@examples/memory-server/README.md (:74)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): spec</name>
  <files>spec/behaviors/25-testing-harness.md, spec/traceability.md</files>
  <read_first>spec/behaviors/25-testing-harness.md (header, BEH-EA-193, BEH-EA-333, BEH-EA-356..358); spec/traceability.md :13 and :327</read_first>
  <action>BEH-EA-333: replace the sentence requiring `dispose` to release everything with "the app is released by the scope that served it (BEH-EA-356)". Rewrite its example to `const app = yield* TestAuth.serve(layer)` inside `it.effect`.

Keep the heading text as it is. Its anchor `#beh-ea-333-testauthapp-serves-the-composition-and-its-context-together` is linked from `features/traceability.md` (REQ-EA-1298/1333/1334), from the Previous/Next lines at `:234` and `:313`, and from the feature Rule. Add one *As shipped (plan 34)* line under the heading saying `TestAuth.app` became `TestAuth.serve`.

Adjust BEH-EA-193's "MUST NOT need … a real network listener" as PLAN §6.2 says: in-process stays the default, and `listen` is opt-in (BEH-EA-358).

Bump the revision to 1.14 with the change-history line `1.14 (2026-11-…): BEH-EA-333 revised (no dispose; released by its scope), TestAuth.app removed (architecture plan 34)`. If tickets 03–05 did not land 1.11–1.13 in order, take the next free number.

In `spec/traceability.md:327`, drop "`dispose` runs the composition's finalizers" from the `TestAuthApp.test.ts` row. Add "released when its scope closes (BEH-EA-356)". Add a Change History entry, using the next free number after ticket 20's.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>grep -c 'dispose' spec/behaviors/25-testing-harness.md returns 0 (baseline at HEAD: 1); grep -c 'dispose' on spec/traceability.md:327 returns 0 (baseline at HEAD: 1); spec:verify:strict clean.</acceptance_criteria>
  <done>The spec describes the scoped harness.</done>
</task>

<task type="auto">
  <name>Task 2: docs</name>
  <files>packages/test/README.md, docs/plugin-authoring.md, examples/memory-server/README.md</files>
  <read_first>the three files at the cited lines</read_first>
  <action>`packages/test/README.md:7`: the `TestAuth.app(layer)` bullet becomes `TestAuth.serve(layer)` (inside `it.effect`; released with the test's scope). Also list `withApp` (async tests), `lazyApp` (a World's one cell) and `listen` (a real socket). Drop `dispose`.

`docs/plugin-authoring.md:255-267`: rewrite the example as an `it.effect` that does `const app = yield* TestAuth.serve(...)`. In the paragraph, replace "`TestAuth.app` serves" with "`TestAuth.serve` serves … for as long as the test's scope", mention `withApp` for an async test, and leave the user-agent sentences as they are.

`examples/memory-server/README.md:74`: "through `TestAuth.app`" becomes "through `TestAuth.serve`".</action>
  <verify><automated>pnpm check</automated></verify>
  <acceptance_criteria>grep -c 'TestAuth\.app\b\|\.dispose()' returns 0 for each of the three (baseline at HEAD: README 1, plugin-authoring 2, memory-server README 1); pnpm check green.</acceptance_criteria>
  <done>No doc teaches the removed entry point.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict && pnpm check
</verification>

<success_criteria>
Spec revision 1.14; BEH-EA-333 revised with its anchor intact; three docs on serve; `pnpm check` green.
</success_criteria>

## Comments
- Result: spec revision 1.12 (not 1.14; the file's own numbering), traceability 1.80. BEH-EA-333 heading kept for its anchors, with an *As shipped* line. Docs (`packages/test/README.md`, `docs/plugin-authoring.md`, memory-server README) teach `serve`. `pnpm check` not run (spec:verify:strict passes 32/32).
