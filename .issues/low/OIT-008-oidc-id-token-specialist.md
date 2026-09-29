---
ID: "OIT-008"
Title: "All id_token failure reasons collapse into one reason-free error, discarding JwtVerificationError's typed reason"
Level: low
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:263"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-008 — All id_token failure reasons collapse into one reason-free error, discarding JwtVerificationError's typed reason

`LOW` · `dx` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

Jwt.ts models verification failures as a typed Data.TaggedError carrying a reason string ('malformed JWT', 'no matching JWKS key', 'signature verification failed'), which is exactly the Schema.TaggedError pattern this persona expects — and verifyIdToken immediately erases it, mapping every failure path (bad signature, missing JWKS, wrong iss, wrong aud, expired, wrong nonce) onto the single empty OAuthCallbackFailed (OAuthApi.ts:40-44, no fields). Keeping the wire response opaque is a reasonable anti-oracle choice, but the internal plugin-service boundary loses the ability to distinguish a provider misconfiguration (wrong clientId) from an attack signal (nonce mismatch) in logs and metrics, which is operationally costly during login outages.

## Evidence

Source: `packages/oauth/src/OAuth.ts:263`

```
Effect.mapError(() => new OAuthApi.OAuthCallbackFailed()),
```

## Recommended fix

Keep OAuthCallbackFailed wire-opaque but thread a discriminated reason into the internal error (a separate internal tagged error or a Log/Telemetry emit at each failure site) so operators can tell rotation breakage (OIT-002) from replay attempts without re-deriving it from nothing.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:348`. Fix: Keep the wire error opaque, and carry a discriminated internal reason for logs and spans. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New CallbackFailure.ts: CallbackFailureReason union + callbackFailed(reason, detail?) (logs 'oauth callback failed: <reason>' at warn with reason annotated, annotates the current span oauth.failure_reason, then fails with the unchanged field-less OAuthCallbackFailed) and providerFailure(stage, error) (503 vs 400 classification + reason logging); every OAuthCallbackFailed site in OAuth.ts/IdToken.ts now goes through them, passing Jwt.ts reasons as detail. No fields added to the wire error. Test: wrong nonce logs 'oauth callback failed: nonce' while JSON of the error is exactly {"_tag":"OAuthCallbackFailed"} (red before: no log). Also added a no-subject guard (a profile with an empty/missing subject fails closed). Gates as MA-002.
