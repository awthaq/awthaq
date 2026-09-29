---
ID: "OAP-007"
Title: "JWKS cache is a process-lifetime Ref with no TTL; revoked provider keys stay accepted until restart or kid change"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:254"
Auditor: "oauth2-authorization-code-pkce-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OAP-007 — JWKS cache is a process-lifetime Ref with no TTL; revoked provider keys stay accepted until restart or kid change

`LOW` · `security` · `oauth` · reported by **OAuth2 Authorization Code + PKCE Specialist** (`oauth2-authorization-code-pkce-specialist`)

Status: **resolved**

## Summary

The per-provider JWKS is fetched once and cached in a module-level Ref; the only refresh path is a kid cache miss (OAuth.ts:256-261). If a provider revokes or removes a key while keeping the same kid (post-compromise revocation, emergency rotation reusing kid), tokens signed with the removed key continue to verify until process restart. exp checking bounds the window, but flow TTL is 10 minutes while access tokens commonly live an hour, and Jwt.ts's own header admits 'no JWKS-rotation refresh policy beyond refetch once on a kid cache miss.'

## Evidence

Source: `packages/oauth/src/OAuth.ts:254`

```
    const cached = HashMap.get(yield* Ref.get(jwksCache), provider.id);
    const jwks = Option.isSome(cached) ? cached.value : yield* fetchAndCacheJwks;
```

## Recommended fix

Cache JWKS with a timestamp and treat entries older than a few minutes as stale (refetch before use), or at minimum expose cache invalidation so a rotation can be forced without redeploying.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: OAuth2 OIDC flows
- Full dossier: [`oauth2-authorization-code-pkce-specialist`](../../.reports/oauth2-authorization-code-pkce-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `oauth-provider-response-decoding`. Already fixed by commit fd8e5e9. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:95`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
