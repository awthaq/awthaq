# @awthaq/server

> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.

HTTP stratum (5). Middleware implementations, core handlers, AuthHttp — the mechanism that registers a composed HttpApi with a router.

**Planned first module:** Authentication.ts (spec/behaviors/09-authentication-middleware.md, BEH-EA-065–072); also Csrf.ts, AuthHttp.ts

See [`spec/overview.md`](../../spec/overview.md) for the full package map this fits into.

## Logging hazard: the rotated session token

The server delivers a rotated bearer token in the `set-auth-token` response header (a long-lived secret, `Cache-Control: no-store`). Effect's default redacted header names do not include it, so provide `AuthHttp.layerRedactedHeaders` (which adds `set-auth-token` and `x-jwt-token` to Effect's defaults) wherever requests or responses are logged or traced, and make sure any proxy preserves the header. A host-supplied logger that does not read `Headers.CurrentRedactedNames` must redact those names itself.
