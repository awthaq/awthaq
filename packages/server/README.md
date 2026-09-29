# @awthaq/server

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

HTTP stratum (5). Middleware implementations, core handlers, AuthHttp — the mechanism that registers a composed HttpApi with a router.

**Planned first module:** Authentication.ts (spec/behaviors/09-authentication-middleware.md, BEH-EA-065–072); also Csrf.ts, AuthHttp.ts

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Deployment checklist

- **HSTS at the edge.** Serve every auth route over HTTPS only and send `Strict-Transport-Security` from the edge (CDN, load balancer or reverse proxy) — the session cookie is `Secure`/`__Host-` and cannot work over plain HTTP. If your Node process *is* the edge, merge `SecurityHeaders.layer()` into your router layer instead.
- **`SecurityHeaders.layer(options?)`** is an opt-in global `HttpRouter` middleware (PDR-004) that adds `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` to every response. Each header can be overridden with a string or omitted with `false`, and it never overrides a header a handler already set. The OAuth authorize/callback responses always send `Referrer-Policy: no-referrer` themselves (their URLs carry the provider's `code`/`state`).
- **Do not double-send.** If the edge already sets one of these headers, pass `false` for it so the response carries a single value.
