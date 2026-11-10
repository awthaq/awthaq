---
plan: 35-test-mailbox
ticket: 17
title: "sent and layerMemory leave @awthaq/ports"
type: tdd
wave: 5
depends_on: [03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 20]
files_modified:
  - packages/ports/src/Mailer.ts
  - packages/ports/src/SmsSender.ts
  - packages/ports/test/Mailer.test.ts
  - packages/ports/test/SmsSender.test.ts
  - packages/test/src/TestMailbox.ts
autonomous: true
requirements: [REQ-EA-1562]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "MailerShape and SmsSenderShape are send plus the optional development flag"
    - "A provider adapter is Mailer.Mailer.of({ send }) and SmsSender.SmsSender.of({ send }), and type-checks"
    - "Mailer.layerMemory and SmsSender.layerMemory do not exist; layerConsole logs and keeps nothing"
    - "layerNoop's defect points tests at TestMailbox.layer from @awthaq/test"
  artifacts:
    - path: packages/ports/src/Mailer.ts
      provides: "MailerShape {send, development?}; layerNoop; layerConsole"
    - path: packages/ports/src/SmsSender.ts
      provides: "SmsSenderShape {send, development?}; layerNoop; layerConsole"
  key_links:
    - from: packages/test/src/TestMailbox.ts
      to: packages/ports/src/Mailer.ts
      via: "Mailer.Mailer.of({ send, development: true })"
      pattern: "development: true"
---
Status: done (uncommitted)
Blocked by: 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 20

<objective>
The one breaking change: remove `sent` from both port interfaces, delete both `layerMemory` adapters, and stop `layerConsole` from retaining messages. Every reader moved in tickets 02–16 and 20, so this ticket is the contract change plus the ports' own tests.

Purpose: ADR-EA-054 decisions 1 and 3; closes PLAN.md §2.6 item 2 (development adapters retain every mailed credential in an unbounded `Ref`).
Output: two port modules, their tests, and `TestMailbox.ts` dropping the `sent` members it carried for compatibility.
</objective>

<context>
@.planning/35-test-mailbox/PLAN.md (§2.2, §3.4, §6.1)
@packages/ports/src/Mailer.ts
@packages/ports/src/SmsSender.ts
@packages/ports/test/Mailer.test.ts
@packages/ports/test/SmsSender.test.ts
@packages/test/src/TestMailbox.ts
</context>

<tasks>
<task type="tdd">
  <name>Task 1: red, the provider shape</name>
  <files>packages/ports/test/Mailer.test.ts, packages/ports/test/SmsSender.test.ts</files>
  <behavior>
    - Mailer.test.ts, the `MailDeliveryFailed` test (`:72-100`): its provider adapter is `Mailer.Mailer.of({ send })` with no `sent` line (`:95`). This is the "a provider implements `send` alone" case (ADR-EA-054); it fails to type-check while `MailerShape` requires `sent`.
    - SmsSender.test.ts, the `SmsDeliveryFailed` test: the same (`:69`).
  </behavior>
  <action>Make those two edits and run `pnpm --filter @awthaq/ports exec tsc --noEmit -p tsconfig.test.json` (or `pnpm typecheck`): red on the missing `sent`.</action>
  <verify><automated>pnpm typecheck (expected red: property 'sent' is missing)</automated></verify>
  <acceptance_criteria>Exactly the two adapters fail to type-check, for the missing `sent`.</acceptance_criteria>
  <done>Red recorded.</done>
</task>

<task type="tdd">
  <name>Task 2: green, the ports</name>
  <files>packages/ports/src/Mailer.ts, packages/ports/src/SmsSender.ts, packages/test/src/TestMailbox.ts</files>
  <action>`Mailer.ts`: delete `readonly sent` and its comment (`:65-74`, keeping the `send` docs); delete `layerMemory` (`:105-116`); `layerNoop` (`:91-103`) loses `sent` and its defect text says "Provide a real Mailer layer (or TestMailbox.layer from @awthaq/test for tests)."; `layerConsole` (`:118-152`) logs exactly as now but keeps no `Ref` and has no `sent`; its doc comment drops "Records every message like `layerMemory`". Rewrite the header (`:1-24`): the `layerMemory`/`sent` paragraph (`:19-24`) becomes one paragraph saying observation of sent mail is test tooling in `@awthaq/test`'s `TestMailbox` (ADR-EA-054); the opening table reference (`:3-5`) lists `layerNoop`, `layerConsole`. Fix the `development` comment (`:76-79`) to name `layerNoop`, `layerConsole`. Remove the `Ref` import. `SmsSender.ts`: the same (`:50-63`, `:70-95`, `:97-126`, `:20`). `TestMailbox.ts`: remove the `sent` members from its `Mailer` and `SmsSender` and the comment that said they were there until this ticket. No `as`.</action>
  <verify><automated>pnpm typecheck && npx vitest run packages/test/test/TestMailbox.test.ts</automated></verify>
  <acceptance_criteria>Type-check passes repository-wide (every caller moved in earlier tickets). `git grep -nE 'readonly sent|sent: |\.sent([^A-Za-z]|$)|`sent`|layerMemory|effect/Ref' -- packages/ports/src/Mailer.ts packages/ports/src/SmsSender.ts | wc -l` prints 0 (baseline at 04fa3526: 24). `git grep -n 'readonly sent' -- packages/ports/src | wc -l` prints 0 (M1, baseline 2).</acceptance_criteria>
  <done>The port interfaces are `send` plus `development?`.</done>
