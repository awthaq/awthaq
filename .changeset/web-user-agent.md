---
"@awthaq/web": minor
---

`UserAgent` and `makeCookieStore`: an in-process user agent over a web handler, with an RFC 6265bis cookie store (`browser` and `trusted` policies), the CSRF echo, bearer delivery that follows `set-auth-token` and `x-awthaq-session-ended`, and cross-site simulation (`site`, `navigation`) (BEH-EA-344). `UserAgent.client(agent, api)` is a typed `HttpApiClient` over an agent. `inProcessClient`/`makeInProcessClient` are built on it (`trusted` policy) and now honour `Expires` and `Path` within an action. `parseSetCookie` also returns `rawValue` and `options.partitioned`; `parseCookieHeader` and `decodeCookieValue` are exported.

Migration: none for the API. A server action that relied on a cookie expired by `Expires` alone, or scoped to another `Path`, still reaching the action's later calls no longer gets it.
