---
"@awthaq/server": minor
"@awthaq/password": patch
"@awthaq/two-factor": patch
"@awthaq/magic-link": patch
"@awthaq/passkey": patch
"@awthaq/test": patch
---

`SessionDelivery.respond(request, mint)` is the one call a session-minting handler makes: it validates `X-Awthaq-Token-Delivery`, runs `mint` only after that, then delivers the session as a cookie or a bearer body (plan 01 phase 6).

- `@awthaq/server`: adds `SessionDelivery.respond`; `AuthHttp.coreHandlers` logs one warning at layer build when `RequestContext.layer` is not merged on the router (sessions would record no address or user agent), silenced by providing `RequestContext.warnWhenAbsent` as `false`; `RequestContext.layer` stays opt-in. `README.md` documents both.
- `@awthaq/password`, `@awthaq/two-factor`, `@awthaq/magic-link`, `@awthaq/passkey`: every handler that mints a session goes through `respond`; behaviour on the wire is unchanged (a concealed sign-up still refuses a bad delivery header first).
- `@awthaq/test`: `TestAuth` silences the new warning, since the in-process harness serves without `RequestContext.layer`.
