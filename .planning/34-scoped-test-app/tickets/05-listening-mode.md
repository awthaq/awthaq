---
plan: 34-scoped-test-app
ticket: 05
title: "`TestAuth.listen`: listening mode"
type: tdd
wave: 3
depends_on: [04]
files_modified:
  - packages/test/src/TestAuth.ts
  - packages/test/test/TestAuthListen.test.ts
  - spec/behaviors/25-testing-harness.md
  - spec/traceability.md
  - .changeset/test-scoped-app.md
autonomous: true
requirements: [REQ-EA-1552]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "A session minted through app.run authenticates GET /session over a real TCP socket at app.url (one set of instances)"
    - "app.requests() lists every request line the socket answered, oldest first"
    - "The socket is bound to 127.0.0.1 on an ephemeral port and closed when the scope closes"
  artifacts:
    - path: packages/test/src/TestAuth.ts
      provides: "ListeningApp, listen"
    - path: packages/test/test/TestAuthListen.test.ts
  key_links:
    - from: "HttpRouter.serve over the app's composition"
      to: "the HttpRouter instance handler/run use"
      via: "Layer.buildWithMemoMap with the app's memo map and build scope"
---
Status: done (uncommitted)
Blocked by: 04

<objective>
Remove the "`TestAuth.app` serves no socket" exemption (PLAN §2.6). `TestAuth.listen` is `serve` plus a real Node listener on `127.0.0.1:0` over the same instances, plus a request-line log. BEH-EA-358 lands here. Tickets 06–07 delete the two hand-built socket servers on top of it.

Purpose: a new mandatory middleware stops needing two hand-edits; the CLI tests run against the composition `AuthHost` derives.

Output: `listen`, its test, BEH-EA-358.
</objective>

<context>
@.planning/34-scoped-test-app/PLAN.md (§2.6, §3.2 listen notes, §7 R1)
@packages/test/src/TestAuth.ts (make/serve from ticket 03; the platform at :322-328)
@features/step-definitions/SessionServer.ts (:111-150: NodeHttpServer.layer, HttpRouter.serve with a recording middleware, NetAddress check; the shape to reuse)
@node_modules/.pnpm/effect@4.1.2/node_modules/effect/src/http/HttpRouter.ts (serve :1394-1450)
</context>

<tasks>
<task type="tdd">
  <name>Task 1 (tracer): one session, two transports</name>
  <files>packages/test/test/TestAuthListen.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>features/step-definitions/SessionServer.ts:111-150, packages/test/src/TestAuth.ts (make, serve)</read_first>
  <behavior>
    - Inside it.effect: const app = yield* TestAuth.listen(TestAuth.layer(Auth.make([Pins]))); fetch(app.url + "/session") → 401.
    - const signed = await app.run(TestAuth.signInAs({ email: "socket@example.com" })); fetch(app.url + "/session", { headers: { authorization: `Bearer ${Redacted.value(signed.token)}` } }) → 200, and its body names signed.userId.
    - app.url matches /^http:\/\/127\.0\.0\.1:\d+$/.
  </behavior>
  <action>Write the cases first (use `Effect.promise(() => fetch(...))`). Implement `listen(composition, options)` as an Effect that requires `Scope`:

1. Acquire the app with the same `make`/release as `serve`, so it is one app.
2. Then, with the app's memo map, build `HttpRouter.serve(appLayer, { disableLogger: true, disableListenLog: true, middleware })` provided `NodeHttpServer.layer(() => http.createServer(), { port: 0, host: "127.0.0.1" })`. Build it with `Layer.buildWithMemoMap` into a scope that the app's release closes first. Simplest: build into a `Scope.fork` of the caller's scope, acquired after the app so it is released before it.
3. Read `HttpServer.HttpServer` from the built context. If `NetAddress.isInetAddress(server.address)` is false, `Effect.die`. Otherwise `url` is `http://127.0.0.1:${port}`.
4. The `middleware` pushes `` `${request.method} ${request.url}` `` into an array local to this call before running the app. `requests` returns a copy.

