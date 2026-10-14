# @awthaq/server

HTTP stratum (5). Middleware implementations, core handlers, AuthHttp — the mechanism that registers a composed HttpApi with a router.

**Shipped**: `Authentication` / `OptionalAuthentication` (cookie first, bearer second, per-request session memoization, rotated-secret delivery — BEH-EA-065–072), `Csrf` (double-submit cookie — BEH-EA-073–080), `Session` (the core `session` group handlers), `Account` (the core account group, including `deleteUser`'s transactional erasure cascade) and `AuthHttp` (`routes`/`docs`, the error-to-status mapping — BEH-EA-081–088).

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Logging hazard: the rotated session token

The server delivers a rotated bearer token in the `set-auth-token` response header (a long-lived secret, `Cache-Control: no-store`). Effect's default redacted header names do not include it, so provide `AuthHttp.layerRedactedHeaders` (which adds `set-auth-token` and `x-jwt-token` to Effect's defaults) wherever requests or responses are logged or traced, and make sure any proxy preserves the header. A host-supplied logger that does not read `Headers.CurrentRedactedNames` must redact those names itself.

## Request context (`RequestContext.layer`)

`RequestContext.layer` is an **opt-in** global `HttpRouter` middleware: merge it beside `AuthHttp.routes(...)` (`Layer.mergeAll(BodyLimit.layer, RequestContext.layer)` over your app layer, as `examples/memory-server` and `examples/sql-server` do). It fills core's `AuthRequestContext` once per request with a correlation id (a sane `x-request-id`, else the `traceparent` trace id, else a fresh uuidv7), the client address (what the `ClientAddress` port resolves) and the user agent. Without it a session minted over HTTP records no address or user agent (the device list in `GET /session` is empty) and events carry no correlation id.

`AuthHttp.coreHandlers` logs one warning at layer build when it finds a router without the middleware. A composition that runs without it on purpose (the in-process `@awthaq/test` harness does) silences the warning by providing `RequestContext.warnWhenAbsent` as `false`.

## Session delivery

A plugin handler that mints a session answers through `SessionDelivery.respond(request, mint)`: it validates `X-Awthaq-Token-Delivery` first (an unknown value is `InvalidTokenDelivery` and `mint` never runs), runs `mint`, then delivers the session as a cookie (the default) or, for `bearer`, as the response body's `token` with `Cache-Control: no-store`. Only an endpoint that mints no session (a concealed sign-up) calls `SessionDelivery.mode` on its own.

## Deployment checklist

- **HSTS at the edge.** Serve every auth route over HTTPS only and send `Strict-Transport-Security` from the edge (CDN, load balancer or reverse proxy) — the session cookie is `Secure`/`__Host-` and cannot work over plain HTTP. If your Node process *is* the edge, merge `SecurityHeaders.layer()` into your router layer instead.
- **`SecurityHeaders.layer(options?)`** is an opt-in global `HttpRouter` middleware (PDR-004) that adds `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` to every response. Each header can be overridden with a string or omitted with `false`, and it never overrides a header a handler already set. The OAuth authorize/callback responses always send `Referrer-Policy: no-referrer` themselves (their URLs carry the provider's `code`/`state`).
- **Do not double-send.** If the edge already sets one of these headers, pass `false` for it so the response carries a single value.
