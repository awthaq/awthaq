---
ID: "BAM-008"
Title: "OAuth token lifecycle is thinner: no refresh, no idToken/expiry/scope columns"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:14"
Auditor: "better-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BAM-008 — OAuth token lifecycle is thinner: no refresh, no idToken/expiry/scope columns

`MEDIUM` · `api` · `oauth` · reported by **better-auth Migration Specialist** (`better-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

The plugin header scopes out token refresh, calling it a real gap for production. The Account model stores only accessToken/refreshToken (packages/sql/src/Models.ts:94-95) — no idToken, no accessTokenExpiresAt, no scope — while better-auth's Account entity carries idToken alongside access/refresh tokens. Post-migration, users whose access tokens expire (Google: ~1 hour) cannot refresh and must re-run consent flows the old system handled silently; provider presets are also absent (documented), so every provider is hand-configured.

## Evidence

Source: `packages/oauth/src/OAuth.ts:14`

```
// own header), no token refresh operation (nothing in BEH-EA-121..128
```

## Recommended fix

Add accessTokenExpiresAt/scope columns and a refresh operation to the OAuth plugin before advertising OAuth-account migration; map better-auth's idToken column during import (drop or store) so no source field is silently lost, per BEH-EA-207's own rule.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: better-auth parity
- Full dossier: [`better-auth-migration-specialist`](../../.reports/better-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 46 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `provider-token-storage`. Evidence at HEAD ec065a7: `packages/core/src/Accounts.ts:85`. Fix: Persist the provider's id_token (encrypted at rest, like access/refresh tokens) as part of ProviderTokenSet so better-auth account imports have a destination and a future RP-initiated logout can send id_token_hint. (effort M). Full dossier: `.plan/slices/03-oauth-flow.md`. Status → ready-for-agent.