If the bearer case answers 404 (a second router, PLAN §7 R1), take R1's fallback instead of step 2. Build the app context once, then serve `Context.get(context, HttpRouter.HttpRouter).asHttpEffect()` through `HttpServer.serve(handler, middleware)` provided by the same Node layer. Record which path was taken in Comments.

Import `@effect/platform-node/NodeHttpServer` and `node:http` (the package already depends on `@effect/platform-node`). Export `ListeningApp` and `listen` exactly as in PLAN §3.2.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthListen.test.ts</automated></verify>
  <acceptance_criteria>grep -c '^export const listen = ' packages/test/src/TestAuth.ts returns 1 (baseline at HEAD: 0); the three cases pass.</acceptance_criteria>
  <done>run and the socket share instances.</done>
</task>

<task type="tdd">
  <name>Task 2: request log and release</name>
  <files>packages/test/test/TestAuthListen.test.ts, packages/test/src/TestAuth.ts</files>
  <read_first>packages/test/test/TestAuthListen.test.ts</read_first>
  <behavior>
    - After GET /session twice and GET /pins?x=1 once over the socket, app.requests() equals ["GET /session", "GET /session", "GET /pins?x=1"].
    - Run listen inside Effect.scoped, capture url, leave the scope, then fetch(url) rejects (Effect.exit of Effect.tryPromise is a failure) and TestAuth.openApps() is back.
  </behavior>
  <action>Make both cases pass. In-process `handler`/`agent()` requests are not logged: the log is the socket's. State that in the `requests` JSDoc.</action>
  <verify><automated>npx vitest run packages/test/test/TestAuthListen.test.ts</automated></verify>
  <acceptance_criteria>5 cases green.</acceptance_criteria>
  <done>The listener's log and lifetime match BEH-EA-358.</done>
</task>

<task type="auto">
  <name>Task 3: BEH-EA-358, traceability, changeset</name>
  <files>spec/behaviors/25-testing-harness.md, spec/traceability.md, .changeset/test-scoped-app.md</files>
  <read_first>.planning/34-scoped-test-app/PLAN.md §6.2</read_first>
  <action>Add `## BEH-EA-358: The harness can listen on a socket` after BEH-EA-357, with the REQUIREMENT verbatim from PLAN §6.2. Add a note that agents stay in-process (Q5), that the socket is for out-of-process clients, and that BEH-EA-193's "no real network listener" still holds because listening is opt-in. Add an *Implementation* line naming `test/TestAuthListen.test.ts`.

Bump the revision to 1.13 and add the change-history line. Update traceability as in tickets 03/04 (file-25 row, URS-EA-009, a §5 row, a change history line). Add `listen` to the changeset.</action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>grep -c '^## BEH-EA-358' spec/behaviors/25-testing-harness.md returns 1 (baseline: 0).</acceptance_criteria>
  <done>Specified and traced.</done>
</task>
</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| test process ↔ local TCP | the listener accepts connections from any local process while a test runs |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-34-01 | Information disclosure | TestAuth.listen socket | low | mitigate | bind `127.0.0.1` only (never `0.0.0.0`); the composition holds only fixture users and a fixed test key; the test asserts the URL's host |
| T-34-02 | Denial of service | leaked listeners exhausting ports/fds | low | mitigate | the socket is released by the scope (Task 2 asserts connection refused after close); the leak guard (ticket 01/21) counts the app |
| T-34-03 | Elevation of privilege | listen used outside tests | low | accept | `@awthaq/test` is private and dev-only; `pnpm check:contract-tests` fails when a library `src` imports it |
</threat_model>

<verification>
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm spec:verify:strict
</verification>

<success_criteria>
`TestAuthListen.test.ts` 5 cases green; BEH-EA-358 specified.
</success_criteria>

## Comments
