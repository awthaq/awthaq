---
"@awthaq/web": minor
"@awthaq/next": minor
"@awthaq/api": minor
"@awthaq/core": patch
---

`getSession` and `applyRotatedSession` honour the configured `SessionCookieConfig`: under `SessionCookie.SecureDomain` the session is read from `__Secure-session` (and `__Secure-impersonation`) and a rotation is written with the configured name, `Domain` and `SameSite` (BEH-EA-055/185). `hasSessionCookie` checks the configured name (BEH-EA-188). `Api.sessionCookieName` is the one naming rule; `hasSessionCookie` is also exported from `@awthaq/web/cookies`.

Migration: `hasSessionCookie(request)` -> `hasSessionCookie(request, cookie)`, passing the same partial you give `SessionCookie.config(...)` (`{}` for the default). `Session.rotated` is now `{ token, cookie }`; read `rotated.token` where you read the raw secret.
