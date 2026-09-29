---
ID: "AOMS-004"
Title: "aud claim compared by string equality: multi-audience id_tokens always fail federation"
Level: medium
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:272"
Auditor: "auth0-okta-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AOMS-004 — aud claim compared by string equality: multi-audience id_tokens always fail federation

`MEDIUM` · `correctness` · `oauth` · reported by **Auth0/Okta Migration Specialist** (`auth0-okta-migration-specialist`)

Status: **resolved**

## Summary

`claims["aud"] !== provider.clientId` is a strict string comparison. Auth0 and Entra ID issue array-valued aud whenever a client is authorized for more than one API (extremely common in migrated tenants that keep their legacy API audience), and OIDC spec says aud may be an array of strings; in that case every callback fails with OAuthCallbackFailed and there is no azp check to scope the token to this client. A tenant that federates fine in a greenfield proof-of-concept breaks the moment real audiences are added — the kind of cutover-day surprise a migration specialist is hired to prevent.

## Evidence

Source: `packages/oauth/src/OAuth.ts:272`

```
      claims["iss"] !== expectedIssuer ||
      claims["aud"] !== provider.clientId ||
      exp === undefined ||
```

## Recommended fix

Accept both string and array aud: succeed when clientId is in the array, then require azp === clientId when the array has more than one entry (and optionally when azp is present at all), per OIDC Core §3.1.3.7.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-oidc-claims-integrity`. Duplicate of `OIT-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `OIT-003-oidc-id-token-specialist` — closed by its fix (see that issue's Resolved comment).
