# Testing Harness
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-25 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added an honest note that BEH-EA-199's redaction check is not yet mechanically verifiable (CCR-EA-002) |
---

> This file describes planned behavior. No code implementing it exists yet; effect-auth is pre-implementation.

## BEH-EA-193: `TestAuth.layer` is the whole pipeline, over memory

```ts
const TestLive = TestAuth.layer(plugins)   // *.layerMemory, Mailer.layerMemory, permissive RateLimiter, HttpServer.layerServices
```

```text
REQUIREMENT: `TestAuth.layer(plugins)` MUST assemble the named plugins over
             memory repositories, `Mailer.layerMemory`, a permissive
             `RateLimiter`, and `HttpServer.layerServices`; a test using it
             MUST NOT need a real database, a real mailer, or a real network
             listener.
```

PRD §19 and `usage-examples-v4.md` §22.1 fix this exact composition. Running the whole pipeline over in-memory ports rather than mocking individual services is what lets a test exercise real plugin composition — the actual `Auth.make` graph the application will run — while remaining fast and hermetic; a test failure is then a fact about the plugin wiring, not an artifact of a stubbed-out shortcut that diverges from production behavior.

_Previous: [BEH-EA-192](24-nextjs-ssr.md#beh-ea-192-hydratedecisions-seeds-the-client-before-first-re-decide) | Next: [BEH-EA-194](25-testing-harness.md#beh-ea-194-httpapitestgroups-runs-under-testclock)_

## BEH-EA-194: `HttpApiTest.groups` runs under `TestClock`

```ts
const makeClient = HttpApiTest.groups(AuthApi, ["password", "session"])
yield* TestClock.adjust("8 days")
const err = yield* client.session.current().pipe(Effect.flip)
assert.strictEqual(err._tag, "Unauthenticated")
```

```text
REQUIREMENT: A whole-pipeline HTTP test asserting time-dependent behavior
             (idle expiry, token TTL, rate-limit windows) MUST advance time via
             `TestClock`, never via a real `sleep`; the test suite MUST be able
             to assert an eight-day expiry without taking eight days.
```

`usage-examples-v4.md` §22.1 shows this directly for session idle expiry. `TestClock` is what makes every duration-based invariant in the spec — session lifetimes (file 07), verification token TTLs (file 08), passkey challenge expiry (file 17), rate-limit windows (file 14) — testable in milliseconds of wall-clock time rather than requiring the test runner to actually wait out the real duration.

_Previous: [BEH-EA-193](25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory) | Next: [BEH-EA-195](25-testing-harness.md#beh-ea-195-layermock-for-partial-doubles)_

## BEH-EA-195: `Layer.mock` for partial doubles

```ts
Layer.provide(Layer.mock(Mailer, { send: () => Effect.void }))
```

```text
REQUIREMENT: A test needing to override only one method of a multi-method
             port MUST use `Layer.mock` rather than hand-writing a full
             replacement implementation of the port's interface.
```

`usage-examples-v4.md` §17 shows this as the lighter-weight alternative to `Mailer.layerMemory` when a test only cares that `send` was called with the right arguments and does not need the recording/inspection behavior the memory implementation provides. Keeping a full custom implementation is more code to maintain and drift out of sync with the port's real interface as it grows; `Layer.mock` only ever specifies the methods a given test actually exercises.

_Previous: [BEH-EA-194](25-testing-harness.md#beh-ea-194-httpapitestgroups-runs-under-testclock) | Next: [BEH-EA-196](25-testing-harness.md#beh-ea-196-qaditestlayer-and-subjectwith-for-authorization-unit-tests)_

## BEH-EA-196: `qadiTestLayer` and `subjectWith` for authorization unit tests

```ts
const owner = subjectWith({ id: "user:u1", permissions: [project.delete] })
assert.isTrue(yield* check(canDeleteProject, { resource }).pipe(Effect.provide(currentSubjectLayer(owner))))
```

```text
REQUIREMENT: A test asserting a policy's behavior in isolation MUST construct
             its subjects with `subjectWith` and provide qadi's services via
             `qadiTestLayer` from `@qadi/testing`; it MUST NOT stand up the
             full HTTP pipeline merely to test a policy's logic.
```

`usage-examples-v4.md` §22.2 and `usage-qadi.md` §15 both use this shape for policy-level tests (`only the owner may delete`), separate from the HTTP-level test in BEH-EA-197. Testing the policy directly, without going through `TestAuth.layer` and an HTTP client, keeps a policy-logic test fast and keeps its failure message about the policy rather than about an incidental HTTP or session-wiring detail.

_Previous: [BEH-EA-195](25-testing-harness.md#beh-ea-195-layermock-for-partial-doubles) | Next: [BEH-EA-197](25-testing-harness.md#beh-ea-197-testauthsigninas-drives-http-level-authorization-tests)_

## BEH-EA-197: `TestAuth.signInAs` drives HTTP-level authorization tests

```ts
layer(Layer.mergeAll(TestAuth.layer([Password, Roles]), AuthzLive, QadiLive, HttpServer.layerServices))("admin", (it) => {
  it.effect("stats needs the admin role", () => Effect.gen(function*() {
    const client = yield* makeClient
    yield* TestAuth.signInAs({ email: "ops@acme.com", roles: ["member"] })
    const err = yield* client.admin.stats().pipe(Effect.flip)
    assert.strictEqual(err._tag, "Forbidden")
  }))
})
```

```text
REQUIREMENT: A test asserting that `RequirePermission` or `AuthorizedSubject`
             correctly blocks or allows a real HTTP request MUST run through
             `TestAuth.signInAs` against the whole `AuthzLive`/`QadiLive`
             pipeline, not by calling a handler function directly with a
             fabricated principal.
```

`usage-qadi.md` §15 shows exactly this composition, testing the bridge itself (a member without the admin role gets `Forbidden` from the real `RequirePermission` middleware), which a direct handler call would bypass entirely. This is the test-level expression of `usage-qadi.md` §16's "one evaluation path": the test must exercise the same middleware chain a real request goes through, or it is not actually testing the bridge.

_Previous: [BEH-EA-196](25-testing-harness.md#beh-ea-196-qaditestlayer-and-subjectwith-for-authorization-unit-tests) | Next: [BEH-EA-198](25-testing-harness.md#beh-ea-198-runplugincontracttests-checks-manifest-legality-and-migrations)_

## BEH-EA-198: `runPluginContractTests` checks manifest legality and migrations

```ts
runPluginContractTests(invite, { options: [{}, { ttl: "1 hour" }], host: [password()] })
// manifest legality · group id uniqueness · table prefixes · migration determinism · missing host dep → E_PLUGIN_MISSING_DEP
```

```text
REQUIREMENT: `runPluginContractTests` MUST assert, for every option
             combination supplied, that the plugin's manifest is legal, its
             group ids are unique, its tables carry its own prefix, its
             migrations apply deterministically, and that a missing declared
             dependency produces `E_PLUGIN_MISSING_DEP`; a third-party plugin
             MUST be able to run this suite without effect-auth's own source.
```

PRD §19 and `usage-examples-v4.md` §22.3 name this as the mechanism that makes plugin authorship self-certifying: a plugin author runs one function against their own plugin, across the option matrix they support, and gets the same checks every official plugin (`Password`, `OAuth`, `Passkey`, and the rest) must also pass — there is no separate, weaker bar for third-party plugins.

_Previous: [BEH-EA-197](25-testing-harness.md#beh-ea-197-testauthsigninas-drives-http-level-authorization-tests) | Next: [BEH-EA-199](25-testing-harness.md#beh-ea-199-redaction-and-contract-hash-stability)_

## BEH-EA-199: Redaction and contract-hash stability

```text
REQUIREMENT: `runPluginContractTests` MUST assert that no `Redacted` value
             reaches a span or an event the plugin emits, and that changing
             the plugin's options does not change its contract's hash; either
             violation MUST fail the contract test, not merely a code review.
```

PRD §19's list names both checks explicitly: "no `Redacted` value reaches spans or events" and "options-do-not-change-contract-hash." The first is the automated version of PRD §18's redaction requirement (passwords and tokens travel as `Redacted`) — checked mechanically rather than trusted to manual review of every plugin's logging call sites. The second is the automated version of ADR-EA-011's promise that configuration never changes a contract: a plugin whose `minLength` option accidentally altered its declared schema would fail this check immediately.

Stated honestly: the first check is not mechanically verifiable today, and this specification should not imply otherwise. Asserting "no `Redacted` value reaches a span or event" requires instrumentation this project has not built — a tracer/logger interceptor capable of inspecting every span attribute and every log-event payload a plugin's code emits at test time, and failing the contract-test run when one of them contains a `Redacted`-wrapped value. No such interceptor exists yet in any package, and none is described as already built anywhere else in this specification; it is a planned capability of the eventual `runPluginContractTests` harness (per the gate table in `spec/process/definitions-of-done.md`, itself listed as "Not yet — planned for M6"), not a currently-verifiable property. Until that instrumentation exists, "no `Redacted` value reaches a span or event" remains a design requirement plugin authors must satisfy by discipline and code review, the same way every other invariant in this pre-implementation specification is a design commitment rather than a proven fact (see the banner in `spec/invariants.md`).

_Previous: [BEH-EA-198](25-testing-harness.md#beh-ea-198-runplugincontracttests-checks-manifest-legality-and-migrations) | Next: [BEH-EA-200](25-testing-harness.md#beh-ea-200-veto-only-in-veto-points-and-observer-isolation)_

## BEH-EA-200: Veto only in veto points, and observer isolation

```text
REQUIREMENT: `runPluginContractTests` MUST assert that a hook tap on an
             observe point cannot abort the operation it observes, and that an
             observer's failure does not propagate to fail that operation;
             only a veto-point tap may abort or amend.
```

PRD §19 and PRD §9.3's hook-point taxonomy ("veto (abort or amend), observe (fail-isolated)") together define the property this check enforces: `AfterSignUp` is an observe point, so a subscriber that throws while sending a welcome email must not cause sign-up itself to fail — `usage-examples-v4.md` §14's `Welcome` tap is documented as unable to "fail sign-in even if it throws." The contract test exists so a plugin author gets this guarantee checked automatically rather than having to reason about it by hand every time a new hook tap is added.

_Previous: [BEH-EA-199](25-testing-harness.md#beh-ea-199-redaction-and-contract-hash-stability) | Next: [BEH-EA-201](26-cli.md#beh-ea-201-doctor-checks-link-config-and-insecure-defaults)_
