---
"@awthaq/device-authorization": minor
---

`DeviceAuthorization` reads no request facts (ADR-EA-047). `requestCode`, `poll`, `verify`, `approve` and `deny` take no `ip` (and `poll` no `{ userAgent }` argument) and require `Api.AuthRequestContext`: the per-source rules key on the request's address and the redeemed session records the device's address and user agent. The plugin layer no longer requires `ClientAddress`.

Migration: drop `ip` from calls to `requestCode`, `poll`, `verify`, `approve` and `deny`, and the second argument of `poll`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
