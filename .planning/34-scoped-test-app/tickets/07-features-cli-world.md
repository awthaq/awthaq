---
plan: 34-scoped-test-app
ticket: 07
title: Features CLI World over `TestAuth.listen`; delete `SessionServer.ts`
type: execute
wave: 4
depends_on: [05]
files_modified:
  - features/step-definitions/SessionServer.ts
  - features/step-definitions/CliWorld.ts
autonomous: true
requirements: [REQ-EA-1552]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "features/08-tooling/26-cli passes with the server built by TestAuth.listen in the scenario's scope"
    - "SessionServer.ts no longer exists"
    - "CliWorld keeps no Scope.makeUnsafe for the server"
  artifacts:
    - path: features/step-definitions/CliWorld.ts
      provides: "ensureServer over TestAuth.listen; issue/decide/requests helpers"
  key_links:
    - from: "CliWorld.ensureServer"
      to: "TestAuth.listen"
      via: "the World's lazyApp (or the scenario scope); AWTHAQ_BASE_URL = app.url"
---
Status: done (uncommitted)
Blocked by: 05

<objective>
Delete `features/step-definitions/SessionServer.ts` (180 lines, a near-copy of the cli `TestServer`) and start the CLI scenarios' server with `TestAuth.listen` in the World (PLAN §2.6). The request log the Thens read (`CliSteps.ts:1314,1418`) is `app.requests()`.

Purpose: one less hand-built middleware stack; the World stops managing its own scopes for the server.

Output: `SessionServer.ts` deleted; `CliWorld.ensureServer` ~25 lines.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.6, §4.2 M5)
@features/step-definitions/SessionServer.ts
@features/step-definitions/CliWorld.ts (:285-307 ensureServer, the World's server/scopes cells)
@features/step-definitions/CliSteps.ts (:1288 device false, :1314, :1418 requests; :355 decide)
@packages/test/src/TestAuth.ts (listen, lazyApp)
</context>

<tasks>
<task type="auto">
  <name>Task 1: ensureServer over TestAuth.listen</name>
  <files>features/step-definitions/CliWorld.ts</files>
  <read_first>features/step-definitions/CliWorld.ts, features/step-definitions/SessionServer.ts:93-180, features/step-definitions/CliSteps.ts:1280-1420</read_first>
  <action>Move the `SessionServer` interface (`baseUrl`, `issue`, `decide`, `requests`) into `CliWorld.ts`, unchanged. `requests` stays an `Effect` of the log: `Effect.sync(() => app.requests())`.

Make the World's `server` cell a `TestAuth.lazyApp<{ device: boolean }, SessionServer>` created in `WorldLive` with `name: "CliWorld"`. Its `build` acquires `TestAuth.listen` over the device-authorization composition (`TestAuth.layer(Auth.make([DeviceAuthorization.DeviceAuthorization]), { services: DeviceAuthorization.config({ verificationUri: "https://app.test/device" }) })`), or over `Auth.make([Password.Password])` with `Password.config({})` and `TestAuth.httpClient.noBreach` when `device` is false. It returns the `SessionServer` with:
- `baseUrl: app.url`;
- `issue` and `decide` reimplemented through `app.run` exactly as `SessionServer.ts:150-178` did.

`ensureServer(options)` calls `configure((current) => ({ device: options?.device !== false }))` only when not yet built. Otherwise, for a different `device` value, it calls `replace`; read the existing `CliSteps.ts:1288` usage to keep the semantics. Then it does `yield* world.server.get` and `setEnv({ AWTHAQ_BASE_URL: server.baseUrl })`.

Delete the `Scope.makeUnsafe()` and the `scopes` bookkeeping that only served the server. If `world.scopes` has other users, keep it for them.</action>
  <verify><automated>pnpm --filter @awthaq/features exec vitest run features/08-tooling/26-cli.steps.test.ts</automated></verify>
  <acceptance_criteria>The feature passes with the same scenario count as before (record both). grep -c 'Scope.makeUnsafe' features/step-definitions/CliWorld.ts is one less than at HEAD (baseline: 1).</acceptance_criteria>
  <done>CLI scenarios run against the derived composition.</done>
</task>

<task type="auto">
  <name>Task 2: delete SessionServer.ts</name>
  <files>features/step-definitions/SessionServer.ts</files>
  <read_first>grep -rn 'SessionServer' features</read_first>
  <action>Delete the file with `git rm`. Fix any import that still names it: only `CliWorld.ts` imported it at HEAD. Run the leak guard line for `26-cli`.</action>
  <verify><automated>test ! -e features/step-definitions/SessionServer.ts && pnpm --filter @awthaq/features exec vitest run features/08-tooling/26-cli.steps.test.ts 2>&1 | grep '\[leak-guard\]'</automated></verify>
  <acceptance_criteria>The file is gone; the guard line reads apps=0 sqlClients=0.</acceptance_criteria>
  <done>One hand-built socket server fewer.</done>
</task>
</tasks>

<threat_model>
## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-34-05 | Information disclosure | scenario socket | low | mitigate | inherited from T-34-01: `listen` binds 127.0.0.1 only and the scenario scope closes it |
</threat_model>

<verification>
pnpm typecheck && pnpm lint && pnpm knip && pnpm circular && pnpm test:bdd
</verification>

<success_criteria>
`26-cli` green with the same scenario count; `SessionServer.ts` deleted; guard 0/0.
</success_criteria>

## Comments
Result: 26-cli green (79 passed, 13 skipped), leak-guard apps=0 sqlClients=0. `world.server` Ref<Option<SessionServer>> is kept (CliSteps reads it, outside this ticket); `ensureServer` fills it from a new `serverApp` lazyApp cell (`alignStepClock: true`, same clock mismatch as ticket 06). `Scope.makeUnsafe`/`scopes` removed. `SessionServer.ts` NOT deleted: the delete was refused by the permission classifier; nothing imports it now. Remove it with `git rm features/step-definitions/SessionServer.ts`.
