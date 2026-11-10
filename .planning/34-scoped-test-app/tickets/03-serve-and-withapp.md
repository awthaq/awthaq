---
plan: 34-scoped-test-app
ticket: 03
title: "`TestAuth.serve` and `TestAuth.withApp`; `TestAuth.app` becomes an adapter"
type: tdd
wave: 1
depends_on: [01]
files_modified:
  - packages/test/src/TestAuth.ts
  - packages/test/test/TestAuthLifetime.test.ts
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - .changeset/test-scoped-app.md
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "An app acquired with TestAuth.serve is released when the acquiring scope closes, after success, failure or interruption"
    - "withApp releases the app when its callback resolves or rejects, and the rejection reaches the caller unchanged"
    - "The composition builds on the wall clock even when serve is called under it.effect's TestClock"
    - "testClock: 'now' serves one TestClock that starts at the wall clock"
    - "TestAuth.app still compiles and behaves as before (adapter over serve), so no caller changes in this ticket"
  artifacts:
    - path: packages/test/src/TestAuth.ts
      provides: "ServeOptions, serve, withApp; App without dispose; app = adapter returning App & { dispose }"
    - path: packages/test/test/TestAuthLifetime.test.ts
    - path: .changeset/test-scoped-app.md
  key_links:
    - from: "TestAuth.serve acquire"
      to: "the internal build scope"
      via: "Effect.acquireRelease; release closes web handler, runtime, scope; openApps--"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Give the harness a scoped constructor: `TestAuth.serve(composition, options)` returns the app in the caller's `Scope`, and closing that scope releases it. `TestAuth.withApp` brackets a promise-style test. `TestAuth.app` becomes a thin adapter over the same `make`/`release`, so all 134 callers keep compiling until they migrate (tickets 06–19). BEH-EA-356 lands here.

Purpose: the lifetime moves from "remember to call dispose" to "the scope you are in" (PLAN §3.1).

Output: the new interface, its tests, the behaviour entry, a changeset.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§3.2 interface and design notes, §6.2 BEH-EA-356, §6.6)
@packages/test/src/TestAuth.ts (:523-746)
@packages/test/test/TestAuthLifetime.test.ts (from ticket 01)
@packages/test/test/TestAuthApp.test.ts (the BEH-EA-333 cases; unchanged here)
@node_modules/.pnpm/effect@4.1.2/node_modules/effect/dist/Effect.d.ts (acquireRelease :12676, scoped :12567)
@spec/behaviors/25-testing-harness.md (:236-270 BEH-EA-333, Document Control at the top)
@.changeset/contract-test-hook-kinds.md (changeset format)
</context>

<tasks>
<task type="tdd">
  <name>Task 1 (tracer): serve releases with its scope, end to end through a SQL composition</name>
  <files>packages/test/test/TestAuthLifetime.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>packages/test/src/TestAuth.ts:607-746, packages/test/test/TestAuthLifetime.test.ts</read_first>
  <behavior>
    - serve inside it.effect: after one request through app.request over records "sql", TestSql.openClients() is k+1; when the test's Effect.scoped block ends it is k and TestAuth.openApps() is back to its prior value.
    - Failure: Effect.scoped(serve then Effect.fail) → Effect.exit is a failure and the counters are back.
    - Interruption: Effect.scoped(serve then a request then Effect.interrupt) → counters are back.
    - Real clock: under it.effect (TestClock at 0), app.run(Clock.currentTimeMillis) without testClock is within 60 000 ms of Date.now().
  </behavior>
  <action>Write the four cases first and run them red. Then split today's `app` body into a private `make(composition, options)`, which returns the App fields plus a private release function, and a public `serve`.

`make` keeps the internal `Scope.makeUnsafe()`, the three lazy handles and the agent/CSRF/clock logic exactly as at `:631-733`. It increments the `openApps` counter from ticket 01. Its release runs the three steps of today's `dispose` in the same order and then decrements the counter.

