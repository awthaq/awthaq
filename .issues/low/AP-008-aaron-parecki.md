---
ID: "AP-008"
Title: "Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires"
Level: low
Category: "correctness"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:248"
Auditor: "aaron-parecki"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AP-008 — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires

`LOW` · `correctness` · `oauth` · reported by **IETF OAuth Working Group / Creator of IndieAuth** (`aaron-parecki`)

Status: **resolved**

## Summary

Both provider-controlled JSON documents are trusted with type assertions and no schema validation: the discovery document (OAuthProvider.ts:142, `body as DiscoveryDocument`) and the JWKS (OAuth.ts:248). A provider returning a malformed JWKS (e.g. keys not an array) makes jwks.keys.filter throw inside Effect.map, which is a defect (die) rather than the typed OAuthCallbackFailed every other provider failure maps to — the user gets a 500 instead of a 400. Additionally the JWKS cache (Ref/HashMap keyed by provider id) has no TTL or staleness bound: entries live for the process lifetime, so a removed-but-cached key keeps validating and the refetch path is the only escape (see AP-002). Not exploitable — signatures are still verified — but it is an input-validation and robustness gap on the trust boundary.

## Evidence

Source: `packages/oauth/src/OAuth.ts:248`

```
Effect.map((body) => body as unknown as Jwt.Jwks),
```

## Recommended fix

Parse both documents with a Schema (keys: array of objects with kty/kid/n/e) mapping failures to OAuthCallbackFailed, and give the JWKS cache a TTL (e.g. 5-15 minutes) with refetch-on-verification-failure.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: OAuth2 spec compliance
- Full dossier: [`aaron-parecki`](../../.reports/aaron-parecki/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- [`ACS-004` — JWKS response cast unvalidated before becoming key material](medium/ACS-004-applied-cryptography-specialist.md) `_(applied-cryptography-specialist, medium)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `oauth-provider-response-decoding`. Duplicate of `ESS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:323`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `ESS-002-effect-schema-specialist` — closed by its fix (see that issue's Resolved comment).
