---
"@awthaq/two-factor": minor
---

`TwoFactor` reads no request facts (ADR-EA-047). `verify` and `verifyRecovery` take no `ip` and no `{ userAgent }` argument and require `Api.AuthRequestContext`: the per-source rule keys on the request's address and the completed sign-in's session records its address and user agent. The plugin layer no longer requires `ClientAddress`.

Migration: drop `ip` and the second argument from calls to `TwoFactor.verify` and `verifyRecovery`, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
