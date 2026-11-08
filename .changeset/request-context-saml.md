---
"@awthaq/saml": minor
---

`Saml` and `Sso` read no request facts (ADR-EA-047). `Saml.authnRequest`, `acs` and `slo` (`SamlSlo.SloInput`) take no `ip` (and `acs` no `userAgent`) and require `Api.AuthRequestContext`; `Saml.logout` drops the `ip` it never read; `Sso.start(input)` drops its positional `ip` and requires the context. The per-source rules key on the request's address, the ACS session records its address and user agent, and a rejected assertion is announced through core's `SignIn.failed`. Neither layer requires `ClientAddress` any more.

Migration: drop `ip`/`userAgent` from calls to `Saml.authnRequest`, `acs`, `slo` and `logout`, and the second argument of `Sso.start`; provide `Api.AuthRequestContext` to an in-process call (`Api.AuthRequestContext.noRequest`, `RequestContext.capture(request)`, or `TestAuth.withRequest`).
