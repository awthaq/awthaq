---
"@awthaq/core": minor
"@awthaq/admin": patch
"@awthaq/test": minor
---

Core reads the request context first (ADR-EA-047). `Sessions.issue` records the address and user agent of the request that minted the session from `Api.AuthRequestContext` (an explicit `request` field still wins until the plugins stop passing one), so admin impersonation sessions now record the administrator's address and user agent; a migrated legacy session keeps its own facts. The `ip` rate-limit strategy keys on the request context's address when the call passes none. `SignIn.failed` is the one publisher of `auth.user.signInFailed`, its `clientIp` read from the context. `TestAuth` gains `withRequest`, `withoutRequest`, a `clientAddress` option, `app(…, { request })` (`run` answers no request by default) and `signInAs({ request })`.

Migration: `Sessions.MAX_USER_AGENT_LENGTH` becomes `Api.MAX_USER_AGENT_LENGTH`. A custom `RateLimits.Key.KeyContext` now carries `request` (`Api.AuthRequestContext.noRequest` when there is none).
