---
"@awthaq/passkey": minor
---

`Passkey` reads no request facts (ADR-EA-047). `authenticateOptions` takes no `ip`, and `authenticateVerify` takes no `ip` and no second `context` argument; both require `Api.AuthRequestContext`. The session records the request's address and user agent, the per-source rules key on its address, and a refused assertion is announced through core's `SignIn.failed`. The plugin layer no longer requires `ClientAddress`.

Migration: call `Passkey.authenticateOptions({ email? })` and `Passkey.authenticateVerify(payload)` without `ip` or the `{ userAgent }` argument, and provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