`serve` is `Effect.acquireRelease(Effect.sync(() => make(composition, options)), (made) => Effect.promise(made.release))` mapped to the App fields. Add `ServeOptions` (today's inline options type plus `testClock?: boolean | "now"`) and use it in both `serve` and `app`.

Remove `dispose` from `App`. Keep `app(composition, options)` as an adapter returning `App<…> & { readonly dispose: () => Promise<void> }` built from the same `make`, with JSDoc `@deprecated Use TestAuth.serve (or withApp); removed by plan 34 ticket 21`. No return-type annotation on `serve` (inferred); no `as`.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthLifetime.test.ts packages/test/test/TestAuthApp.test.ts</automated></verify>
  <acceptance_criteria>grep -c '^export const serve = ' packages/test/src/TestAuth.ts returns 1 (baseline at HEAD: 0). All TestAuthApp cases still pass unchanged.</acceptance_criteria>
  <done>serve exists, releases on every exit path, and builds on the wall clock; app is an adapter.</done>
</task>

<task type="tdd">
  <name>Task 2: withApp bracket and testClock "now"</name>
  <files>packages/test/test/TestAuthLifetime.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>packages/test/src/TestAuth.ts (serve from Task 1), features/step-definitions/SessionWorld.ts:113-115</read_first>
  <behavior>
    - withApp resolves with the callback's value and the counters are back afterwards.
    - withApp whose callback throws new Error("boom") rejects with that same Error (assert message and identity), and the counters are back.
    - serve with testClock "now": app.run(Clock.currentTimeMillis) is within 60 000 ms of Date.now(); after app.advance("1 day") it is ≥ that value + 86 400 000.
    - testClock true still starts at 0 (existing behaviour).
  </behavior>
  <action>Implement `withApp(composition, options, use)` as `Effect.runPromise(Effect.scoped(Effect.flatMap(serve(composition, options), (app) => Effect.tryPromise({ try: () => use(app), catch: (error) => error }))))`. The callback's rejection must surface unchanged: catching into the error channel and letting `runPromise` reject with it does that, but confirm the identity assertion passes.

In `make`, when `options.testClock === "now"`, merge `Layer.effectDiscard(TestClock.setTime(Date.now())).pipe(Layer.provideMerge(TestClock.layer()))` instead of `TestClock.layer()`. Every place that checks `options.testClock === true` (`syncClock`, `now`, `advance`) must treat `"now"` the same way. Use one local boolean, `simulated`.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthLifetime.test.ts</automated></verify>
  <acceptance_criteria>grep -c '^export const withApp = ' packages/test/src/TestAuth.ts returns 1 (baseline: 0); grep -c '"now"' packages/test/src/TestAuth.ts ≥ 1 (baseline: 0).</acceptance_criteria>
  <done>Promise-style tests have a bracket; a World can ask for a simulated clock started now.</done>
</task>

<task type="auto">
  <name>Task 3: BEH-EA-356, traceability, changeset</name>
  <files>spec/behaviors/25-testing-harness.md, spec/traceability.md, .changeset/test-scoped-app.md</files>
  <read_first>spec/behaviors/25-testing-harness.md (Document Control, BEH-EA-333 and the Previous/Next links), spec/traceability.md (§1 row for file 25, §5 TestAuthApp row :327), .planning/34-scoped-test-app/PLAN.md §6.2, §6.6</read_first>
  <action>Add `## BEH-EA-356: A served app lives exactly as long as its scope` after BEH-EA-342. Use the REQUIREMENT text verbatim from PLAN §6.2, a two-line `ts` example (`const app = yield* TestAuth.serve(TestAuth.layer(built))` inside `it.effect`; `await TestAuth.withApp(layer, undefined, async (app) => …)`) and an *Implementation* line naming `TestAuth.ts` and `test/TestAuthLifetime.test.ts`. Fix the Previous/Next navigation links.

Raise the revision to 1.11 with the change-history entry "1.11 (date): BEH-EA-356, `TestAuth.serve` and `withApp`: the app is released by the scope that served it (architecture plan 34)".

In `spec/traceability.md`: add BEH-EA-356 to the §1 row for file 25 and to the URS-EA-009 crosswalk next to BEH-EA-342, add a §5 row for `packages/test/test/TestAuthLifetime.test.ts`, and add the next change-history revision.

Create `.changeset/test-scoped-app.md` with `"@awthaq/test": minor`, a one-paragraph summary (`serve`, `withApp`, `testClock: "now"`) and the line `Migration: none yet; TestAuth.app keeps working until it is removed.`</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>grep -c '^## BEH-EA-356' spec/behaviors/25-testing-harness.md returns 1 (baseline: 0); grep -c 'BEH-EA-356' spec/traceability.md ≥ 2 (baseline: 0).</acceptance_criteria>
  <done>The behaviour is specified and traced.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm spec:verify:strict && pnpm test:bdd
</verification>

<success_criteria>
- `TestAuthLifetime.test.ts` covers success, failure, interruption, real clock, `withApp` resolve/reject and `testClock: "now"`; all green.
- No caller changed; the full suite and BDD are green.
- BEH-EA-356 is in the spec and traceability.
</success_criteria>

## Comments

BEH ids taken as BEH-EA-351/352/353 (not 356/357/358; the catalog ended at 350). Task 3 spec done in one pass for tickets 03-05.
