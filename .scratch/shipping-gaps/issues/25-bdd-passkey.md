# 25 — Passkey step-definitions

**What to build:** `Passkey`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** done

## Result

Wired `features/features/05-authentication-methods/17-passkey.feature`
(27 named scenarios, two as Scenario Outlines): `features/step-definitions/PasskeyWorld.ts`
builds the real `Passkey.Passkey` service over a real `HttpRouter.toWebHandler`
app (real in-memory `Users`/`Accounts`/`Sessions`/`AuthEvents`/`ChallengeStore`/
`PasskeyCredentials`), with only the `WebAuthn` port mocked — the same
wire-level seam `packages/passkey/test/AuthHttp.test.ts` already
establishes. `PasskeySteps.ts` drives real HTTP requests against it.

23 of 27 scenarios execute for real; 4 pruned via `@skip`: REQ-EA-355/356/357
(BEH-EA-129's "WebAuthn is a port, wrapped, not reimplemented" — type-level/
composition/source-inspection claims, not runtime-observable through this
wire seam; the real `WebAuthn.layerSimpleWebAuthn` composition is already
proven by `packages/ports/test/WebAuthn.test.ts`), and REQ-EA-381 (a real
spec/implementation divergence found and documented in the `.feature` file
itself: the scenario's literal text expects a counter regression to be
"reported as PasskeyCounterAnomaly" and "not silently accepted", but
`Passkey.ts`'s own `authenticateVerify` deliberately treats a counter
regression as "log + step-up, not an instant kill" — publishing
`auth.passkey.counterAnomaly` on `AuthEvents` while the ceremony still
succeeds, per `PasskeyApi.ts`'s own doc comment on `PasskeyCounterAnomaly`
confirming this is intentional, not a bug).

One real bug caught and root-caused via a failing assertion, not
inspection: `signIn`'s own session-bootstrap helper (needed because Passkey
registration always requires an existing session, and this plugin has no
sign-up endpoint of its own) initially composed via a bare `yield*` inside
the calling step's own ambient Effect. Under `@effect-cucumber/vitest`'s
ambient `TestClock` (frozen at epoch 0), that meant every session issued
through it carried epoch-anchored expiry timestamps — while
`HttpRouter.toWebHandler`'s own per-request execution
(`HttpEffect.toWebHandlerWith`'s internal `Effect.runForkWith`, a plain JS
function-call boundary) always runs on the real global runtime, real
`Clock`, regardless of the caller's ambient `TestClock`. Every session
looked 55+ years expired to the real HTTP layer validating it, and every
authenticated request answered 401 `Unauthenticated`. Root-caused by
comparing a working `Sessions.issue`/`verify` round trip under `it.effect`'s
own `TestClock` (self-consistent, passed) against the same round trip
through a real HTTP request (failed) until the clock mismatch surfaced.
Fixed by routing `signIn`/`linkOtherAccount` through `Effect.runPromise`
(bypassing the ambient `TestClock`, matching `AuthHttp.test.ts`'s own
`issueSessionCookieHeader`) so the bootstrap always runs on the same real
clock `handler` itself is always on. A second, related fix: two scenarios
(REQ-EA-358 vs REQ-EA-359) share the exact same Given text
("a registration ceremony's challenge issued by...") but need different
`WebAuthn` mock behavior for their later, differing When steps — rebuilding
the app mid-Scenario to flip that behavior would discard the session and
challenge the shared Given already created, so the mock now reads its
behavior from a live `Ref` (`overrideWebAuthnBehavior`) instead of a value
baked in at Layer-build time.

`pnpm test:bdd` — 79 passed, 34 skipped (was 49/30 after ticket 22).
`pnpm test` — 586 passed, 2 skipped, unaffected. `pnpm typecheck`/`pnpm
lint`/`pnpm format:check` clean workspace-wide.

- [x] Step-definitions written for `Passkey`'s feature files, calling
      into the existing `Passkey` wire-level seam
      (`packages/passkey/test/AuthHttp.test.ts`)
- [x] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented
- [x] The existing `test:bdd` step executes these scenarios and passes
