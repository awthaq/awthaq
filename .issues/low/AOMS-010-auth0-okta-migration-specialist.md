---
ID: "AOMS-010"
Title: "JWKS cache never expires: stale keys trusted for process lifetime"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:253"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-010 — JWKS cache never expires: stale keys trusted for process lifetime

`LOW` · `security` · `oauth` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

The cache is fetched once and refreshed only on a kid miss (one refetch), with no TTL and no rotation schedule — the module header itself calls this 'no JWKS-rotation refresh policy'. For long-lived coexistence processes (precisely the phased-cutover window this persona runs), a provider key that is revoked or retired remains accepted until process restart, since verification only needs the cached JWK to match the token's kid. Signing correctness is unaffected; key-revocation response time is not.

## Evidence

Source: `packages/oauth/src/OAuth.ts:253`

```
    const cached = HashMap.get(yield* Ref.get(jwksCache), provider.id);
    const jwks = Option.isSome(cached) ? cached.value : yield* fetchAndCacheJwks;
```

## Recommended fix

Add a cache TTL (an hour is the common default) or refetch when the cached entry's age exceeds the provider's rotation interval; keep the kid-miss refetch as the fast path.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: IdP Migration Readiness
- Full dossier: [`auth0-okta-migration-specialist`](../../.reports/auth0-okta-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

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
