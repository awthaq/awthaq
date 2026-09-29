---
ID: "AP-004"
Title: "Userinfo claims merged over id_token claims without the required sub equality check"
Level: medium
Category: "compliance"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:612"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-004 — Userinfo claims merged over id_token claims without the required sub equality check

`MEDIUM` · `compliance` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

For an oidc provider that also exposes userinfo_endpoint, userinfo responses are spread over the verified id_token claims with userinfo winning on overlap — including sub. OIDC Core 5.3.2 requires the client to verify that the userinfo sub exactly equals the id_token sub before using the response; skipping that check means the account anchor (providerId, subject) can be taken from an endpoint response that was never bound to the authenticated token. profile.subject then drives findByProviderSubject and accounts.link, so a divergent or hostile userinfo response silently targets a different account row. The spread also lets unverified userinfo fields overwrite verified id_token claims other than sub.

## Evidence

Source: `packages/oauth/src/OAuth.ts:612`

```
const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });
```

## Recommended fix

After fetching userinfo for an oidc provider, fail with OAuthCallbackFailed unless userinfoClaims.sub === idClaims.sub; consider merging userinfo only for non-identity claims (email, name) and always taking subject from the verified id_token.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-oidc-claims-integrity`. Duplicate of `OIT-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:717`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
