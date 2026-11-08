---
"@awthaq/api": minor
"@awthaq/core": minor
"@awthaq/server": patch
---

`AuthRequestContext` moves to `@awthaq/api` (beside `CurrentPrincipal`) and becomes a tagged value: `Request { correlationId, ip, userAgent }` or `NoRequest`, with no default. `Api.RequestContext` is the endpoint middleware that will provide it (ADR-EA-047). The user agent is capped at 512 characters by the only constructor of the branded `Api.UserAgentHeader`, so event envelopes and audit rows now carry the same capped value as the session row.

Migration: import `Api.AuthRequestContext` from `@awthaq/api` (the `AuthRequestContext` namespace of `@awthaq/core` is gone); `AuthRequestContext.none` becomes `Api.AuthRequestContext.noRequest`; a value you provide is `Api.AuthRequestContext.request({ correlationId, ip?, userAgent? })`.
