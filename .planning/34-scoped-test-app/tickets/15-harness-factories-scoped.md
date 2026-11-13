---
plan: 34-scoped-test-app
ticket: 15
title: Harness factories return a scoped app (api-key, device-authorization)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/api-key/test/harness.ts
  - packages/api-key/test/AuthHttp.test.ts
  - packages/device-authorization/test/support/harness.ts
  - packages/device-authorization/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "Neither harness can hand out an app without releasing it: makeApp is replaced by a bracket over TestAuth.withApp"
    - "Every SQL-mode test of both suites releases its SQL client (L3); on Postgres under pnpm test:pg the pools close per test"
    - "Test counts unchanged"
  artifacts:
    - path: packages/api-key/test/harness.ts
      provides: "withHarnessApp(options, use)"
    - path: packages/device-authorization/test/support/harness.ts
      provides: "withHarnessApp(options, use, taps?)"
  key_links:
    - from: "withHarnessApp"
      to: "TestAuth.withApp"
      via: "M4 (bracket variant: every caller is an async test)"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Fix L3 (PLAN §2.9): both plugin harnesses return an app with no release even in `store: "sql"` mode. `device-authorization/test/AuthHttp.test.ts` is in `scripts/test-pg.sh`, so it leaks Postgres pools. Every caller is an `async` test, so the factory becomes a bracket (`withHarnessApp(options, async (app) => …)`) over `TestAuth.withApp`.

Purpose: a harness that cannot leak.

Output: two harnesses, two suites, 0 `TestAuth.app(`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.4, §2.9 L3, §4.2 M2/M4)
@packages/test/src/TestAuth.ts (withApp)
@packages/api-key/test/harness.ts (:53-116)
@packages/api-key/test/AuthHttp.test.ts (:22-26 newApp, every caller)
@packages/device-authorization/test/support/harness.ts (:20-93)
@packages/device-authorization/test/AuthHttp.test.ts (10 makeApp callers)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): api-key harness and suite</name>
  <files>packages/api-key/test/harness.ts, packages/api-key/test/AuthHttp.test.ts</files>
  <read_first>both files</read_first>
  <action>Record the test count. In `harness.ts`, replace `makeApp(options)` with `withHarnessApp(options, use)`. It calls `TestAuth.withApp(buildLayer(options), { baseUrl: ORIGIN }, (app) => use(<today's returned object built from app>))` and returns the callback's promise. Keep `layer` in that object if a caller reads it.

In `AuthHttp.test.ts`, `newApp(options)` becomes `withApp(options, use)` delegating to it, and each test body moves inside `await withApp({}, async (app) => { … })`. Keep assertions unchanged.</action>
  <verify><automated>npx vitest run packages/api-key/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Same count, green; grep -c 'TestAuth\.app(\|makeApp' packages/api-key/test/harness.ts packages/api-key/test/AuthHttp.test.ts returns 0 for both (baseline at HEAD: harness 2, AuthHttp 2).</acceptance_criteria>
  <done>api-key cannot leak an app.</done>
</task>

<task type="auto">
  <name>Task 2: device-authorization harness and suite</name>
  <files>packages/device-authorization/test/support/harness.ts, packages/device-authorization/test/AuthHttp.test.ts</files>
  <read_first>both files</read_first>
  <action>Do the same as Task 1. `makeApp(options, taps?)` becomes `withHarnessApp(options, use, taps?)`. All 10 callers move their bodies into the bracket. The ADR-EA-047 probe at `:62-75` builds two apps (`at(…)`); nest two brackets. Keep `buildLayer` for direct service tests unchanged.</action>
  <verify><automated>npx vitest run packages/device-authorization/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Same count, green; grep -c 'TestAuth\.app(\|makeApp' returns 0 for both files (baseline at HEAD: harness 3, AuthHttp 11).</acceptance_criteria>
  <done>device-authorization cannot leak an app; under pnpm test:pg its pools close per test.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:pg (device-authorization/test/AuthHttp.test.ts is in scripts/test-pg.sh; run it if a Postgres is reachable, otherwise say so in Comments and leave it to CI)
</verification>

<success_criteria>
Both suites green with unchanged counts; 0 `makeApp`/`TestAuth.app(` in the four files.
</success_criteria>

## Comments
Result: both harnesses export withHarnessApp (api-key: (options, use); device-authorization: (options, use, taps?)) over TestAuth.withApp, and HarnessApp type; makeApp removed. api-key AuthHttp has a local withApp(options, use); all callers moved into the bracket; ADR-EA-047 probes use at(address, use). Green: both suites 55 tests. pnpm test:pg not run (no Postgres here); left to CI.
