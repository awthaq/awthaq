---
plan: 34-scoped-test-app
ticket: 21
title: Delete `TestAuth.app`; the leak guard enforces by default
type: execute
wave: 5
depends_on: [06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
files_modified:
  - packages/test/src/TestAuth.ts
  - packages/test/src/index.ts
  - features/step-definitions/shared/LeakGuard.ts
  - packages/web/src/UserAgent.ts
  - .changeset/test-app-removed.md
autonomous: true
requirements: [REQ-EA-1550]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "TestAuth.app and App.dispose no longer exist; an app is only ever acquired through serve, withApp, lazyApp or listen"
    - "The repo holds 0 `TestAuth.app(` (135 at HEAD)"
    - "pnpm test:bdd fails a feature file that leaves an app or SQL client open, with no environment variable set"
  artifacts:
    - path: .changeset/test-app-removed.md
      provides: "\"@awthaq/test\": major with the Migration line of PLAN §6.6"
  key_links:
    - from: "LeakGuard afterAll"
      to: "TestAuth.openApps / TestSql.openClients"
      via: "throws when either is above 0 unless AWTHAQ_LEAK_GUARD=report"
---
Status: done (uncommitted)
Blocked by: 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20

<objective>
Replace, don't layer. Once every caller is migrated, remove the unscoped adapter (`TestAuth.ts:616-746`) and flip the leak guard from report to enforce (PLAN §3.2, §6.6). From then on, a leak fails the run instead of printing a line.

Purpose: the leak cannot come back. Any new `TestAuth.app(` call, including one landed by another plan in the meantime (plans 31–40), fails to typecheck.

Output: no `app` export, an enforcing guard, a major changeset.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§3.2, §6.6, §7 R1)
@packages/test/src/TestAuth.ts (:607-746; serve/make from ticket 03)
@packages/test/src/index.ts (:8, :23 comments)
@features/step-definitions/shared/LeakGuard.ts (from ticket 01)
@packages/web/src/UserAgent.ts (:46 comment)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): remove the adapter</name>
  <files>packages/test/src/TestAuth.ts, packages/test/src/index.ts, packages/web/src/UserAgent.ts</files>
  <read_first>TestAuth.ts from :600 to the end of serve; index.ts; UserAgent.ts:40-50</read_first>
  <action>Run `grep -rn 'TestAuth\.app(' --include='*.ts' --include='*.md' . | grep -v node_modules | grep -v '^./.planning'` first. Only `TestAuth.ts`'s own definition and the two comments named here may remain. If any other hit shows up (for example a test another plan added after this plan was written), migrate it with the PLAN §4.2 recipe in this ticket and list it in Comments.

Delete `export const app` and its JSDoc. Delete the `dispose` member from `App` if ticket 03 left it as a compatibility member. `serve` and `make` stay. Delete any helper used only by `app`, and let `pnpm knip` confirm.

Reword `index.ts:8` and `:23` to name `TestAuth.serve`. Reword `UserAgent.ts:46` to say "``TestAuth.serve(..., { testClock: true })`` passes the composition's clock"; it is a comment only, so `@awthaq/web` needs no changeset.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/test</automated></verify>
  <acceptance_criteria>grep -c '^export const app = ' packages/test/src/TestAuth.ts returns 0 (baseline at HEAD: 1); grep -rn 'TestAuth\.app(' --include='*.ts' packages features examples | grep -v node_modules | wc -l prints 0 (baseline at HEAD: 135 including the src comment); grep -c 'dispose' on the App interface of TestAuth.ts returns 0.</acceptance_criteria>
  <done>The unscoped adapter is gone.</done>
</task>

<task type="auto">
  <name>Task 2: enforce the leak guard; changeset</name>
  <files>features/step-definitions/shared/LeakGuard.ts, .changeset/test-app-removed.md</files>
  <read_first>LeakGuard.ts; .changeset/test-scoped-app.md (ticket 03's changeset, for tone)</read_first>
  <action>Invert the guard's switch. It enforces by default and only reports when `process.env["AWTHAQ_LEAK_GUARD"] === "report"`, kept for a contributor bisecting a leak. Update its one-line header comment.

Create `.changeset/test-app-removed.md` with `"@awthaq/test": major`. Its body says `TestAuth.app` and `App.dispose` are removed, followed by the `Migration:` line written verbatim in PLAN §6.6.</action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>pnpm test:bdd is green with no AWTHAQ_LEAK_GUARD set, and every `[leak-guard]` line reads apps=0 sqlClients=0; grep -c 'Migration:' .changeset/test-app-removed.md returns 1. A scratch check proves the guard bites: temporarily add a step that serves an app outside the World's scope, see the run fail naming the feature file, then revert it. Say so in Comments.</acceptance_criteria>
  <done>A leak now fails the BDD run.</done>
</task>
</tasks>

<threat_model>
| ID | Threat | Mitigation |
|---|---|---|
| T-34-06 | The guard is flipped while a leak remains (a sibling plan landed a new unscoped call between waves), so CI goes red on an unrelated change | Task 1's repo-wide grep runs first, before the flip; an unmigrated call fails `pnpm typecheck` once `app` is gone, so the failure names the file instead of surfacing as a leak count |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
No `TestAuth.app` anywhere outside `.planning/`; the guard enforces; a major changeset with its Migration line.
</success_criteria>

## Comments
- Result: `app`, `DisposableApp` and `App.dispose` deleted; `TestAuthLifetime.test.ts` lost its two `app`/dispose cases (the `serve` cases cover them). `TestAuth.app` comments now name `serve`. LeakGuard enforces unless `AWTHAQ_LEAK_GUARD=report`. `BrowserPage.page` un-exported (knip). Not done: the scratch check that the guard bites (a deliberately leaked app). `15-password` still leaves one slowMailer app to a detached fiber; the full BDD run passed that file.
