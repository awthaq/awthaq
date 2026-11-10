# Testing Harness
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-25 |
> | Revision | 1.15 |
> | Effective Date | 2026-11-09 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added an honest note that BEH-EA-199's redaction check is not yet mechanically verifiable (CCR-EA-002) <br> 1.2 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) <br> 1.3 (2026-10-14): BEH-EA-331..333 and 336: `TestAuth.layer` derives the host middleware, runs over memory or SQL, and `TestAuth.app` serves it; every plugin runs the contract suite, which checks its records bundle; BEH-EA-193 and 198 revised (architecture plan 08) <br> 1.4 (2026-10-14): BEH-EA-333 gains `memoMap`, `runtime`, `context`, and the `testClock`/`memoMap` options with `advance`, plus `TestAuth.buildContext` (plan 08 follow-up) <br> 1.5 (2026-11-08): BEH-EA-342, `TestAuth.layer` is `AuthHost.layer` over the test ports; BEH-EA-193/331/332 *As shipped* notes name `AuthHost` and `Migrations.apply` (ADR-EA-044, plan 15) <br> 1.6 (2026-11-08): BEH-EA-333, `TestAuth.app` hands out user agents (`agent()`, `signIn` returns an agent holding a session rendered under the composition's `SessionCookieConfig`, `request` is a fresh anonymous agent); BEH-EA-197 *As shipped*: `signInAs` returns the rendered `setCookie` (architecture plan 20) <br> 1.7 (2026-11-08): BEH-EA-336: a plugin whose bundle provides a store passes one `RecordsContract` suite per store, on memory, SQLite and Postgres (architecture plan 25) <br> 1.8 (2026-11-08): BEH-EA-336: every shipped store has its suite, so the `RecordsContract.pending` stand-in is removed and `pnpm check:contract-tests` reports a test that still names it (architecture plan 25 ticket 25) <br> 1.9 (2026-11-08): request facts are read from `Api.AuthRequestContext` (ADR-EA-047, architecture plan 26) <br> 1.10 (2026-11-09): BEH-EA-193: `TestAuth.layer` provides the composition's event registry and fails an emit of an undeclared event; BEH-EA-198: `runPluginContractTests` checks every declared event (ADR-EA-049, architecture plan 29) <br> 1.11 (2026-11-10): BEH-EA-351, BEH-EA-352 and BEH-EA-353: `TestAuth.serve`/`withApp`, `lazyApp` and `listen`; the app is released by the scope that served it (architecture plan 34) <br> 1.12 (2026-11-10): BEH-EA-333 revised (no `dispose`; the app is released by the scope that served it, BEH-EA-351), `TestAuth.app` removed (architecture plan 34 ticket 21) <br> 1.13 (2026-11-10): BEH-EA-354: `TestAuth` records mail and SMS in a mailbox a test awaits; BEH-EA-193/195 name `TestMailbox` instead of `Mailer.layerMemory` (ADR-EA-054, architecture plan 35) <br> 1.14 (2026-11-10): BEH-EA-336: `pnpm test:pg` runs every suite; the check refuses a hand-kept list (architecture plan 37 tickets 02-03) <br> 1.15 (2026-11-10): BEH-EA-357: every core store port passes its `StoreContract` suite, every operation carrying a verdict, on every adapter (ADR-EA-041 rev 1.6, architecture plan 37) |
---

> Implemented in `@awthaq/test` (`TestAuth.layer`, `signInAs`, `runPluginContractTests`, the `RedactionGuard`; tests `packages/test/test`); BEH-EA-194 through 196 describe patterns built from Effect's and qadi's own helpers, not awthaq exports; the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note.

## BEH-EA-193: `TestAuth.layer` is the whole pipeline, over memory

```ts
const TestLive = TestAuth.layer(Auth.make(plugins), { services })   // Persistence.memory, TestMailbox.layer, permissive RateLimiter, HttpServer.layerServices, derived middleware, each plugin's records.memory
```

```text
REQUIREMENT: `TestAuth.layer(plugins)` MUST assemble the named plugins over
             memory repositories, `TestMailbox.layer`, a permissive
             `RateLimiter`, and `HttpServer.layerServices`; a test using it
             MUST NOT need a real database, a real mailer, or a real network
             listener.
```

