---
"@awthaq/api-key": minor
---

`ApiKey` reads no request facts (ADR-EA-047): the token endpoint's `tokenByIp` and the key resolver's `resolveByIp` throttle key on the address of the request context (the resolver receives it through the credential claim), so the plugin layer no longer requires `ClientAddress`.

Migration: none for callers (no interface change); a hand-built composition that served the `apikey.token` group without the request context must declare `Api.RequestContext` (see the server changeset).
