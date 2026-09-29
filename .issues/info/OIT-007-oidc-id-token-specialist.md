---
ID: "OIT-007"
Title: "at_hash unimplemented; auth_time/max_age absent — acceptable for the code-only flow but undocumented"
Level: info
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:174"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-007 — at_hash unimplemented; auth_time/max_age absent — acceptable for the code-only flow but undocumented

`INFO` · `compliance` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

The plugin always uses response_type=code (the only response_type it can build), so per OIDC Core 3.1.3.7 at_hash validation is optional and its absence is compliant — this finding records the fact, not a defect. However nothing in the module header or Jwt.ts header (which carefully documents the RS256-only and no-rotation-policy deferrals) mentions at_hash, auth_time, or max_age support being deliberately out of scope; grep confirms zero mentions in the package. If a hybrid flow or a freshness/step-up requirement (auth_time with max_age) is ever added, the codebase has no seam for either, and the current verifier would not notice an access token whose hash does not match.

## Evidence

Source: `packages/oauth/src/OAuth.ts:174`

```
url.searchParams.set("response_type", "code");
```

## Recommended fix

Record the deferral in the Jwt.ts/OAuth.ts header comments next to the existing ES256 and rotation-policy deferrals, and add a note that at_hash becomes REQUIRED the moment any non-code response type is introduced.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: OIDC id_token validation
- Full dossier: [`oidc-id-token-specialist`](../../.reports/oidc-id-token-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 7 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:198`. Fix: Document the at_hash/auth_time/max_age deferral next to the existing RS256 deferral, and pin response_type=code structurally. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Jwt.ts header documents the at_hash / auth_time / max_age deferral (at_hash becomes required if a hybrid/implicit response type is ever added; step-up is wayfinder ticket 15); OAuth.ts pins response_type via const RESPONSE_TYPE = 'code' (a const string literal already has the literal type -- no assertion needed); packages/oauth/README.md 'OIDC validation scope' table lists what is and is not validated; BEH-EA-127 amended. Docs only, no test.
