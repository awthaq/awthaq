---
plan: 40-residue
ticket: 02
title: "Passkey and password handlers read the domain caller"
type: execute
wave: 2
depends_on: [01]
files_modified:
  - packages/passkey/src/Passkey.ts
  - packages/password/src/Password.ts
  - packages/passkey/test/Passkey.test.ts
  - .changeset/current-user-caller-passkey.md
autonomous: true
requirements: [REQ-EA-1610]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "No passkey or password handler re-brands the principal"
    - "PasskeyShape's session parameters are Sessions.SessionId, and Passkey re-brands no session id internally"
    - "Passkey and password HTTP behaviour is unchanged (their test suites pass unmodified apart from compile fixes)"
  artifacts:
    - path: packages/passkey/src/Passkey.ts
      provides: "handlers on `const { userId, sessionId } = yield* CurrentUser.current`"
  key_links:
    - from: packages/passkey/src/Passkey.ts
      to: packages/core/src/CurrentUser.ts
      via: "handlers destructure userId/sessionId"
      pattern: "\\{ userId, sessionId \\} = yield\\* CurrentUser\\.current"
---
Status: done (uncommitted)
Blocked by: 01

<objective>
Remove the 9 + 3 hand re-brands in passkey and password handlers, and the two internal session-id re-brands in passkey.
Purpose: GC-003 says the principal is re-branded once (`CurrentUser.of`); these handlers re-brand it again (PLAN §2.A.2).
Output: handlers destructure `userId`/`sessionId`; `PasskeyShape` takes `Sessions.SessionId`.
</objective>

<context>
@packages/passkey/src/Passkey.ts (shape :175-225, handlers :292-436, requireFreshSession :849-860, reauthenticate :1225-1235)
@packages/password/src/Password.ts (handlers :485-530)
@packages/core/src/CurrentUser.ts (after ticket 01)
@.planning/40-residue/PLAN.md §2.A.2, §3.A
</context>

<tasks>
  <task type="auto">
    <name>Task 1: passkey handlers and shape</name>
    <files>packages/passkey/src/Passkey.ts, packages/passkey/test/Passkey.test.ts</files>
    <read_first>packages/passkey/src/Passkey.ts lines 175-225, 292-436, 845-860, 1220-1240</read_first>
    <action>In every handler of the "passkey", "passkey.credentials" and "passkey.reauthenticate" groups (9 sites, :300-432), replace `const { principal } = yield* CurrentUser.current` and the `Users.UserId(principal.ref.id)` / `principal.sessionId` arguments with `const { userId, sessionId } = yield* CurrentUser.current` (or `{ userId }` where only the user is passed) and pass those. In `PasskeyShape` change every `sessionId: string` parameter (:180, :187, :196, :218, :222) to `sessionId: Sessions.SessionId`, and the matching parameter of the implementation functions, including `requireFreshSession` (:849). Then drop the now-redundant `Sessions.SessionId(sessionId)` calls at :853 and :1232 (pass `sessionId` directly). Leave `PasskeyCeremony.ts` (its `sessionId: string` fields accept a branded value). If `Users` is no longer used in the handler module section, keep the import only if other code uses it. Run `pnpm typecheck`; fix any test in packages/passkey/test/Passkey.test.ts that passes a plain string as a session id by passing the issued session's `.id` (already branded) or `Sessions.SessionId("...")`.</action>
    <verify><automated>npx vitest run packages/passkey/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -c 'Users\.UserId\(principal\.ref\.id\)' packages/passkey/src` prints nothing (baseline 9); `rg -n 'Sessions\.SessionId\(sessionId\)' packages/passkey/src` prints nothing (baseline 2: :853, :1232).</acceptance_criteria>
    <done>Passkey suite green with the branded session parameter.</done>
  </task>
  <task type="auto">
    <name>Task 2: password handlers</name>
    <files>packages/password/src/Password.ts</files>
    <read_first>packages/password/src/Password.ts lines 485-530</read_first>
    <action>In `changePassword`, `changeEmail` and `reauthenticate` (:491, :509, :522) replace `const { principal } = yield* CurrentUser.current` with `const { userId, sessionId } = yield* CurrentUser.current` and pass `userId` and `currentSessionId: sessionId` (the interface already takes `Sessions.SessionId`, :330, :374, :395). Remove `Users`/`Sessions` imports only if nothing else in the file uses them (both are used elsewhere today; check with rg).</action>
    <verify><automated>npx vitest run packages/password/test && pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -n 'principal' packages/password/src/Password.ts` shows no handler line between 485 and 530 (baseline: 9 lines in that range).</acceptance_criteria>
    <done>Password suite green.</done>
  </task>
</tasks>

<changeset>Create `.changeset/current-user-caller-passkey.md` (one changeset per ticket, so parallel tickets never edit the same file) with `"@awthaq/passkey": minor` and `"@awthaq/password": patch`, one sentence on what changed, and the line `Migration: PasskeyShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).`</changeset>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular</verification>

<success_criteria>A1 gate for passkey+password = 0 (baseline 12); A4 gate for passkey = 0 (baseline 2); passkey and password suites green; no test deleted.</success_criteria>

## Comments
Result: passkey/password handlers destructure userId/sessionId; PasskeyShape and requireFreshSession take Sessions.SessionId; both internal re-brands gone. Passkey, password, webhooks suites green (827 tests); tsc -b and test tsc clean for these packages. No test edits needed in passkey/password.
