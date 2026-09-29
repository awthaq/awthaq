---
ID: "RRS-007"
Title: "OAuth refresh tokens never captured, never stored, never refreshed — encrypted columns are dead plumbing"
Level: medium
Category: "architecture"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:213"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-007 — OAuth refresh tokens never captured, never stored, never refreshed — encrypted columns are dead plumbing

`MEDIUM` · `architecture` · `oauth` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

exchangeCode's TokenSet (OAuth.ts:187-190) carries no refresh_token and the parser reads only access_token/id_token, so the provider's refresh token is dropped on the floor; accounts.link is called with neither credentialHash nor tokens (OAuth.ts:628-634, 695-701), and core's layerSql inserts accessToken/refreshToken as null (Accounts.ts:349-350). The ticket-18 machinery that encrypts these columns at rest (AES-256-GCM, kid envelope, row+column AAD binding in Repositories.ts:158-261) therefore protects values only tests ever write (packages/sql/test/Repositories.test.ts:141-142). The OAuth.ts:13-15 header admits "no token refresh operation ... a real gap for a production deployment": a deployment integrating an upstream IdP grant cannot refresh or rotate it, and any future consumer would present stale access tokens and dead refresh tokens (providers like Google invalidate old refresh tokens on re-consent).

## Evidence

Source: `packages/oauth/src/OAuth.ts:213`

```
const body = (yield* response.json) as {
      readonly access_token?: string;
      readonly id_token?: string;
    };
```

## Recommended fix

Either ship the flow — capture refresh_token in TokenSet, persist via the already-encrypted columns, refresh on expiry with rotate-on-use and revoke-on-reuse semantics — or remove the dead columns and their encryption plumbing until the flow exists, so the schema does not imply a capability the runtime lacks.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `provider-token-storage`. Already fixed by commit e773cf1. Evidence at HEAD ec065a7: `packages/oauth/src/OAuth.ts:250`. Full dossier: `.plan/slices/03-oauth-flow.md`. Status → resolved.
