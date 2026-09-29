---
ID: "OIT-006"
Title: "Nonce check is conditional on the flow having a nonce; verifier does not enforce presence for oidc"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:275"
Auditor: "oidc-id-token-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# OIT-006 — Nonce check is conditional on the flow having a nonce; verifier does not enforce presence for oidc

`LOW` · `security` · `oauth` · reported by **OIDC ID Token Specialist** (`oidc-id-token-specialist`)

Status: **resolved**

## Summary

The nonce claim is only checked when the decrypted flow state carries a nonce. Today that is safe because authorize unconditionally mints one for every provider of kind oidc (OAuth.ts:464-467), so the skip branch is unreachable in the wired flow. But verifyIdToken itself does not know the provider kind and would happily accept a nonce-less id_token if flow.nonce ever became undefined — e.g. an older persisted flow payload, a payload reshaped by isFlowPayload (which does not validate the nonce field), or a future refactor that decouples nonce generation. Token substitution/replay protection would then vanish silently rather than fail closed.

## Evidence

Source: `packages/oauth/src/OAuth.ts:275`

```
(nonce !== undefined && claims["nonce"] !== nonce)
```

## Recommended fix

Pass provider.kind (or a boolean requiresNonce) into verifyIdToken and fail when kind is oidc and the flow nonce is missing, keeping the comparison strict when present. Alternatively assert at the call site that nonce !== undefined for oidc providers before invoking the verifier.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `oauth-oidc-claims-integrity`. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:356`. Fix: Make the nonce mandatory for oidc verification, and schema-decode the flow payload instead of the cast-based guard. (effort S). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** FlowPayloadSchema decode (done with ESS-003) plus: the nonce is mandatory for oidc -- IdToken.verify takes nonce: string, the callback fails 'missing-nonce' when an oidc flow payload has none, and an id_token without a nonce claim is rejected. Tests: hand-issued Verification entry with no nonce fails closed (red before: verified without a nonce), id_token without nonce claim rejected. Gates as MA-002.
