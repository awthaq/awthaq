# 02 — Mint delivery mechanism: explicit endpoint and automatic response mirroring

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately (grounded in ticket 00)

## Question

This map has already settled the "whether": JWT minting is in scope both
as an explicit endpoint (`GET /auth/jwt/token`-shaped, requiring an
already-authenticated caller via the existing cookie/bearer middleware) and
as automatic mirroring onto every successful session-resolving response
(better-auth's `set-auth-jwt` header equivalent) — the user confirmed the
richer, full-parity option over the narrower "explicit endpoint only" one
this session originally recommended.

What's still open is the **how**, and it's a real mechanism gap, not a
detail:

1. Does anything in `effect/unstable/httpapi`/`HttpApiBuilder` (or this
   codebase's own `AuthHttp`) already offer a global response-decorating
   hook — something that runs after *any* successful handler across *any*
   installed plugin's group, without each plugin author having to
   individually opt in? (Likely needs a research pass against the actual
   `HttpApiBuilder`/`HttpServer` middleware surface in `../effect` before
   this can be answered with confidence — dispatch that fact-finding
   rather than guessing.)
2. If no such global hook exists, what's the least-invasive way to add
   one — a new core-level concept (a response-side sibling to the existing
   `HookPoint` veto/observe mechanism, per `packages/core/src/HookPoint.ts`
   and BEH-EA-089–096), or something scoped entirely inside
   `@effect-auth/jwt` that other plugins must each explicitly wire in (in
   which case it isn't really "automatic" for third-party/future plugins,
   and that limitation needs to be named plainly)?
3. Given this map's own "no core changes" destination decision (ticket 00 /
   the map's charting round), does building this mechanism actually force
   a core change after all — and if so, does that change this map's own
   destination artifact (Organization-style `.scratch/jwt/spec.md` vs.
   Admin-style formal `spec/behaviors/` file with a new `BEH-EA` range)?
4. What does the explicit mint endpoint's own request/response shape look
   like — any payload (mirroring better-auth's per-call claims override),
   or bare (claims always derived from the current principal alone)?

## Answer

Resolved by direct investigation of `effect/unstable/httpapi`'s actual
middleware machinery (not a judgment call — a fact question, answered):
`@effect-auth/server`'s own `AuthHttp.routes`/`AuthHttp.docs`
(`packages/server/src/AuthHttp.ts`) are bare re-exports of
`HttpApiBuilder.layer`/`HttpApiScalar.layer` — effect-auth adds **no**
global, app-wide response middleware of its own today; an application
wires `HttpRouter.serve`/`toWebHandler` directly. There is no existing
"wrap every response, across every plugin" hook to reuse as-is.

However, a smaller, exactly-right seam already exists: `Api.Authentication`/
`Api.OptionalAuthentication` (`packages/server/src/Authentication.ts`) is
already the **one shared middleware** every authenticated endpoint across
every plugin already goes through — `resolvePrincipal` runs once per
request, regardless of which plugin's endpoint is being called, and its
own `handle` closure is exactly the place `Api.CurrentPrincipal` gets
provided. A generic outer `HttpMiddleware` wrapping the whole served app
from outside would **not** see `CurrentPrincipal` (`Context.provideService`
only affects the sub-computation it wraps, not a sibling tap composed
afterward) — ruling out the naive "just add an app-level middleware"
approach. But decorating the response **inside** `AuthenticationLive`'s own
`handle`, after `resolvePrincipal` succeeds and the inner `httpEffect`
resolves, works with zero new subsystem: it's the same function, same
scope, same already-resolved principal and already-produced response.

**Decision**: add one small, additive, optional slot to core —
`PostAuthResponseHook` (name provisional), a `Context.Reference` defaulting
to a no-op `identity`-shaped decorator: `(principal, response) => Effect.Effect<HttpServerResponse>`.
`AuthenticationLive`/`OptionalAuthenticationLive` consult it once, after a
successful `resolvePrincipal`, and apply its result to the response before
returning — mirroring the existing `PrincipalResolver` pattern (an
overridable service `Authentication` already knows how to consult, not a
brand-new mechanism). `Jwt`'s own layer overrides this reference: mint a
JWT for the resolved principal and attach it as a response header. This
*is* a small core touch (one new reference, a few lines in
`Authentication.ts`), which is why this map's destination gets amended —
see the map's own updated Decisions so far.

This closes questions 1–3 with a real (not merely feasible-in-theory)
mechanism, and settles question 3 concretely: yes, a core touch is needed,
but it's proportionate — one optional slot alongside an existing one, not
a new subsystem — so the destination stays `.scratch/jwt/spec.md` rather
than escalating to a formal `spec/behaviors/` file; the core change is
additive and doesn't alter any existing contract's behavior when unused.

Question 4 (mint endpoint shape): the explicit `GET /auth/jwt/token`
endpoint takes **no request payload** — claims are always derived from the
already-resolved `CurrentPrincipal`, never client-suppliable at the wire
level (letting an authenticated caller inject arbitrary claims into their
own token is a needless attack surface for zero real benefit; the
general-purpose arbitrary-payload primitive from ticket 04 covers genuine
custom-claims needs for trusted in-process callers instead).