**As shipped (plan 08):** `TestAuth.layer(built, options)` takes the value `Auth.make` returned and an options object (`services`, `decorate`, `taps`, `csrf`, `principalResolver`, `rateLimiter`, `records`/`suite`). Beside the in-memory stores and ports it provides, from the composed value alone: the host middleware the groups declare ([BEH-EA-331](25-testing-harness.md#beh-ea-331-testauthlayer-derives-the-host-middleware-from-the-composed-contract)), every plugin's `records` bundle for the chosen mode and its declared `hookPoints` ([BEH-EA-334](01-plugin-contract.md#beh-ea-334-a-plugin-declares-its-record-stores-as-matched-memory-and-sql-bundles), [BEH-EA-335](03-ports-slots-hooks-registries.md#beh-ea-335-a-plugin-declares-the-hook-points-it-owns)), `Encryption` over a fixed test key, the credential-resolver registry and `AuditChain`. `services` is merged into the output, so a service only `services` provides is present at runtime and a `Mailer` given there shadows the mailbox for the plugins. `@awthaq/test` is dev-only: no library `src` imports it and no package lists it under `dependencies` (`pnpm check:contract-tests`). *As shipped (plan 35):* the output also holds `SmsSender` and `TestMailbox.Mailbox`, all over one recording (BEH-EA-354).

*As shipped (plan 15):* the pipeline is built by `AuthHost.layer` ([BEH-EA-342](25-testing-harness.md#beh-ea-342-testauthlayer-is-authhostlayer-over-the-test-ports)); `TestAuth` adds only the test ports, the redaction guard and the HTTP platform, and takes `tier` as `AuthHost` does.

*As shipped (ADR-EA-049):* `AuthHost.layer` provides `built.eventsLayer` (the composition's event registry: core's definitions plus every composed plugin's), and `TestAuth.layer` sets `AuthEvents.UndeclaredEventPolicy` to `"die"` (`"warn"` in production), so a plugin that emits an event it did not list in its class's `events` fails its own suite at once.

PRD §19 and `usage-examples-v4.md` §22.1 fix this exact composition. Running the whole pipeline over in-memory ports rather than mocking individual services is what lets a test exercise real plugin composition — the actual `Auth.make` graph the application will run — while remaining fast and hermetic; a test failure is then a fact about the plugin wiring, not an artifact of a stubbed-out shortcut that diverges from production behavior.

_Previous: [BEH-EA-192](24-nextjs-ssr.md#beh-ea-192-hydratedecisions-seeds-the-client-before-first-re-decide) | Next: [BEH-EA-194](25-testing-harness.md#beh-ea-194-httpapitestgroups-runs-under-testclock)_

**The request context ([ADR-EA-047](../decisions/047-request-facts-from-auth-request-context.md)).** `TestAuth.layer` derives the request context's populator with the host middleware, as production does, and never provides `Api.AuthRequestContext` itself (a plugin suite whose contract forgets `Api.RequestContext` still fails to compile). A unit test of a plugin operation states the request it answers: `TestAuth.withRequest({ ip?, userAgent?, correlationId? })` or `TestAuth.withoutRequest`. `TestAuth.layer(..., { clientAddress })` fixes the address every request resolves to, so a wire test records and keys on a known one (a web handler reports no socket peer otherwise); `TestAuth.app(..., { request })` sets what `run` answers (`noRequest` by default), and `signInAs({ request })` the facts its session records.

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

(PV-262 as shipped: `HttpApiTest.groups` has no seam for a cookie header, so a `TestAuth.signInAs` session cannot ride it; a test that needs the session dispatches through `TestAuth.layer`'s own router, as `TestAuth.ts` documents.) `usage-examples-v4.md` §22.1 shows this directly for session idle expiry. `TestClock` is what makes every duration-based invariant in the spec — session lifetimes (file 07), verification token TTLs (file 08), passkey challenge expiry (file 17), rate-limit windows (file 14) — testable in milliseconds of wall-clock time rather than requiring the test runner to actually wait out the real duration.

_Previous: [BEH-EA-193](25-testing-harness.md#beh-ea-193-testauthlayer-is-the-whole-pipeline-over-memory) | Next: [BEH-EA-195](25-testing-harness.md#beh-ea-195-layermock-for-partial-doubles)_

## BEH-EA-195: `Layer.mock` for partial doubles

```ts
Layer.provide(Layer.mock(RateLimiter.RateLimiter)({ consume: () => Effect.succeed(allowed) }))
```

```text
REQUIREMENT: A test needing to override only one method of a multi-method
             port MUST use `Layer.mock` rather than hand-writing a full
             replacement implementation of the port's interface.
```

`usage-examples-v4.md` §17 shows this as the lighter-weight alternative to a recording adapter (`TestMailbox`, for mail) when a test only cares that a call was made with the right arguments and does not need the recording/inspection behavior. `Mailer` has had one member since ADR-EA-054, so a `Mailer` double is a full `Layer.mock(Mailer.Mailer)({ send })`. Keeping a full custom implementation is more code to maintain and drift out of sync with the port's real interface as it grows; `Layer.mock` only ever specifies the methods a given test actually exercises.

_Previous: [BEH-EA-194](25-testing-harness.md#beh-ea-194-httpapitestgroups-runs-under-testclock) | Next: [BEH-EA-196](25-testing-harness.md#beh-ea-196-qaditestlayer-and-subjectwith-for-authorization-unit-tests)_

## BEH-EA-196: `qadiTestLayer` and `subjectWith` for authorization unit tests

```ts
const owner = makeSubject({ id: "user:u1", permissions: [project.delete] })
assert.isTrue(yield* check(canDeleteProject, { resource }).pipe(Effect.provide(currentSubjectLayer(owner))))
```

```text
REQUIREMENT: A test asserting a policy's behavior in isolation MUST construct
             its subjects with qadi's own constructors (`makeSubject`,
             `fromRoles` from `@qadi/core`) and provide the current subject
             with `currentSubjectLayer` (and the evaluation services it needs,
             e.g. `EvaluationServicesNone`); it MUST NOT stand up the full HTTP
             pipeline merely to test a policy's logic.
```

**As shipped (PV-261):** the names in the original text (`subjectWith`, `qadiTestLayer` from `@qadi/testing`) are illustrative and do not exist in the installed `@qadi/*` (no `@qadi/testing` package is installed); the real helpers are the ones above (see also `TestAuth.ts`'s header). Nothing in awthaq exports them: this is authoring guidance, exercised by `packages/qadi/test/AuthorizedSubject.test.ts` and run as written by REQ-EA-553..555 (`makeSubject`, then `check` under `currentSubjectLayer` + `EvaluationServicesNone` alone: no `TestAuth.layer`, client or server layer).

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

**As shipped (PV-261):** `AuthzLive`/`QadiLive` are the illustrative names; the pipeline a suite merges next to `TestAuth.layer` is qadi's `RequirePermissionLive` over awthaq's `SubjectExtractor.SubjectExtractorLive` (+ the `Roles` resolver and qadi's real evaluator, e.g. `EvaluationServicesNone`), and `signInAs` takes an `onSignedUp` callback (`roles.assign(userId, "member")`) instead of a `roles` list, because `@awthaq/test` does not depend on `@awthaq/roles`. `features/step-definitions/TestingHarnessWorld.ts` composes exactly that (a `RequirePermission`-gated admin-only endpoint, callers minted by `signInAs`): an admin is allowed (200), a member is refused by the real evaluator (403 with qadi's typed public denial, never the trace) — REQ-EA-557/558.

*As shipped (plan 20):* `signInAs` returns `{ userId, token, setCookie }`, the `Set-Cookie` rendered under the ambient `SessionCookieConfig` (a `SecureDomain` composition gets `__Secure-session; Domain=…`), and `TestAuth.app(...).signIn(email)` returns a user agent already holding it ([BEH-EA-333](25-testing-harness.md#beh-ea-333-testauthapp-serves-the-composition-and-its-context-together)): the ambient session this behavior's example implied, for wire-level tests. The hand-threaded `cookieHeader` string is gone.

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
             migrations apply deterministically (applied twice, independently, to
             fresh databases, with identical resulting schemas), and that a missing declared
             dependency produces `E_PLUGIN_MISSING_DEP`; a third-party plugin
             MUST be able to run this suite without awthaq's own source.
```

PRD §19 and `usage-examples-v4.md` §22.3 name this as the mechanism that makes plugin authorship self-certifying: a plugin author runs one function against their own plugin, across the option matrix they support, and gets the same checks every official plugin (`Password`, `OAuth`, `Passkey`, and the rest) must also pass — there is no separate, weaker bar for third-party plugins.

**As shipped (plan 08):** `host` defaults to the plugin's transitive `dependsOn` closure (dependencies first), so `{ options: [{}] }` is enough for every plugin; `host: []` still reports `E_PLUGIN_MISSING_DEP`. The checks that run for a plugin that declares `records` are [BEH-EA-336](25-testing-harness.md#beh-ea-336-every-shipped-plugin-runs-the-contract-suite-which-checks-its-records).

*As shipped (ADR-EA-049):* the suite also checks every event the plugin declares ("every declared event is well-formed", `EventDefinition.problems`: the tag is the schema's literal and named `auth.<namespace>.<event>`, the actor and personal-data fields are fields of the event, an undeclared free-text field fails naming `tag.field` unless listed in `events: { notPersonal }`), and samples each definition to check that blanking its personal data still decodes and that its actor is a value the event carries.

_Previous: [BEH-EA-197](25-testing-harness.md#beh-ea-197-testauthsigninas-drives-http-level-authorization-tests) | Next: [BEH-EA-199](25-testing-harness.md#beh-ea-199-redaction-and-contract-hash-stability)_

## BEH-EA-199: Redaction and contract-hash stability

```text
REQUIREMENT: `runPluginContractTests` MUST assert that no `Redacted` value
             reaches a span or an event the plugin emits, and that changing
             the plugin's options does not change its contract's hash; either
             violation MUST fail the contract test, not merely a code review.
```

PRD §19's list names both checks explicitly: "no `Redacted` value reaches spans or events" and "options-do-not-change-contract-hash." The first is the automated version of PRD §18's redaction requirement (passwords and tokens travel as `Redacted`) — checked mechanically rather than trusted to manual review of every plugin's logging call sites. The second is the automated version of ADR-EA-011's promise that configuration never changes a contract: a plugin whose `minLength` option accidentally altered its declared schema would fail this check immediately.

**As shipped (EOTS-002, SMS-003; wayfinder ticket 27 §5, ADR-EA-032):** the first check is mechanical. `@awthaq/test`'s `RedactionGuard` installs a recording `Tracer` (wrapping Effect's default, so spans still work), a `Logger` merged with the existing ones, and an inspector on every event `AuthEvents` publishes — all part of `TestAuth.layer`. A value *leaks* when it is any `Redacted` instance anywhere in an inspected span attribute, span event, log message/annotation/cause or event payload, or when a string contains a **canary**: a known secret the test registered with `guard.watch(label, secret)` — which is what catches the plaintext copy a `Redacted.value(...)` unwrapped into an attribute or an interpolated message, the leak the wrapper alone cannot prevent. `runPluginContractTests`' opt-in `redaction` option (`{ app, exercise }`) builds the composition, runs the plugin's flows with canary passwords/tokens through `exercise`, and fails the run with a `RedactionLeak` naming the channel, the path and the canary's *label* — never the secret. The option is opt-in because the harness cannot build a plugin whose layer needs services it was not given; `@awthaq/password` runs it in CI. The second check (options do not change the contract) needs no instrumentation and always runs.

_Previous: [BEH-EA-198](25-testing-harness.md#beh-ea-198-runplugincontracttests-checks-manifest-legality-and-migrations) | Next: [BEH-EA-200](25-testing-harness.md#beh-ea-200-veto-only-in-veto-points-and-observer-isolation)_

## BEH-EA-200: Veto only in veto points, and observer isolation

```text
REQUIREMENT: `runPluginContractTests` MUST assert that a hook tap on an
             observe point cannot abort the operation it observes, and that an
             observer's failure does not propagate to fail that operation;
             only a veto-point tap may abort or amend.
```

PRD §19 and PRD §9.3's hook-point taxonomy ("veto (abort or amend), observe (fail-isolated)") together define the property this check enforces: `AfterSignUp` is an observe point, so a subscriber that throws while sending a welcome email must not cause sign-up itself to fail — `usage-examples-v4.md` §14's `Welcome` tap is documented as unable to "fail sign-in even if it throws." The contract test exists so a plugin author gets this guarantee checked automatically rather than having to reason about it by hand every time a new hook tap is added.

**As shipped (PV-260):** a plugin's declared taps (`AuthPlugin.layer`'s `taps`) are readable off `plugin.taps` with their owner (`plugin.id`), point key, kind, order and the **handler itself** (`DeclaredTap.handler`, the author's own function, so its identity is checkable) plus `exercise(input)` (the handler run against a stub, validated against the point's input schema, to an `Exit` — unfiltered by any point's failure semantics) and `install(owner)`. `runPluginContractTests` uses them:

- always, for every declared tap: a fresh point of the tap's kind is built, the plugin's own tap installed, and the point's resolved chain must contain a `{ owner: plugin.id, order }` entry (the tap really registers at the point it declares);
- opt-in, `hooks: [{ point: Hooks.AfterSignUp, input: stub }]`: the plugin's *actual handler* is run with the stub. An **observe** tap must not fail with `HookAbort` (an observe tap cannot abort the operation it observes; REQ-EA-569/572) and a failure of any other kind must not reach the operation it observes — the point's `run` still succeeds (REQ-EA-570); a **veto** tap may succeed or abort with `HookAbort` and nothing else (REQ-EA-571); a **divert** tap must not fail. A stub that does not match the point's input, or a stub for a point the plugin does not tap, fails the run so a typo cannot skip a check.

The check is not tautological because it runs the plugin's handlers rather than the core registry alone: the registry's isolation (`packages/core/test/HookPoint.test.ts`) guarantees that an observer's failure is contained, but only the handler tells whether it *tried* to abort.

_Previous: [BEH-EA-199](25-testing-harness.md#beh-ea-199-redaction-and-contract-hash-stability) | Next: [BEH-EA-331](25-testing-harness.md#beh-ea-331-testauthlayer-derives-the-host-middleware-from-the-composed-contract)_

## BEH-EA-331: `TestAuth.layer` derives the host middleware from the composed contract

```ts
const TestLive = TestAuth.layer(Auth.make([Password.Password]), { services: TestAuth.httpClient.noBreach })
// no AuthenticationLive, no CsrfProtectionLive, no CsrfConfig
```

```text
REQUIREMENT: `TestAuth.layer` MUST provide every host middleware
             (`Authentication`, `OptionalAuthentication`,
             `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection`)
             that the groups of the composed api declare, and only those
             (`AuthHttp.middlewareFor`). A test MUST NOT need to build
             `Authentication`, `CsrfProtection` or their configuration.
             `services` MUST be able to override any of them for the plugins.
             Plugin-owned middleware (`ScimAuthentication`, qadi's
             `AuthorizedSubject`) is never derived.
```

*As shipped (plan 15):* the derivation is `AuthHost`'s ([BEH-EA-340](02-plugin-composition-validate.md#beh-ea-340-authhostlayer-derives-the-servable-layer-from-authmake-and-its-requirements-are-exactly-what-the-host-owns)); the harness passes its CSRF configuration and resolver through.

Every composed api carries core's `session`/`account` groups, which declare `Api.Authentication` and `Api.CsrfProtection`, so before this every caller built both by hand (105 test and feature files built `PrincipalResolverLive`). `middlewareFor` reflects the api and builds exactly what its groups declare, so the type (`DeclaredMiddleware`) and the runtime agree and a plugin layer needing host middleware for some other reason stays in `RIn` and fails to compile instead of being silently absent. The derived layers are built fresh (`Layer.fresh`): the module-level `...Live` constants are memoized by reference, so a test that also builds one over its own config would otherwise share whichever instance was built first. `options.csrf` tunes the derived `CsrfConfig`, `options.principalResolver` swaps the principal resolver (`PrincipalResolverWithUserFactsLive` opts into `emailVerified`).

_Previous: [BEH-EA-200](25-testing-harness.md#beh-ea-200-veto-only-in-veto-points-and-observer-isolation) | Next: [BEH-EA-332](25-testing-harness.md#beh-ea-332-testauthlayer-runs-the-same-composition-over-sql)_

## BEH-EA-332: `TestAuth.layer` runs the same composition over SQL

```ts
const SqlLive = TestAuth.layer(built, { records: "sql", suite: "notes" })   // a missing `suite` does not compile
```

```text
REQUIREMENT: `records: "sql"` MUST serve the same services over a database
             migrated with core's migrations and the composition's own
             (`built.migrations`), using each composed plugin's `records.sql`
             and `Persistence.sql()`. Under `AWTHAQ_POSTGRES_URL` it MUST use a
             per-suite Postgres schema (`TestSql.layer(suite)`); otherwise
             SQLite `:memory:`. Omitting `suite` MUST be a compile error.
             The composition's `RIn` MUST be `never` in both modes exactly
             when the composition is complete.
```

The same suite then proves a plugin over both of its adapters with one option (`for (const records of TestAuth.recordModes)`), and `pnpm test:pg` runs it on Postgres. The migrations run before anything is built over the client, because everything is provided through the one migrated layer. *As shipped (plan 15):* the run is `Migrations.apply` inside `AuthHost`'s SQL mode, so a drifted ledger refuses the build ([BEH-EA-341](05-persistence-stratum.md#beh-ea-341-a-sql-host-composition-never-serves-a-schema-that-is-behind-it)).

_Previous: [BEH-EA-331](25-testing-harness.md#beh-ea-331-testauthlayer-derives-the-host-middleware-from-the-composed-contract) | Next: [BEH-EA-333](25-testing-harness.md#beh-ea-333-testauthapp-serves-the-composition-and-its-context-together)_

## BEH-EA-333: `TestAuth.app` serves the composition and its context together

```ts
const app = yield* TestAuth.serve(TestAuth.layer(built)) // inside it.effect
const alice = await app.signIn("a@example.com")              // an agent holding a session
await alice.request("POST", "/notes", { json: { text: "hi" } })  // cookies and the CSRF echo are its own
```

```text
REQUIREMENT: The handler and the context runner of the served app MUST share
             one instance of every service (one memo map): a session minted
             through `run` MUST authenticate a request through `handler`.
             `request` MUST satisfy CSRF double-submit for the composition's
             own `CsrfConfig` (read once through `run`), computed independently
             of `Csrf.ts` (`TestAuth.csrfToken`, `node:crypto`). The app MUST be
             released by the scope that served it (BEH-EA-351). `runtime` (a
             `ManagedRuntime`), `memoMap` and `context()` (the composition built
             once on the real clock, for a World that runs effects on its own
             fiber) MUST resolve against the same instances as `handler`.
             With `{ testClock: true }` the handler, `run` and `runtime` MUST
             read one `TestClock` that `advance` moves, and `request` stamps its
             CSRF pair from that clock; `advance` without the option MUST
             reject. `{ memoMap }` lets two apps share instances.
             `TestAuth.buildContext(layer, { scope, memoMap? })` builds any
             layer into a context on the real clock. `agent()` MUST return a
             user agent (BEH-EA-344) with its own cookie store over the same
             instances, reading the composition's clock and already holding a
             `__Host-csrf` minted from the composition's own config; `signIn`
             MUST return an agent holding a session rendered under the
             composition's `SessionCookieConfig` (or its bearer token with
             `delivery: "bearer"`); `request` MUST be a fresh anonymous agent.
```

*As shipped (plan 34):* `TestAuth.app` became `TestAuth.serve` (BEH-EA-351); there is no `dispose`.

This replaces the hand-rolled memo-map handles, the per-suite CSRF token mints (22 `createHmac` copies) and the hand-threaded cookies (21 reads, four jars). *As shipped (plan 20):* `agent()` is asynchronous (it reads the composition's CSRF config and clock through `run`); under `testClock` an agent's cookie store reads the same clock, so a session cookie's `Max-Age` lapses when `advance` passes it; a `Set-Cookie` a browser would refuse fails the request (`onRefused: "record"` for a test about refusals). `TestAuth.csrfSetCookie(secret)` seeds an agent over a hand-wired handler the same way.

_Previous: [BEH-EA-332](25-testing-harness.md#beh-ea-332-testauthlayer-runs-the-same-composition-over-sql) | Next: [BEH-EA-336](25-testing-harness.md#beh-ea-336-every-shipped-plugin-runs-the-contract-suite-which-checks-its-records)_

## BEH-EA-336: Every shipped plugin runs the contract suite, which checks its records

```text
REQUIREMENT: Every `AuthPlugin.Service` class in the repository MUST be
             exercised by `runPluginContractTests` from its package's
             `test/Contract.test.ts` (enforced by `pnpm check:contract-tests`,
             part of `pnpm check`). For a plugin that declares `records` the
             suite MUST check that `records.memory` and `records.sql` build and
             provide the same stores, naming the extra or missing keys. With
             `build: { services }` it MUST build the composition over both
             record modes.
```

**Plan 25 (ADR-EA-041 decision 9): every plugin record store passes its contract suite on memory, SQLite and Postgres.** For a plugin whose `records` bundle provides a store, `runPluginContractTests` MUST be given `records: { suite, suites }` (the compiler requires it, and refuses it for a plugin whose bundle provides none): one `RecordsContract.suite(Store, { operations })` per store, keyed by the store's `/records/` key (a missing or surplus key does not compile; for a hand-built `AuthPlugin.Any` a runtime check names it). Every operation of the store's interface carries a verdict, `read`, `write`, `atomic` (with at least one `race` case racing 8 callers and asserting exact counts) or `exempt` with a reason; an unclassified operation does not compile. The runner reads both adapters from `Plugin.records` and runs every case on memory and on SQL (SQLite `:memory:`, a Postgres schema under `pnpm test:pg`), building a fresh adapter for each case; a suite's tenancy cases run through the tenant-isolation suite of [BEH-EA-326](28-tenancy.md#beh-ea-326-a-partitioned-plugin-table-is-filtered-by-the-store-identically-in-memory-and-sql) over the same adapters. `pnpm test:pg` runs every vitest project and the BDD suite against `AWTHAQ_POSTGRES_URL`, the set CI's `pnpm check` runs, and `pnpm check:contract-tests` fails when `scripts/test-pg.sh` names a test file (a hand-kept list had drifted: plan 37 measured 9 files it missed). Every shipped store has its suite (plan 25 ticket 25): the `RecordsContract.pending` stand-in that tickets 08 to 24 used is removed, and `pnpm check:contract-tests` reports any test file that still names it.

13 of the 20 plugin classes had no contract-test call in their own package. The compile-time half of the pairing is [BEH-EA-334](), the runtime half is this check, for a hand-built `AuthPlugin.Any` the type system cannot see into. The same script fails when a library `src` imports `@awthaq/test` or a package lists it under `dependencies`.

## BEH-EA-342: `TestAuth.layer` is `AuthHost.layer` over the test ports

> **See:** [ADR-EA-044](../decisions/044-host-composition.md)

```ts
TestAuth.layer(built, options)
// = AuthHost.layer(built, { ...options, csrf: TestCsrfConfig, requestContext: false, bodyLimit: false })
//     over the test ports, the RedactionGuard (in the decorate slot) and HttpServer.layerServices + HttpRouter.layer
```

```text
REQUIREMENT: `TestAuth.layer` MUST be built by `AuthHost.layer` with the
             test ports, the redaction guard and the HTTP platform beneath
             it, so the harness and a production host share every
             composition-owned element; a test MUST fail if the two diverge
             beyond the test-only services. `tier` MUST select the served
             groups as `AuthHost`'s does.
```

The harness used to be the only complete derivation of a servable pipeline, and the production copies re-derived it by hand and drifted. Building it on the host module makes the shared wiring a fact of construction instead of a promise: `TestAuthHost.test.ts` builds both for one composition in both record modes and asserts the harness's service keys are the host module's plus exactly the guard's. `taps` keeps its requirement, so a test tap on a point no composed plugin declares fails to compile (INV-EA-005), and `tier` makes the public-tier listener testable through the harness (AR-003) instead of hand-wired.

*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthHost.test.ts`, run on Postgres under `pnpm test:pg`; `test/TestAuthRecords.types.test.ts` for the foreign tap; `packages/admin/test/AdminTier.test.ts` for the public tier).

_Previous: [BEH-EA-333](25-testing-harness.md#beh-ea-333-testauthapp-serves-the-composition-and-its-context-together) | Next: [BEH-EA-351](25-testing-harness.md#beh-ea-351-a-served-app-lives-exactly-as-long-as-its-scope)_

## BEH-EA-351: A served app lives exactly as long as its scope

```text
REQUIREMENT: `TestAuth.serve(composition, options)` MUST acquire the app in the
             caller's `Scope` and release everything the composition built when
             that scope closes, whether the scope's work succeeded, failed or was
             interrupted. The composition MUST be built on the real clock even
             when the caller runs under a `TestClock`. `TestAuth.withApp`
             MUST release the app when its callback settles, and MUST surface
             the callback's rejection unchanged. With `testClock: "now"` the
             handler, `run` and every agent MUST read one `TestClock` started at
             the wall clock.
```

```ts
const app = yield* TestAuth.serve(TestAuth.layer(built)); // inside it.effect: released with the test's scope
await TestAuth.withApp(layer, undefined, async (app) => { /* … */ }); // promise-style bracket
```

*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthLifetime.test.ts`). `TestAuth.app` stays as a deprecated adapter until plan 34 ticket 21.

_Previous: [BEH-EA-342](25-testing-harness.md#beh-ea-342-testauthlayer-is-authhostlayer-over-the-test-ports)_

## BEH-EA-352: A World holds one lazy app cell

```text
REQUIREMENT: `TestAuth.lazyApp(initial, build, settings)` MUST build at most
             once per scope from the options accumulated by `configure`, on the
             first `get`, into a child of the scope it was created in. A
             `configure` after that build MUST be a defect naming the cell;
             `replace` MUST release the built app before the next `get` builds
             again. With `alignStepClock` the caller's `TestClock` MUST read the
             wall clock after the first `get`.
```

```ts
const app = yield* TestAuth.lazyApp(initial, (o) => TestAuth.serve(layerFor(o)), { name: "SessionWorld" });
```

*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthLazy.test.ts`).

_Previous: [BEH-EA-351](25-testing-harness.md#beh-ea-351-a-served-app-lives-exactly-as-long-as-its-scope)_

## BEH-EA-353: The harness can listen on a socket

```text
REQUIREMENT: `TestAuth.listen(composition, options)` MUST serve the same
             instances as the app's `handler` and `run` on 127.0.0.1 at an
             ephemeral port reported as `url`, MUST record every request line
             it answers (`requests()`, oldest first), and MUST close the socket
             when the scope closes.
```

Agents stay in-process; the socket is for out-of-process clients (the CLI's generated `HttpApiClient`). BEH-EA-193's "no real network listener" still holds because listening is opt-in.

*Implementation* (`packages/test/src/TestAuth.ts`; `test/TestAuthListen.test.ts`).

_Previous: [BEH-EA-352](25-testing-harness.md#beh-ea-352-a-world-holds-one-lazy-app-cell)_

## BEH-EA-354: `TestAuth`'s base records mail and SMS in a mailbox a test awaits

```ts
const box = yield* TestMailbox.Mailbox
const mail = yield* box.mail.waitFor({ to: email, template: "verify-email" })
TestMailbox.secret(mail)
yield* box.mail.refute({ to: "nobody@example.com" })
```

```text
REQUIREMENT: `TestAuth.layer` MUST provide `Mailer` and `SmsSender` through one
             `TestMailbox.layer`, and its output MUST hold `TestMailbox.Mailbox`
             over the recording the plugins send into. `waitFor` MUST resolve as
             soon as a matching message is recorded, without a fixed number of
             scheduler turns, and MUST fail at a deadline measured on the real
             clock. `refute` MUST fail when a matching message is recorded
             already or within its window. A failure message MUST NOT contain a
             recipient or message data (EOTS-010).
```

*Implementation* (`packages/test/src/TestMailbox.ts`; `test/TestMailbox.test.ts`, `test/TestAuthApp.test.ts`; BDD REQ-EA-1560..1562). ADR-EA-054.

_Previous: [BEH-EA-353](25-testing-harness.md#beh-ea-353-the-harness-can-listen-on-a-socket) | Next: [BEH-EA-357](25-testing-harness.md#beh-ea-357-every-core-store-port-passes-its-storecontract-suite-on-every-adapter)_

## BEH-EA-357: Every core store port passes its `StoreContract` suite on every adapter

> **See:** [ADR-EA-041](../decisions/041-domain-store-ports.md)

```ts
StoreContract.run(framework, { mode: "memory" })
StoreContract.run(framework, { mode: "sql", label, client })
```

```text
REQUIREMENT: Every operation of a core store port MUST carry a verdict in its
             suite, and one without MUST fail to compile. `StoreContract.run`
             MUST run every suite on the `Ref` adapters, on the SQL adapters
             over SQLite and (under `pnpm test:pg`) Postgres, and the users and
             sessions suites on the sealed bundle, building a fresh adapter
             per case. A store the memory bundle provides without a suite MUST
             fail the run.
```

The ports are atomic by contract, so the bar has to name every operation: a store whose `settle` ignored a give-back, or whose rate-limit `increment` read then wrote, passed a list of cases that never asked. A verdict per operation turns a missing case into a compile error, and the two mutants in `StoreContract.test.ts` prove the cases catch what they claim to.

*Implementation* (`packages/test/src/StoreContract.ts`, `packages/test/src/internal/storeContract/*.ts`; `test/StoreContract.test.ts`, `test/StoreContract.types.test.ts`, and the five runner files `StoreContract.memory.test.ts`, `.sql.test.ts`, `.file.test.ts`, `.libsql.test.ts`, `.sealed.test.ts`). ADR-EA-041 decision 6.

_Previous: [BEH-EA-354](25-testing-harness.md#beh-ea-354-testauths-base-records-mail-and-sms-in-a-mailbox-a-test-awaits)_
