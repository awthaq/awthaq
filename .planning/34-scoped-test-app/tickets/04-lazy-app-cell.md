---
plan: 34-scoped-test-app
ticket: 04
title: "`TestAuth.lazyApp`: one World app cell"
type: tdd
wave: 2
depends_on: [03]
files_modified:
  - packages/test/src/TestAuth.ts
  - packages/test/test/TestAuthLazy.test.ts
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - .changeset/test-scoped-app.md
autonomous: true
requirements: [REQ-EA-1551]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "get builds at most once (also under two concurrent first gets) from the options accumulated by configure"
    - "configure after the build is a defect whose message names settings.name"
    - "replace releases the built value's child scope before the next get builds again"
    - "closing the scope the cell was created in releases what it built"
    - "alignStepClock sets the caller's TestClock to the wall clock before the first build; without it the caller's clock is untouched"
  artifacts:
    - path: packages/test/src/TestAuth.ts
      provides: "LazyApp<O, R>, lazyApp"
    - path: packages/test/test/TestAuthLazy.test.ts
  key_links:
    - from: "lazyApp (created in a World layer)"
      to: "child scope per build"
      via: "Effect.scope captured at creation; Scope.fork + Scope.provide in get; Scope.close in replace"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Ship the one app cell every World uses (PLAN §3.2 `LazyApp`, BEH-EA-357). It replaces eleven hand-written `Ref` cells and five configure rules (PLAN §2.3 F3) with one rule: configure before the first build, or `replace` explicitly. It also replaces the hand clock alignment (F4) with `alignStepClock`.

Purpose: Worlds stop owning lifetime and ordering logic; the cell owns it.

Output: `lazyApp` plus its test, BEH-EA-357, and the changeset extended.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.3, §2.7, §3.2 lazyApp notes, §6.2 BEH-EA-357)
@packages/test/src/TestAuth.ts (serve from ticket 03)
@features/step-definitions/DeviceAuthorizationWorld.ts (:160-186, the configure guard and the clock alignment being replaced)
@node_modules/.pnpm/effect@4.1.2/node_modules/effect/dist/Scope.d.ts (fork :493, provide :313, close :574)
@node_modules/.pnpm/effect@4.1.2/node_modules/effect/src/testing/TestClock.ts (setTime :670, testClockWith :593)
</context>

<tasks>
<task type="tdd">
  <name>Task 1 (tracer): a cell that builds once over serve and releases with its scope</name>
  <files>packages/test/test/TestAuthLazy.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>packages/test/src/TestAuth.ts (serve), packages/test/test/TestAuthLifetime.test.ts</read_first>
  <behavior>
    - A cell whose build calls TestAuth.serve(TestAuth.layer(Auth.make([Pins]))) and counts its runs in a Ref: two gets → build ran once and both gets return the same app; after the it.effect's scope closes, TestAuth.openApps() is back.
    - Two concurrent first gets (Effect.all with concurrency "unbounded") → build ran once.
    - configure(update) twice before get → build receives both updates applied in order.
  </behavior>
  <action>Write the cases first. Implement `lazyApp(initial, build, settings)` as an Effect that requires `Scope`.

It reads the parent with `Effect.scope`. It holds `{ options, built: Option<{ value, scope }> }` in a `SynchronizedRef`.

- **`get`** uses `SynchronizedRef.modifyEffect`. When nothing is built, it forks a child with `Scope.fork(parent, "sequential")`, runs `build(options)` under `Scope.provide(child)`, and stores both. Otherwise it returns the stored value.
- **`options`** reads the state.
- **`configure(update)`** applies `update` while unbuilt (it is defined in Task 2 for the built case).
- **`replace(options)`** closes the stored child (`Scope.close(child, Exit.void)`) if any, then stores the new options unbuilt.

`build`'s type is `(options: O) => Effect.Effect<R, never, Scope.Scope>`. No `as`; no return-type annotations. Export the `LazyApp<O, R>` interface exactly as in PLAN §3.2.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthLazy.test.ts</automated></verify>
  <acceptance_criteria>grep -c '^export const lazyApp = ' packages/test/src/TestAuth.ts returns 1 (baseline at HEAD: 0).</acceptance_criteria>
  <done>The cell builds once, concurrently safe, and its scope owns the build.</done>
</task>

<task type="tdd">
  <name>Task 2: the configure rule, replace and alignStepClock</name>
  <files>packages/test/test/TestAuthLazy.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>packages/test/src/TestAuth.ts (lazyApp from Task 1)</read_first>
  <behavior>
    - get, then configure → Effect.exit is a defect (Cause.hasDies) whose Error message contains settings.name ("ExampleWorld") and the word "replace".
    - get, then replace(o2) → openApps() drops by one; the next get builds again and build received o2.
    - With alignStepClock true, inside it.effect: Clock.currentTimeMillis after get is within 60 000 ms of Date.now(); with it absent, it is still 0.
  </behavior>
  <action>Make `configure` on a built state fail with `Effect.die(new Error(...))`. The message is `${name}: configure after the app was built; configure in a Given before the first request, or call replace`. `name` defaults to `"TestAuth.lazyApp"`.

With `settings.alignStepClock === true`, the first-build branch of `get` runs `TestClock.setTime(Date.now())` on the caller's fiber before `build`, once per build. Do not align when the option is absent.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthLazy.test.ts</automated></verify>
  <acceptance_criteria>All six cases pass; grep -c 'alignStepClock' packages/test/src/TestAuth.ts ≥ 2 (baseline: 0).</acceptance_criteria>
  <done>One configure rule, one explicit rebuild, one opt-in clock alignment.</done>
</task>

<task type="auto">
  <name>Task 3: BEH-EA-357, traceability, changeset</name>
  <files>spec/behaviors/25-testing-harness.md, spec/traceability.md, .changeset/test-scoped-app.md</files>
  <read_first>spec/behaviors/25-testing-harness.md (BEH-EA-356 from ticket 03), .planning/34-scoped-test-app/PLAN.md §6.2</read_first>
  <action>Add `## BEH-EA-357: A World holds one lazy app cell` after BEH-EA-356. Use the REQUIREMENT verbatim from PLAN §6.2, a short `ts` example of a World layer creating `TestAuth.lazyApp(initial, (o) => TestAuth.serve(layerFor(o)), { name: "SessionWorld" })`, and an *Implementation* line naming `test/TestAuthLazy.test.ts`. Fix the navigation links.

Bump to revision 1.12 with a change-history line citing architecture plan 34. In `spec/traceability.md`, add BEH-EA-357 to the file-25 row and the URS-EA-009 crosswalk, add a §5 row for `TestAuthLazy.test.ts`, and add a change-history line. Add `lazyApp` to the summary in `.changeset/test-scoped-app.md`.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>grep -c '^## BEH-EA-357' spec/behaviors/25-testing-harness.md returns 1 (baseline: 0).</acceptance_criteria>
  <done>Specified and traced.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm spec:verify:strict
</verification>

<success_criteria>
`TestAuthLazy.test.ts` has 6 green cases; BEH-EA-357 specified; nothing else changed.
</success_criteria>

## Comments
