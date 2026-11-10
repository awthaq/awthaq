---
plan: 34-scoped-test-app
ticket: 19
title: Plugin suites onto `serve` (qadi, webhooks, saml)
type: execute
wave: 2
depends_on: [03]
files_modified:
  - packages/qadi/test/AuthorizedSubject.test.ts
  - packages/qadi/test/SubjectApi.test.ts
  - packages/webhooks/test/WebhooksHttp.test.ts
  - packages/saml/test/SamlSloHttp.test.ts
  - packages/saml/test/SamlHttp.test.ts
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "The five suites acquire every app with serve"
    - "Test counts unchanged"
  artifacts:
    - path: packages/saml/test/SamlHttp.test.ts
  key_links:
    - from: "it.effect body"
      to: "TestAuth.serve"
      via: "M1/M4"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Migrate the last five package suites (PLAN §2.4). The qadi, webhooks and SamlSlo suites never dispose; SamlHttp under-disposes. The uncommitted work in `packages/qadi/src` belongs to someone else: this ticket edits only `packages/qadi/test/*`.

Purpose: after this ticket, no package or example test calls `TestAuth.app`.

Output: 0 `TestAuth.app(` under `packages/*/test` and `examples/*/test`.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§4.2 M1/M4)
@packages/test/src/TestAuth.ts (serve)
@packages/qadi/test/AuthorizedSubject.test.ts
@packages/qadi/test/SubjectApi.test.ts
@packages/webhooks/test/WebhooksHttp.test.ts (:11 helper)
@packages/saml/test/SamlSloHttp.test.ts (:29 helper)
@packages/saml/test/SamlHttp.test.ts (:35 helper, :141, :194)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): saml and webhooks helpers</name>
  <files>packages/saml/test/SamlHttp.test.ts, packages/saml/test/SamlSloHttp.test.ts, packages/webhooks/test/WebhooksHttp.test.ts</files>
  <read_first>the three files</read_first>
  <action>Each builds its app in a helper (`SamlHttp.test.ts:35`, `SamlSloHttp.test.ts:29`, `WebhooksHttp.test.ts:11`). Make each helper an Effect that requires `Scope` (M4) and `yield*` it in the `it.effect` callers. Delete `SamlHttp.test.ts:194`'s dispose. Keep `baseUrl: BASE_URL`.</action>
  <verify><automated>npx vitest run packages/saml/test/SamlHttp.test.ts packages/saml/test/SamlSloHttp.test.ts packages/webhooks/test/WebhooksHttp.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(\|\.dispose()' returns 0 for the three (baseline at HEAD: 3, 1, 1).</acceptance_criteria>
  <done>saml and webhooks migrated.</done>
</task>

<task type="auto">
  <name>Task 2: qadi tests (test files only)</name>
  <files>packages/qadi/test/AuthorizedSubject.test.ts, packages/qadi/test/SubjectApi.test.ts</files>
  <read_first>both files; git status packages/qadi (do not stage src)</read_first>
  <action>Apply M1 at 2 + 5 sites. Stage only these two test files by explicit path. Never stage `packages/qadi/src/UserClaims.ts`, which carries someone else's uncommitted work.

Then confirm the package-wide gate: `grep -rn 'TestAuth\.app(' packages/*/test examples/*/test --include='*.ts' | wc -l` prints 0, provided tickets 13–18 have landed. If they have not, record the remaining count in Comments.</action>
  <verify><automated>npx vitest run packages/qadi/test/AuthorizedSubject.test.ts packages/qadi/test/SubjectApi.test.ts</automated></verify>
  <acceptance_criteria>Counts unchanged; grep -c 'TestAuth\.app(' returns 0 for both (baseline at HEAD: 2, 5).</acceptance_criteria>
  <done>The last package suites migrated.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
0 `TestAuth.app(` in the five files; counts unchanged.
</success_criteria>

## Comments

- Result: 5 suites on serve (M1/M4); 0 TestAuth.app( in them; tests pass. Package-wide gate count not re-run (other tickets in parallel).