</task>

<task type="auto">
  <name>Task 3: the ports' own tests and the Postgres run</name>
  <files>packages/ports/test/Mailer.test.ts, packages/ports/test/SmsSender.test.ts</files>
  <action>`Mailer.test.ts`: delete `describe("Mailer.layerMemory")` (`:12-32`; its behaviour is `TestMailbox.test.ts` cases 1–2) and the layerNoop "sent is always empty" case (`:43-48`); the `layerConsole` test (`:103-140`) keeps its log assertions and drops the `sent` read-back (`:134-136`) and "and records the message" from its title. `SmsSender.test.ts`: delete `describe("SmsSender.layerMemory")` (`:11-25`), the `sent` assertion in the layerNoop test (`:41`), and the read-back in the layerConsole test (`:91`). Then run `pnpm test:pg` once (the mailbox's claim is that it outwaits socket I/O; `PasswordStoreOutage.test.ts`, `scripts/test-pg.sh:80`). If Postgres cannot start here, write that in PLAN.md's `## Decisions taken`, do not skip silently.</action>
  <verify><automated>npx vitest run packages/ports/test && pnpm test:pg</automated></verify>
  <acceptance_criteria>Ports tests pass. `git grep -nE 'sent: |\.sent([^A-Za-z]|$)|layerMemory' -- packages/ports/test/Mailer.test.ts packages/ports/test/SmsSender.test.ts | wc -l` prints 0 (baseline at 04fa3526: 15). Plan gates: M4 `git grep -nE '(^|[^A-Za-z])sent: |\.sent([^A-Za-z]|$)|Mailer\.layerMemory|makeCapturingMailer' -- packages features | grep -vE 'webhooks|Webhooks|/web/|agent\.sent|browser\.sent|receiver\.sent|native\.sent|poster\.sent|ReactWorld|NextSsr|ReactSteps|SamlSlo' | wc -l` prints 0 (baseline 164); M6 `git grep -nE 'sent: (Effect|Ref)\.' -- packages features | grep -v Webhooks | wc -l` prints 0 (baseline 26).</acceptance_criteria>
  <done>`pnpm test` and `pnpm test:pg` green over the new contract.</done>
</task>
</tasks>

<threat_model>
| Crossing | Description |
|---|---|
| application → mail provider | the `Mailer` port an application composes in production |
| development adapter → process memory | `layerConsole`, which tutorials compose |

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|---|---|---|---|---|---|
| T-35-03 | I (information disclosure) | `Mailer.layerConsole`/`layerMemory` retaining every mailed token in a `Ref` readable through `sent` by any code holding `Mailer` | medium | mitigate | `sent` and `layerMemory` deleted; `layerConsole` keeps nothing; doctor still flags `development: true` (BEH-EA-201) |
| T-35-04 | D (denial of service) | unbounded `Ref` growth in a long-running development process | low | mitigate | No adapter in `@awthaq/ports` records; the only recorder is `TestMailbox`, scoped to a test composition |
| T-35-06 | T (tampering) | an adopter's provider adapter breaks on upgrade | low | accept | Pre-1.0 breaking change with a `Migration:` line (ticket 18, ADR-EA-034) |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd && pnpm test:pg
</verification>

<success_criteria>
M1 2 → 0, M4 164 → 0, M6 26 → 0; `layerMemory` of both ports gone from code; `pnpm test:pg` run (or its absence recorded).
</success_criteria>

## Comments
- Result: sent/layerMemory gone from both ports; layerConsole is Layer.succeed and keeps nothing. Full typecheck, 6149 unit tests, 1572 BDD tests green. test:pg NOT run (no Postgres here).
