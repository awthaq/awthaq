---
plan: 34-scoped-test-app
ticket: 18
title: Plugin suites onto `serve` (passkey, admin, two-factor)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/passkey/test/AuthHttp.test.ts
  - packages/admin/test/AuthHttp.test.ts
  - packages/admin/test/AdminTier.test.ts
  - packages/admin/test/AdminAccountsHttp.test.ts
  - packages/two-factor/test/AuthHttp.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "The five suites acquire every app with serve/withApp"
    - "two-factor's module-level testApp becomes per-test (M3)"
    - "AdminTier's public-tier listener case keeps testing tier selection (BEH-EA-342)"
    - "Test counts unchanged"
  artifacts:
    - path: packages/admin/test/AdminTier.test.ts
  key_links:
    - from: "it.effect body"
      to: "TestAuth.serve"
      via: "M1"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Migrate five suites (PLAN §2.4): AdminAccountsHttp never disposes; the others under-dispose; two-factor holds a module-level app (`:27`).

Purpose: five more suites released by construction.

Output: 0 `TestAuth.app(` in the five files.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M1/M3/M4)
@packages/test/src/TestAuth.ts (serve)
@packages/passkey/test/AuthHttp.test.ts
@packages/admin/test/AuthHttp.test.ts (:34 helper, :95-127)
@packages/admin/test/AdminTier.test.ts (:37 helper, :64-79)
@packages/admin/test/AdminAccountsHttp.test.ts (:20)
@packages/two-factor/test/AuthHttp.test.ts (:27 module-level, :108, :183)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): admin suites</name>
  <files>packages/admin/test/AuthHttp.test.ts, packages/admin/test/AdminTier.test.ts, packages/admin/test/AdminAccountsHttp.test.ts</files>
  <read_first>the three files</read_first>
  <action>The helpers at `AuthHttp.test.ts:34`, `AdminTier.test.ts:37` and `AdminAccountsHttp.test.ts:20` build an app per call. Make each an Effect that requires `Scope` (M4) and `yield*` it in the `it.effect` callers. Delete the inline disposes (`AuthHttp.test.ts:127`, `AdminTier.test.ts:79`). `AdminTier`'s `tier: "public"` composition is unchanged.</action>
  <verify><automated>npx vitest run packages/admin/test/AuthHttp.test.ts packages/admin/test/AdminTier.test.ts packages/admin/test/AdminAccountsHttp.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for the three (baseline at HEAD: 3, 3, 1).</acceptance_criteria>
  <done>Admin suites migrated.</done>
</task>

<task type="auto">
  <name>Task 2: passkey and two-factor</name>
  <files>packages/passkey/test/AuthHttp.test.ts, packages/two-factor/test/AuthHttp.test.ts</files>
  <read_first>both files</read_first>
  <action>passkey: M1 at both sites, then delete the disposes.

two-factor: `:27` `const testApp = TestAuth.app(AppLayer)` is module level. Apply M3 (acquire per test with `serve`). `:108` and `:183` follow M1. Record wall time before and after (R4).</action>
  <verify><automated>npx vitest run packages/passkey/test/AuthHttp.test.ts packages/two-factor/test/AuthHttp.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for both (baseline at HEAD: 4, 3); two-factor wall time ≤ +20%.</acceptance_criteria>
  <done>Five suites migrated.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` in the five files; counts unchanged.
</success_criteria>

## Comments

- Result: 5 suites on serve (M1/M3/M4); 0 TestAuth.app(/.dispose() in them; vitest 10 files/69 tests pass (incl. other saml/qadi tests in run); passkey and two-factor module-level apps now per-test. two-factor wall time not baselined (R4 unmeasured).
