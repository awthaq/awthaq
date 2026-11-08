---
"@awthaq/oauth": minor
---

`OAuth` reads no request facts (ADR-EA-047). `authorize`, `callback` and `exchange` take no `ip` (and `callback` no `userAgent`) and require `Api.AuthRequestContext`: the per-source rules key on the request's address, the callback's session records its address and user agent, and a rejected callback is announced through core's `SignIn.failed`. The plugin layer no longer requires `ClientAddress`.

Migration: drop `ip` and `userAgent` from calls to `OAuth.authorize`, `callback` and `exchange`, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
