---
ID: "TRBS-002"
Title: "No jti is ever minted, so a per-token denylist is not even expressible today"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:232"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-002 — No jti is ever minted, so a per-token denylist is not even expressible today

`MEDIUM` · `security` · `jwt` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

`signClaims` is the one place registered claims are set, and it sets only iat/exp/iss/aud — no `jti` (JWT ID). `.scratch/jwt/spec.md` carries `nbf`/`jti` as pass-through-only 'if explicitly supplied to signJWT'. Without a unique token id, an out-of-band denylist has no O(1) key: the only revocable anchor a minted token carries is `sid`, which (a) exists only for UserPrincipal tokens, and (b) identifies the session, not the token, so revoking one of N tokens minted from a session is impossible — you could only kill all of them. This is the structural reason no blacklist can be retrofitted without a claims change.

## Evidence

Source: `packages/jwt/src/Jwt.ts:232`

```
claims: { ...claims, iat, exp, iss: config.issuer, aud: config.audience },
```

## Recommended fix

Mint a `jti` (uuidv7 or 128-bit random) inside `signClaims` for every signed token, and key the future RevocationStore on it; document that pre-existing tokens (pre-upgrade) fall back to sid-based revocation.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 2ebd195. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:366`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
