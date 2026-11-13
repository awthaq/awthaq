---
plan: 35-test-mailbox
ticket: 08
title: "organization suites read the mailbox"
type: execute
wave: 3
depends_on: [02]
files_modified:
  - packages/organization/test/Organization.test.ts
  - packages/organization/test/OrganizationInvitations.test.ts
  - packages/organization/test/OrganizationConnections.test.ts
autonomous: true
requirements: [REQ-EA-1560]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Organization suites use the TestAuth base mailbox by default and pass a Mailer only to override it"
    - "Invitation tokens are read with TestMailbox.secret from a waited-for mail"
  artifacts:
    - path: packages/organization/test/OrganizationInvitations.test.ts
      provides: "invitation tests over the base mailbox; the failing mailer is Layer.mock"
  key_links:
    - from: packages/organization/test/OrganizationInvitations.test.ts
      to: TestMailbox.Mailbox
      via: "waitFor({ to, template: \"organization-invite\" })"
      pattern: "waitFor"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Move `@awthaq/organization`'s three mail-touching suites to `TestMailbox`: the builders stop defaulting a mailer to `Mailer.layerMemory`, reads go through the mailbox, the failing mailer is `Layer.mock`.

Purpose: removes 10 gate lines (PLAN.md §2.3: organization 5 direct reads plus the layer defaults).
Output: three test files. `packages/organization/src` is not touched.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§3.3)
@packages/test/src/TestMailbox.ts
@packages/organization/test/Organization.test.ts:20-55,1115-1125,1290-1300
@packages/organization/test/OrganizationInvitations.test.ts:40-120,145-165,690-702
@packages/organization/test/OrganizationConnections.test.ts:85-100
</context>

<tasks>
<task type="auto">
  <name>Task 1: the two builders and their reads</name>
  <files>packages/organization/test/Organization.test.ts, packages/organization/test/OrganizationInvitations.test.ts</files>
  <action>`Organization.test.ts:25-31` and `OrganizationInvitations.test.ts:40-48`: the `mailer` parameter becomes optional with no default (`mailerLayer?: Layer.Layer<Mailer.Mailer>`), and `services` merges it only when given, so the default composition uses the `TestAuth` base mailbox (ticket 02). Each `mailer.sent` read (`Organization.test.ts:50`, `:1120`, `:1295`; `OrganizationInvitations.test.ts:86`, `:114`) becomes `box.mail.waitFor({ to, template })` (with `nth` counted from the matches recorded before the trigger when the same mail is sent twice) or `messages` where the old code listed every mail already known to be sent synchronously; a "none sent" check becomes `refute`. The newest-first loop at `OrganizationInvitations.test.ts:86` picks a token: keep that order by reading `messages` reversed after a `waitFor` for the invite, and unwrap with `TestMailbox.secret`. The failing mailer (`:147-160`) becomes `Layer.mock(Mailer.Mailer)({ send })`. `:698`'s `Mailer.layerMemory` in a hand-built stack becomes `TestMailbox.layer`.</action>
  <verify><automated>npx vitest run packages/organization/test/Organization.test.ts packages/organization/test/OrganizationInvitations.test.ts</automated></verify>
  <acceptance_criteria>Both pass with HEAD test counts. `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory' -- packages/organization/test/Organization.test.ts packages/organization/test/OrganizationInvitations.test.ts | wc -l` prints 0 (baseline 9).</acceptance_criteria>
  <done>The two suites read the mailbox.</done>
</task>

<task type="auto">
  <name>Task 2: OrganizationConnections</name>
  <files>packages/organization/test/OrganizationConnections.test.ts</files>
  <action>`:95` composes `Mailer.layerMemory` beside `Users.layer` in a hand-built stack and never reads mail: replace it with `Mailer.layerNoop` if no code path in the file sends, otherwise `TestMailbox.layer`. Decide by running the file once with `layerNoop` (it dies on send, so a send shows up as a failure).</action>
  <verify><automated>npx vitest run packages/organization/test</automated></verify>
  <acceptance_criteria>Ticket gate: `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory' -- packages/organization/test/Organization.test.ts packages/organization/test/OrganizationInvitations.test.ts packages/organization/test/OrganizationConnections.test.ts | wc -l` prints 0 (baseline at 04fa3526: 10).</acceptance_criteria>
  <done>The organization package's tests pass with no `sent` read.</done>
</task>
</tasks>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Gate 10 → 0; organization tests green with unchanged counts.
</success_criteria>

## Comments
Done (uncommitted). organization + admin tests pass (1199); gate 0. Deviations: Organization.test.ts buildLayer lost its mailer parameter entirely (no caller passed one); OrganizationConnections uses Mailer.layerNoop (no send path). Token readers read `messages` reversed + TestMailbox.secret (mail is sent synchronously by invite).
