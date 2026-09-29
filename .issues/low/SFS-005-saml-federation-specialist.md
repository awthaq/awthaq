---
ID: "SFS-005"
Title: "Single-algorithm RS256 equality gate is the only algorithm-policy precedent"
Level: low
Category: "security"
Status: wontfix
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:242"
Auditor: "saml-federation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SFS-005 — Single-algorithm RS256 equality gate is the only algorithm-policy precedent

`LOW` · `security` · `oauth` · reported by **SAML Federation Specialist** (`saml-federation-specialist`)

Status: **wontfix**

## Summary

An allow-list of exactly one algorithm is defensible for OIDC id_tokens, but SAML ecosystems routinely negotiate rsa-sha256/384/512 and ECDSA variants, and ADFS-era IdPs present weak or unexpected algorithms. The repo's own DBC reference for SSO (better-auth/04-oauth-and-federation/05-sso.md:206-214) requires an explicit strong-algorithm set, named-weak handling with configured response, and unconditional rejection of unrecognized algorithms — a materially different policy shape than this equality check.

## Evidence

Source: `packages/oauth/src/OAuth.ts:242`

```
if (decoded.header.alg !== "RS256") {
```

## Recommended fix

When the SamlSigner port is specified, define the algorithm allow-list as data (strong set + named-weak set + reject-unknown default-deny), not as a copied single-value comparison.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: SAML Federation
- Full dossier: [`saml-federation-specialist`](../../.reports/saml-federation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 14 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:313`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/03-oauth-flow.md`.

**Wontfix (2026-09-29):** Overtaken by events. The single RS256 equality gate this cited (`OAuth.ts`, id_token) is gone: `Jwt.ts` now has an explicit `SigningAlg` table (RS256, PS256, ES256, ES384, EdDSA; AOMS-005) chosen from discovery data rather than the token header, with HS256/`none` refused (OIT-009). SAML has its own allow-list as data (`packages/saml/src/XmlSignatureNode.ts`: rsa-sha256/rsa-sha512 signatures, sha256/sha512 digests) with weak or confusable algorithms (SHA-1, DSA, HMAC, inclusive c14n, XSLT/XPath transforms) refused and named in the log. The 'named-weak with a configured response' option is deliberately not offered: refusing outright is the safer default for a pre-release library.
