---
plan: 40-residue
ticket: 03
title: "Two-factor handlers read the domain caller"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/two-factor/src/TwoFactor.ts
  - packages/two-factor/test/TwoFactor.test.ts
  - .changeset/current-user-caller-two-factor.md
autonomous: false
requirements: [REQ-EA-1610]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No two-factor handler re-brands the principal"
    - "TwoFactorShape's session parameters are Sessions.SessionId and TwoFactor re-brands no session id internally"
    - "The plugin-DDL-locality edits in TwoFactor.ts (imports, `migrations: Migrations.ledger(...)`) are untouched by this ticket"
  artifacts:
    - path: packages/two-factor/src/TwoFactor.ts
      provides: "two_factor.account handlers on CurrentUser.current's userId/sessionId"
  key_links:
    - from: packages/two-factor/src/TwoFactor.ts
      to: packages/core/src/CurrentUser.ts
      via: "handlers destructure userId/sessionId"
      pattern: "\\{ userId(, sessionId)? \\} = yield\\* CurrentUser\\.current"
---
Status: done (uncommitted)
Blocked by: 01, and the uncommitted plugin-DDL-locality work in `packages/two-factor/src/{TwoFactor,TwoFactorStore}.ts` (with `.changeset/plugin-ddl-locality.md`) being committed by its owner. A human flips this to ready-for-agent when `git status --porcelain packages/two-factor/src` prints nothing (PLAN §10 Q9).

<objective>
Remove the 5 hand re-brands in the "two_factor.account" handlers and the internal session-id re-brand.
Purpose: GC-003 (PLAN §2.A.2). The file carries someone else's in-progress work, so this ticket waits for it rather than editing around it.
Output: handlers destructure `userId`/`sessionId`; `TwoFactorShape` takes `Sessions.SessionId`.
</objective>

<context>
@packages/two-factor/src/TwoFactor.ts (shape :95-155, handlers :327-382, requireFreshSession :485-495; line numbers from the tree with the WIP applied)
@packages/core/src/CurrentUser.ts (after ticket 01)
@.planning/40-residue/PLAN.md §2.A.2
</context>

<tasks>
  <task type="auto">
    <name>Task 1: handlers and shape</name>
    <files>packages/two-factor/src/TwoFactor.ts, packages/two-factor/test/TwoFactor.test.ts</files>
    <read_first>packages/two-factor/src/TwoFactor.ts around the `two_factor.account` group and `requireFreshSession`; `git log -1 --stat -- packages/two-factor/src` to confirm the WIP is committed</read_first>
    <precondition>`git status --porcelain packages/two-factor/src` prints nothing. If it prints anything, halt and report; do not stash, commit or edit someone else's changes.</precondition>
    <action>In `enable`, `confirm`, `disable`, `regenerateRecoveryCodes` and `status` (5 sites), replace `const { principal } = yield* CurrentUser.current` with `const { userId, sessionId } = yield* CurrentUser.current` (or `{ userId }` where no session is passed) and pass those instead of `Users.UserId(principal.ref.id)` / `principal.sessionId`. In `TwoFactorShape` change each `sessionId: string` parameter to `sessionId: Sessions.SessionId`, and the implementations' matching parameters including `requireFreshSession`; drop the `Sessions.SessionId(sessionId)` call inside it. Fix any two-factor test that passes a raw string session id (`user.sessionId` from the harness may already be branded; check with tsc). device-authorization's `test/Plugin.test.ts:33` passes `fresh.session.id` (branded) and should need no change; if tsc says otherwise, add that file to this ticket and record it in Comments.</action>
    <verify><automated>npx vitest run packages/two-factor/test packages/device-authorization/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -c 'Users\.UserId\(principal\.ref\.id\)' packages/two-factor/src` prints nothing (baseline 5); `rg -n 'Sessions\.SessionId\(sessionId\)' packages/two-factor/src` prints nothing (baseline 1); `git diff HEAD -- packages/two-factor/src/TwoFactor.ts` touches no `migrations`/`Migrations` line.</acceptance_criteria>
    <done>Two-factor and device-authorization suites green.</done>
  </task>
  <task type="auto">
    <name>Task 2: changeset</name>
    <files>.changeset/current-user-caller-two-factor.md</files>
    <read_first>.changeset/api-key-client-revoke-once.md (format)</read_first>
    <action>Write the changeset: `"@awthaq/two-factor": minor`; one sentence; `Migration: TwoFactorShape session parameters take Sessions.SessionId.`</action>
    <verify><automated>test -f .changeset/current-user-caller-two-factor.md && grep -c '^Migration:' .changeset/current-user-caller-two-factor.md</automated></verify>
    <done>Changeset present.</done>
  </task>
</tasks>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>A1 gate for two-factor = 0 (baseline 5); A4 gate for two-factor = 0 (baseline 1); suites green; the WIP's lines untouched.</success_criteria>

## Comments
- 2026-11-10: precondition held (DDL work committed at 85a9a5ce). Five handlers destructure `{ userId, sessionId }` / `{ userId }` from `CurrentUser.current`; `TwoFactorShape` session params, `requireFactor` and `requireFreshSession` take `Sessions.SessionId`; the internal `Sessions.SessionId(sessionId)` re-brand is gone (Q6 yes). No `migrations` line touched. Changeset `.changeset/current-user-caller-two-factor.md` written (minor + Migration line).
- Out-of-package fix: `features/step-definitions/TwoFactorWorld.ts` `sessionId: string` -> `Sessions.SessionId` (the only source of the 7 tsc errors in TwoFactorSteps/SecuritySteps). device-authorization needed no change.
- Ran: tsc -b and tsc -p tsconfig.test.json clean; vitest two-factor, device-authorization, roles: 355 passed; BDD 26-cli, 31-two-factor, 18-roles: 188 passed; circular 0; spec:verify:strict PASS 32.
