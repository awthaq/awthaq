# 16 — Automatic response mirroring

**What to build:** every successful response from any authenticated
endpoint — across every installed plugin, not just this one's own — also
carries a fresh JWT, with no per-plugin opt-in required.

**Blocked by:** 08 — Sign and stateless verify

**Status:** done

- [x] A new, small, additive, optional core reference —
      `PostAuthResponseHook` (naming provisional) — added to
      `@effect-auth/core`/`@effect-auth/server`, defaulting to an identity
      no-op, consulted once inside `Authentication`'s existing
      `AuthenticationLive`/`OptionalAuthenticationLive` implementations
      immediately after a successful principal resolution, mirroring the
      already-existing overridable `PrincipalResolver` pattern in that
      same file
- [x] Confirmed: when `Jwt` is not installed, response shape/behavior for
      every existing plugin is completely unchanged (the no-op default)
- [x] `Jwt`'s own layer overrides `PostAuthResponseHook`: mints a token for
      the resolved principal and attaches it as a response header on the
      outgoing response
- [x] Wire-level test proving this is genuinely generic, not special-cased
      to `Jwt`'s own endpoints: install `Jwt` alongside the core `session`
      group (not `Password` — see `## Result`), call an authenticated
      endpoint that isn't one of `Jwt`'s own, confirm the mirrored-JWT
      header is present on that response

## Result

Done, with one real architecture correction found mid-implementation —
recorded here in full since it's a genuine lesson, not just a status
update.

**What was built, as specified:**
- `packages/server/src/Authentication.ts` gains `PostAuthResponseHookShape`
  and `PostAuthResponseHook` — a `Context.Reference` (not a `Context.Service`
  — it must always resolve to *something*, even when no plugin overrides
  it), defaulting to an identity no-op (`(_principal, response) => Effect.succeed(response)`).
  `AuthenticationLive`/`OptionalAuthenticationLive`'s `handle`/`cookie`/`bearer`
  closures consult it after `resolvePrincipal` succeeds and the inner
  `httpEffect` resolves, applying its result before returning.
- `packages/jwt/src/Jwt.ts`: a new `PostAuthResponseHookLive` layer
  overrides the reference — mints a token via the plugin's own `sign` and
  attaches it as an `x-jwt-token` response header, via `Effect.catch`
  recovering to the original response so a signing failure can never break
  an otherwise-successful response (`decorate`'s own type —
  `Effect.Effect<HttpServerResponse>`, no error channel — makes this a
  compile-time requirement, not just a convention). `Jwt`'s
  `static readonly layer` is now `Layer.provideMerge(PostAuthResponseHookLive, AuthPlugin.layer(Jwt, {...}))`
  — the first plugin in this codebase to merge a second Layer into its own
  `static readonly layer`.

**The real bug, found and fixed during implementation**: a genuine circular
dependency, not a composition-order mistake. `Jwt`'s own `jwt.token` mint
endpoint (ticket 10) requires `Api.Authentication` (the middleware, to gate
itself); `PostAuthResponseHookLive` requires the `Jwt` *service*. If
`AuthenticationLive` captures `PostAuthResponseHook` **once, at its own
layer-build time** (the natural-looking first draft, mirroring how
`sessions`/`resolver` are already captured there) — then composing
`Jwt`'s override into that same build creates an unresolvable build-order
cycle: `AuthenticationLive`'s build wants `Jwt`'s override, which wants the
`Jwt` service, which (via the bundled `jwt.token` handlers) wants
`Api.Authentication`, which is what `AuthenticationLive`'s own build is in
the middle of producing.

**Fix**: resolve `PostAuthResponseHook` **per request**, inside the
`handle` closures themselves, rather than once at the enclosing layer's
build time — `Effect.flatMap(PostAuthResponseHook, (hook) => hook.decorate(...))`
in place of a build-time `const hook = yield* PostAuthResponseHook`. At
request time there's no build-order constraint: the request already has
`Api.Authentication` resolved (its own middleware is what's running), and
`Jwt`'s service is already part of the same fully-built application
context — no cycle. A `Context.Reference` lookup costs nothing beyond a
context read, so resolving it per request instead of once is free.

**A second, related pitfall, also found and fixed**: `Layer.provide`
(discard semantics — keeps only the consuming layer's own original output
type) silently drops the *provider's* own output, including a
`Context.Reference` override, from ever reaching the final built context —
even after the per-request fix above, a composition that still applied
`Jwt.Jwt.layer` via a **locally-scoped** `Layer.provide` inside one
specific `AuthHttp.routes(...)` branch (mirroring how earlier tickets
composed it, since nothing before this ticket needed `Jwt.Jwt.layer`'s
*own* output to be visible elsewhere) never actually exposed the override
to the rest of the app. Fixed by merging `Jwt.Jwt.layer`
(and `AuthenticationLive`) in via `Layer.provideMerge` at a **shared,
outer** level of the composition, not locally per-branch — this is the
pattern any real application composing `Jwt` alongside other plugins needs
to follow, and it's what both test files (single-plugin `AuthHttp.test.ts`
and the new cross-plugin block) now demonstrate.

