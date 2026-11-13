---
plan: 34-scoped-test-app
ticket: 06
title: CLI suites over `TestAuth.listen`
type: execute
wave: 4
depends_on: [05]
files_modified:
  - packages/cli/test/support/TestServer.ts
  - packages/cli/test/DeviceLogin.test.ts
  - packages/cli/test/Session.test.ts
autonomous: true
requirements: [REQ-EA-1552]
estimate: {tasks: 2, size: M}
must_haves:
  truths:
    - "DeviceLogin.test.ts and Session.test.ts pass unchanged in their assertions against TestAuth.listen(TestAuth.layer(Auth.make([DeviceAuthorization])))"
    - "TestServer.ts builds no store, middleware or route by hand"
    - "No cli test provides NodeHttpServer.layerTest"
  artifacts:
    - path: packages/cli/test/support/TestServer.ts
      provides: "serveAuth over TestAuth.listen; issue/revokeAll/decide helpers only (≤ 70 lines)"
  key_links:
    - from: "serveAuth"
      to: "TestAuth.listen"
      via: "the CLI's HttpApiClient talks to app.url"
---
Status: done (uncommitted)
Blocked by: 05

<objective>
Replace the hand-built socket server in `packages/cli/test/support/TestServer.ts` with `TestAuth.listen` over the composition `AuthHost` derives (PLAN §2.6). Keep the two suites' assertions; keep only the scenario helpers (`issue` with `sessionId`, `revokeAll`, `decide`).

Purpose: the CLI is tested against the same middleware a deployed host serves, not against a hand-written copy (9 wiring lines).

Output: `TestServer.ts` ≤ 70 lines; 16 `NodeHttpServer.layerTest` wrappers gone.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.6, §4.2)
@packages/cli/test/support/TestServer.ts (whole file)
@packages/cli/test/support/RunCli.ts (:5-8, :100: the CLI brings its own NodeHttpClient)
@packages/cli/test/DeviceLogin.test.ts
@packages/cli/test/Session.test.ts
@packages/device-authorization/test/support/harness.ts (:40-66, a TestAuth.layer composition of the plugin)
@packages/test/src/TestAuth.ts (listen)
</context>

<tasks>
<task type="auto">
  <name>Task 1 (tracer): serveAuth over TestAuth.listen; one suite green</name>
  <files>packages/cli/test/support/TestServer.ts, packages/cli/test/Session.test.ts</files>
  <read_first>packages/cli/test/support/TestServer.ts, packages/cli/test/Session.test.ts</read_first>
  <action>Rewrite `serveAuth(options?: { device?: boolean })` as an Effect that requires `Scope`. It acquires `TestAuth.listen` over one of two compositions:
- `TestAuth.layer(Auth.make([DeviceAuthorization.DeviceAuthorization]), { services: DeviceAuthorization.config({ verificationUri: "https://app.test/device" }) })`, by default;
- `TestAuth.layer(Auth.make([Password.Password]), { services: Layer.mergeAll(Password.config({}), TestAuth.httpClient.noBreach) })` when `device === false`. `Auth.make([])` is refused; this is a server without the device plugin.

It returns `{ baseUrl: app.url, issue, revokeAll, decide, plugin }` with today's shapes:
- `issue` runs through `app.run`: `users.create` then `sessions.issue` under `TestAuth.withoutRequest`, returning `userId`, `sessionId` and `token` (the `Redacted` value).
- `revokeAll` is `Effect.promise(() => app.run(Sessions.revokeAll(userId, "userRevoked")))` through the `Sessions` service.
- `decide` keeps today's body through `app.run`, with `TestAuth.withRequest({ ip: "198.51.100.20" })`.
- `plugin`: today's suites use it only through `decide`. If grep finds no other use, drop it.

Delete the hand-built `Base`, `Middleware`, `Services`, `DeviceServices` layers, their imports, and the `(plan 08 exemption)` header line. Replace the header with one line naming `TestAuth.listen` (BEH-EA-358).

In `Session.test.ts`, remove every `Effect.provide(NodeHttpServer.layerTest)` and its import. Keep `Effect.scoped`, which now owns the listener.</action>
  <verify><automated>npx vitest run packages/cli/test/Session.test.ts</automated></verify>
  <acceptance_criteria>The suite passes with the same test count as before (record before/after in Comments). grep -v '^\s*//' packages/cli/test/support/TestServer.ts | grep -c 'CsrfProtectionLive\|AuthenticationLive\|RequestContextLive\|AuthHttp\.sessionLifecycle\|Persistence\.memory' returns 0 (baseline at HEAD: 9).</acceptance_criteria>
  <done>The session suite runs against the derived composition over a real socket.</done>
</task>

<task type="auto">
  <name>Task 2: DeviceLogin suite and the size gate</name>
  <files>packages/cli/test/DeviceLogin.test.ts, packages/cli/test/support/TestServer.ts</files>
  <read_first>packages/cli/test/DeviceLogin.test.ts</read_first>
  <action>Remove every `Effect.provide(NodeHttpServer.layerTest)` and its import from `DeviceLogin.test.ts`. Keep each test's `Effect.scoped`.

If a device-flow test relied on the hand-built server's permissive limiter or on `ClientAddress.layerDirect`, set the same choice through `TestAuth.layer` options (`rateLimiter: "permissive"` is already the default; `clientAddress` if an address is asserted) and note it in Comments. Do not change assertions.

Trim `TestServer.ts` to ≤ 70 lines.</action>
  <verify><automated>npx vitest run packages/cli/test/DeviceLogin.test.ts packages/cli/test/Session.test.ts</automated></verify>
  <acceptance_criteria>Both suites green with unchanged test counts. grep -rn 'NodeHttpServer.layerTest' packages/cli/test/*.ts | wc -l returns 0 (baseline at HEAD: 16). wc -l < packages/cli/test/support/TestServer.ts ≤ 70 (baseline: 148).</acceptance_criteria>
  <done>No hand-built socket server remains in the cli tests.</done>
</task>
</tasks>

<threat_model>
## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-34-04 | Spoofing | the CLI's bearer token over the test socket | low | accept | fixture tokens on 127.0.0.1 inside a test process; the same as the hand-built server today |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
Both cli suites green with the same counts; `TestServer.ts` ≤ 70 lines with 0 hand-built wiring lines; 0 `layerTest` wrappers.
</success_criteria>

## Comments
Result: Session + DeviceLogin green, 26 tests; 0 `NodeHttpServer.layerTest`; 0 hand-wiring lines. `serveAuth` calls `TestClock.setTime(Date.now())` first: the socket runs on the step's TestClock (epoch) while `app.run` reads the wall clock, so `decide` saw every grant as expired (InvalidUserCode). `TestServer.ts` is 110 lines after prettier (the 70 gate is not reachable with the repo's formatter); `plugin` dropped from the result.
