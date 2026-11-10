---
plan: 34-scoped-test-app
ticket: 16
title: Plugin suites onto `serve` (organization, jwt, roles)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/organization/test/AuthHttp.test.ts
  - packages/organization/test/AuthorizationMatrix.test.ts
  - packages/jwt/test/AuthHttp.test.ts
  - packages/jwt/test/BearerReentry.test.ts
  - packages/roles/test/RolesAdmin.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "The five suites (all five never disposed at HEAD) acquire every app with serve/withApp"
    - "roles/RolesAdmin's module-level app becomes per-test (M3)"
    - "Test counts unchanged; wall times within +20% (R4)"
  artifacts:
    - path: packages/roles/test/RolesAdmin.test.ts
  key_links:
    - from: "helper `const app = TestAuth.app(...)` at the top of a describe or function"
      to: "a scoped helper or withApp bracket"
      via: "M1–M4"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Migrate five suites that never release their apps (PLAN §2.4). Organization and jwt build the app inside a helper (`organization/AuthHttp.test.ts:17`, `jwt/AuthHttp.test.ts:41`, `jwt/BearerReentry.test.ts:33`). Roles keeps one at module level (`RolesAdmin.test.ts:40`).

Purpose: five never-dispose suites fewer.

Output: 0 `TestAuth.app(` in the five files.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M1–M4, §7 R4)
@packages/test/src/TestAuth.ts (serve, withApp)
@packages/organization/test/AuthHttp.test.ts
@packages/organization/test/AuthorizationMatrix.test.ts
@packages/jwt/test/AuthHttp.test.ts
@packages/jwt/test/BearerReentry.test.ts
@packages/roles/test/RolesAdmin.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): organization suites</name>
  <files>packages/organization/test/AuthHttp.test.ts, packages/organization/test/AuthorizationMatrix.test.ts</files>
  <read_first>both files</read_first>
  <action>Record the counts and wall time.

`AuthHttp.test.ts:17` wraps the app in a helper used by async tests (13 async, 3 `it.effect`). Make the helper a bracket over `TestAuth.withApp` (M4, bracket variant) for the async tests, and use `serve` directly in the `it.effect` ones.

`AuthorizationMatrix.test.ts` is mostly `it.effect` (generated probes, plan 30): acquire with `serve` inside each generated case (M1). If the matrix shares one app across every probe on purpose, acquire it once per `describe` with `@effect/vitest`'s `layer(Layer.effect(<a local service tag>, TestAuth.serve(...)))` and note the choice in Comments. Keep probe semantics unchanged.</action>
  <verify><automated>npx vitest run packages/organization/test/AuthHttp.test.ts packages/organization/test/AuthorizationMatrix.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(' returns 0 for both (baseline at HEAD: 1, 1); wall time ≤ +20%.</acceptance_criteria>
  <done>Organization's suites release their apps.</done>
</task>

<task type="auto">
  <name>Task 2: jwt and roles</name>
  <files>packages/jwt/test/AuthHttp.test.ts, packages/jwt/test/BearerReentry.test.ts, packages/roles/test/RolesAdmin.test.ts</files>
  <read_first>the three files</read_first>
  <action>jwt: the helpers at `AuthHttp.test.ts:41` and `BearerReentry.test.ts:33` build an app per call for async tests; make them `withApp` brackets (M4). `BearerReentry.test.ts` is a plan-08 exemption ("an absent service is the wiring under test"): keep its composition, change only the lifetime.

roles: `RolesAdmin.test.ts:40` is module level. Apply M3 (per test). It is also a plan-08 exemption for the Roles guard order; keep the composition.</action>
  <verify><automated>npx vitest run packages/jwt/test/AuthHttp.test.ts packages/jwt/test/BearerReentry.test.ts packages/roles/test/RolesAdmin.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(' returns 0 for the three (baseline at HEAD: 3, 1, 1); wall time ≤ +20%.</acceptance_criteria>
  <done>Five suites migrated.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` in the five files; counts unchanged; timings recorded.
</success_criteria>

## Comments

Result: all five suites on serve/withApp; 0 `TestAuth.app(`. Async tests use a local `withHandler`/`withHarness` bracket over `TestAuth.withApp` (M4); organization's `it.effect` tests use `serve` (Effect.map over a local `handlerOf`). AuthorizationMatrix: one async probe, wrapped in `withApp` (no shared app). roles M3: per-test `withHarness`. Package suites green (organization 987, jwt 209, roles 73); counts unchanged; wall times not slower in practice. Organization diff is large only from re-indentation.
