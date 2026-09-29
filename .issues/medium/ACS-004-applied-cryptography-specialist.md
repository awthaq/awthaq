---
ID: "ACS-004"
Title: "JWKS response cast unvalidated before becoming key material"
Level: medium
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "applied-cryptography-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ACS-004 — JWKS response cast unvalidated before becoming key material

`MEDIUM` · `security` · `oauth` · reported by **Applied Cryptography Specialist** (`applied-cryptography-specialist`)

Status: **resolved**

## Summary

The fetched JWKS JSON is type-asserted with no schema validation, and Jwt.ts:97 additionally treats entries with kty === undefined as RSA candidates. The trust boundary for signing key material therefore rests on a cast plus WebCrypto importKey's implicit rejection. An attacker positioned to influence the JWKS fetch (compromised IdP, misconfigured httpClient) can insert arbitrary keys and forge id_tokens; structural validation would not prevent that scenario but would eliminate shape-confusion (missing kty/kid/n/e, unexpected fields) and align with the codebase's own standing rule against raw casts on untrusted wire data, which JwtCodec.ts deliberately honors via Schema for its own tokens.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
      Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Decode the JWKS through an Effect Schema (keys array; each entry requiring string kty/kid/n/e for RSA), drop entries that do not validate, and require kty === "RSA" in findKey.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Cryptographic Primitives
- Full dossier: [`applied-cryptography-specialist`](../../.reports/applied-cryptography-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `oauth-provider-response-decoding`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Fix: Tighten key selection. Decode RSA JWKs structurally and stop admitting kty-less entries. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Jwt.ts: RsaJwkSchema; findKey decodes each JWKS entry with it and drops kty-less/n-less/e-less entries, use!=sig and alg!=RS256; verifyRs256 imports only kty/n/e. Jwt.test.ts 'Jwt.findKey (ACS-004)' tests were red for kty-less, use=enc, alg=RS512, missing-n. Gates as ESS-003.
