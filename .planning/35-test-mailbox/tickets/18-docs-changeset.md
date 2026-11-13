---
plan: 35-test-mailbox
ticket: 18
title: "docs and the changeset"
type: execute
wave: 6
depends_on: [17]
files_modified:
  - README.md
  - packages/ports/README.md
  - docs/plugin-authoring.md
  - spec/overview.md
  - .changeset/test-mailbox.md
autonomous: true
requirements: [REQ-EA-1562]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No adopter-facing doc tells a provider to implement sent or names Mailer.layerMemory"
    - "The changeset bumps ports minor, test minor, cli patch, with a Migration line naming every replacement"
  artifacts:
    - path: .changeset/test-mailbox.md
      provides: "the release note and migration (PLAN.md §6.6)"
  key_links:
    - from: README.md
      to: packages/ports/src/Mailer.ts
      via: "Mailer.Mailer.of({ send })"
      pattern: "Mailer\\.Mailer\\.of\\(\\{ send \\}\\)"
---
Status: done (uncommitted)
Blocked by: 17

<objective>
Bring the adopter-facing docs in line with ticket 17 and write the changeset (ADR-EA-034: a breaking change to `@awthaq/ports` carries a migration note).

Purpose: PLAN.md §6.5, §6.6.
Output: four doc edits and one new changeset.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§6.5, §6.6 has the changeset text)
@README.md:210-216
@packages/ports/README.md:5
@docs/plugin-authoring.md:250-266
@spec/overview.md:130-137
@.changeset/admin-config-private.md (format; pre-1.0 removal bumps minor)
</context>

<tasks>
<task type="auto">
  <name>Task 1: the docs</name>
  <files>README.md, packages/ports/README.md, docs/plugin-authoring.md, spec/overview.md</files>
  <action>`README.md:214` (the `Mailer` row): the "bring your own" cell says `Mailer.Mailer.of({ send })` (any provider), and "`Mailer.layerMemory` records mail for tests" becomes "tests read mail through `TestMailbox` in `@awthaq/test`". `packages/ports/README.md:5`: the `SmsSender` clause appears twice; keep one, and in it replace `layerNoop`/`layerMemory`/`layerConsole` with `layerNoop`/`layerConsole`; in the opening "`layerNoop`/`layerMemory`-style variants" leave `layerMemory` (other ports such as `RateLimiter` still ship one). `docs/plugin-authoring.md:252`: the test ports list says `TestMailbox.layer` (a recording `Mailer` and `SmsSender`, read through `TestMailbox.Mailbox`) instead of `Mailer.layerMemory`; `:265`: where it says a capturing double given in `services` can be read back, add that mail is read through `TestMailbox.Mailbox` (`waitFor`, `refute`), and that a one-member `Mailer` double is `Layer.mock(Mailer.Mailer)({ send })`. `spec/overview.md:134-135`: the `Mailer` and `SmsSender` rows list `layerNoop`, `layerConsole` (bump the document's revision and change history in its own format, citing plan 35 and ADR-EA-054).</action>
  <verify><automated>pnpm lint</automated></verify>
  <acceptance_criteria>`git grep -nE '(Mailer|SmsSender)\.layerMemory|send, sent|^\| `(Mailer|SmsSender)` .*layerMemory' -- README.md packages/ports/README.md docs/plugin-authoring.md spec/overview.md | wc -l` prints 0 (baseline at 04fa3526: 4). `grep -o 'SmsSender` (the SMS capability' packages/ports/README.md | wc -l` prints 1 (baseline 2).</acceptance_criteria>
  <done>Docs match the ports.</done>
</task>

<task type="auto">
  <name>Task 2: the changeset</name>
  <files>.changeset/test-mailbox.md</files>
  <action>Create `.changeset/test-mailbox.md` with the text drafted in PLAN.md §6.6 (frontmatter `"@awthaq/ports": minor`, `"@awthaq/test": minor`, `"@awthaq/cli": patch`). Adjust only if ticket 17 or Q7's answer changed a detail (for example, if Q3 kept a non-recording `layerMemory`).</action>
  <verify><automated>pnpm changeset status 2>/dev/null || ls .changeset/test-mailbox.md</automated></verify>
  <acceptance_criteria>The file exists; `grep -c '^Migration:' .changeset/test-mailbox.md` prints 1.</acceptance_criteria>
  <done>The release note carries the migration.</done>
</task>
</tasks>

<verification>
pnpm check
</verification>

<success_criteria>
Docs gate 4 → 0; changeset present with `Migration:`; `pnpm check` green.
</success_criteria>

## Comments
- Result: README, ports README, plugin-authoring, spec/overview.md 1.17; changeset test-mailbox.md uses BEH-EA-354.