**Testing**: `packages/server/test/Authentication.test.ts` gained one new
test proving a tapped `PostAuthResponseHook` is consulted with the
correctly-resolved principal (using a plain `Layer.succeed` test double,
independent of `Jwt` entirely) — every pre-existing test in that file
still passes unchanged, confirming the no-op default doesn't alter
existing behavior. `packages/jwt/test/AuthHttp.test.ts` gained the
cross-plugin proof: `Jwt` composed alongside the core `session` group
(`@effect-auth/api`'s `AuthCore.AuthCoreApi` + `@effect-auth/server`'s
`Session.SessionHandlers`) rather than `Password` as the ticket's own
checklist suggested — the core `session` group is an even stronger proof
of genericity (it isn't a plugin at all, just the baseline every
application already has), and avoids pulling in `Password`'s own
sign-up/sign-in flow just to get an authenticated session for the test.
`GET /session` (never one of `Jwt`'s own `/jwt/...` endpoints) carries a
verifiable `x-jwt-token` header. The existing single-plugin
`/jwt/token` test also now asserts the header's presence (it only checked
the response body before).

**Regression check** (the most important verification in this ticket):
`packages/password/test` (20/20), `packages/organization/test` (149/149),
and `packages/admin/test` (34/34) — their existing, unmodified suites —
all pass with zero changes, confirming the core touch is genuinely
byte-identical in behavior for every plugin that doesn't install `Jwt`.

**Verification**: `pnpm --filter @effect-auth/server typecheck` clean,
`pnpm --filter @effect-auth/jwt typecheck` clean, `pnpm exec tsc -p tsconfig.test.json`
clean, `pnpm --filter @effect-auth/server test` (21/21),
`pnpm --filter @effect-auth/jwt test` (34/34), `pnpm lint`/`pnpm format:check`
clean workspace-wide.

## Spec-review fix (applied after all 12 tickets landed)

The delegated Spec-fidelity code review caught a real bug this ticket's own
implementation and testing missed: `OptionalAuthenticationLive`'s `bearer`
branch called `PostAuthResponseHook` even when `resolvePrincipal` had
*failed* and been recovered to `Api.anonymousPrincipal` — meaning an
unauthenticated caller (no credential at all) hitting any
`OptionalAuthentication`-gated endpoint with `Jwt` installed received a
real, verifiable `x-jwt-token` asserting an "anonymous" identity. The spec
(`.scratch/jwt/spec.md`'s "Automatic response mirroring" decision) and this
ticket's own design both say the hook fires "immediately after a
*successful* `resolvePrincipal`" — the anonymous fallback is a recovery,
not a success, and this ticket's own testing (`AuthHttp.test.ts`'s
cross-plugin proof, and `Authentication.test.ts`'s tapped-hook test) only
ever exercised the required-`Authentication`/valid-credential paths, never
this one.

Fixed in `packages/server/src/Authentication.ts`: `bearer`'s pipeline now
threads the entire "provide principal → consult hook" sequence through the
*success* branch only, and `Effect.catchTag("Unauthenticated", ...)`
recovers to a plain, undecorated anonymous response — restructured so the
`catchTag` sits *after* the hook-consultation step rather than before it.
Added a regression test to `packages/server/test/Authentication.test.ts`
proving a tapped hook is never consulted for the anonymous-fallback path.

**Re-verification**: `pnpm --filter @effect-auth/server test` — 22/22 (up
from 21, the new regression test); full workspace `pnpm typecheck`/
`pnpm lint`/`pnpm format:check`/`pnpm test` — 67 files, 560 tests, all
green, zero regressions.
