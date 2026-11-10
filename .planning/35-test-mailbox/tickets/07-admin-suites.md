---
plan: 35-test-mailbox
ticket: 07
title: "admin suites read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - packages/admin/test/AdminAccounts.test.ts
  - packages/admin/test/AdminAccountsHttp.test.ts
  - packages/admin/test/AdminGate.test.ts
  - packages/admin/test/ImpersonationOwnerNotice.test.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Admin suites read mail through TestMailbox.Mailbox; 'nothing was mailed' is a refute"
    - "ImpersonationOwnerNotice's hand-built stack composes TestMailbox.layer and has no 20-yield settle"
  artifacts:
    - path: packages/admin/test/ImpersonationOwnerNotice.test.ts
      provides: "the notice tests over TestMailbox.layer"
  key_links:
    - from: packages/admin/test/ImpersonationOwnerNotice.test.ts
      to: packages/test/src/TestMailbox.ts
      via: "Layer.provideMerge(TestMailbox.layer)"
      pattern: "TestMailbox\\.layer"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move `@awthaq/admin`'s four mail-reading suites to `TestMailbox`, replace the failing mailer with `Layer.mock`, and delete the `settle` helper (`TestClock.adjust(50 ms)` + 20 yields).

Purpose: one of the two mail settles (PLAN.md §2.4) and one inline token reader (`AdminAccounts.test.ts:228-230`).
Output: four test files. `packages/admin/src` is not touched.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@packages/admin/src/ImpersonationOwnerNotice.ts (subscribes with `AuthEvents.on`, dispatches through `MailDispatch`; no clock of its own)
@packages/admin/test/AdminAccounts.test.ts:36-56,210-280,300-312
@packages/admin/test/AdminAccountsHttp.test.ts:130-150
@packages/admin/test/AdminGate.test.ts:715-730
@packages/admin/test/ImpersonationOwnerNotice.test.ts
</context>

<tasks>
<task type="auto">
  <name>Task 1: AdminAccounts, AdminAccountsHttp, AdminGate</name>
  <files>packages/admin/test/AdminAccounts.test.ts, packages/admin/test/AdminAccountsHttp.test.ts, packages/admin/test/AdminGate.test.ts</files>
  <action>`AdminAccounts.test.ts`: `failingMailer` (`:41-55`) becomes `Layer.mock(Mailer.Mailer)({ send })` with the same `MailDeliveryFailed`. The four reads: `:218` becomes `box.mail.waitFor({ to: "new@example.com", template: EmailChange.TEMPLATE })` followed by `box.mail.refute({ template: EmailChange.TEMPLATE }, { beyond: 1 })` (the old `rest.length === 0`); keep the `assert.isTrue(Redacted.isRedacted(raw))` EOTS-010 check at `:229` and replace the inline unwrap at `:230` with `TestMailbox.secret(mail)`; `:260` and `:265` become `box.mail.refute({})`; `:275` becomes `waitFor({ template: EmailChange.TEMPLATE })`. `AdminAccountsHttp.test.ts:140` (`app.inApp(Mailer.Mailer.use((mailer) => mailer.sent))`) becomes `app.inApp(Effect.flatMap(TestMailbox.Mailbox, (box) => box.mail.waitFor(match)))` with the match the assertion that follows needs. `AdminGate.test.ts:725` becomes `waitFor` with the template the test triggers. `box` is `yield* TestMailbox.Mailbox`. Drop `Mailer` imports that become unused.</action>
  <verify><automated>npx vitest run packages/admin/test/AdminAccounts.test.ts packages/admin/test/AdminAccountsHttp.test.ts packages/admin/test/AdminGate.test.ts</automated></verify>
  <acceptance_criteria>All three pass with HEAD test counts. `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|isRedacted\(raw\) \?' -- packages/admin/test/AdminAccounts.test.ts packages/admin/test/AdminAccountsHttp.test.ts packages/admin/test/AdminGate.test.ts | wc -l` prints 0 (baseline 8).</acceptance_criteria>
  <done>No admin suite but the notice reads `sent`.</done>
</task>

<task type="auto">
  <name>Task 2: ImpersonationOwnerNotice</name>
  <files>packages/admin/test/ImpersonationOwnerNotice.test.ts</files>
  <action>In `CoreLive` (`:15-23`) replace `Layer.provideMerge(Mailer.layerMemory)` with `Layer.provideMerge(TestMailbox.layer)` (import `{ TestMailbox }` from `@awthaq/test`). Delete `settle` (`:28-31`). The positive test (`:56-63`): the settle after `events.emit` becomes `const mail = yield* box.mail.waitFor({ to: "owner@example.com", template: ImpersonationOwnerNotice.TEMPLATE })`, then `box.mail.refute({}, { beyond: 1 })` for the old `length === 1`, then the existing field and no-leak assertions on `mail`. The two negative tests (`:92-98`, `:111-117`) become `box.mail.refute({})` after the emit. The settle *before* each emit: delete it; the notice subscribes when its layer is built (`AuthEvents.on`). If a positive test then misses the event, the subscription starts lazily: put back a single `TestClock.adjust(Duration.millis(50))` (no yields) before the emit with a one-line comment, and note it in `## Comments`.</action>
  <verify><automated>npx vitest run packages/admin/test/ImpersonationOwnerNotice.test.ts</automated></verify>
  <acceptance_criteria>Passes with the HEAD test count. Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|settle|yieldNow|isRedacted\(raw\) \?' -- packages/admin/test/AdminAccounts.test.ts packages/admin/test/AdminAccountsHttp.test.ts packages/admin/test/AdminGate.test.ts packages/admin/test/ImpersonationOwnerNotice.test.ts | wc -l` prints 0 (baseline at 04fa3526: 20; the `yieldNow` line is the one inside `settle`).</acceptance_criteria>
  <done>The admin package has no `sent` read and no mail settle.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Gate 20 → 0; one settle and one inline token reader deleted; test counts unchanged.
</success_criteria>

## Comments
Done (uncommitted). 4 admin suites pass (38 tests); gate 0. ImpersonationOwnerNotice needs no pre-emit settle or TestClock.adjust (subscription is live when the layer builds). Prettier was run over packages/admin/test/*.test.ts.
