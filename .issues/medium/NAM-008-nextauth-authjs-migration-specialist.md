---
ID: "NAM-008"
Title: "No OAuth token refresh: refresh tokens persisted but never used"
Level: medium
Category: "dx"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:13"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-008 — No OAuth token refresh: refresh tokens persisted but never used

`MEDIUM` · `dx` · `oauth` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

The Account model stores accessToken/refreshToken (Models.ts:94-95), and Auth.js v5 both persists `expires_at` and refreshes provider tokens via the `token` callback, keeping server-side provider API access alive. effect-auth stops at the initial exchange: the header explicitly documents 'no token refresh operation', and the Account model has no expires_at/scope/token_type columns, so a migrated app that calls provider APIs on the user's behalf (Google calendar, GitHub repo listing — a common reason those providers are installed at all) loses that capability at cutover, with the stored refresh token as a unusable souvenir. The gap is honestly documented in-source, which is why this is medium not high.

## Evidence

Source: `packages/oauth/src/OAuth.ts:13`

```
no token refresh operation (nothing in BEH-EA-121..128
requires it — a real gap for a production deployment, the same category
of documented deferral as `Verification.layerSql`),
```

## Recommended fix

Add a refresh flow (rotate on expiry using the persisted refresh token) and extend Account with expiresAt/scope so Auth.js token-callback logic has a destination; until then, state the capability loss prominently in migration docs.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `provider-token-storage`. Already fixed by commit e773cf1. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:16`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
