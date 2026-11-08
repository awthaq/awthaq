---
"@awthaq/magic-link": minor
---

`MagicLink` and `EmailOtp` read no request facts (ADR-EA-047). `requestLink`, `requestCode` and both `verify`s take no `ip` and no `{ userAgent }` argument and require `Api.AuthRequestContext`; `Channel.Completion` loses `ip`/`userAgent`. The per-source rules key on the request's address, the session records its address and user agent, and a refusal is announced through core's `SignIn.failed`. Neither layer requires `ClientAddress` any more.

Migration: drop `ip` and the second argument from calls to `MagicLink.requestLink`/`verify` and `EmailOtp.requestCode`/`verify`, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
