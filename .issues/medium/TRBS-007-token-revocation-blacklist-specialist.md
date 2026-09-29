---
ID: "TRBS-007"
Title: "verifyLive checks absolute expiry only and accepts idle-expired sessions"
Level: medium
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:288"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-007 — verifyLive checks absolute expiry only and accepts idle-expired sessions

`MEDIUM` · `security` · `jwt` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

The liveness predicate compares the row's `expiresAt`, but `Sessions.list` maps `expiresAt: row.absoluteExpiresAt` (Sessions.ts:391) — idle expiry (`idleExpiresAt`, default 7 days) is invisible through this surface. A session that idle-expired weeks ago but was never explicitly revoked still occupies its row (expired rows are not pruned, TRBS-006), so `verifyLive` keeps accepting its JWT until absolute expiry (default 30 days) even though the same user's cookie flow fails SessionExpired for that session. The doc comment promises 'an unrevoked, unexpired session'; the implementation delivers 'unrevoked, not-absolutely-expired'. Two different expiries, one checked — a stale-trust window exactly of the kind this domain exists to close.

## Evidence

Source: `packages/jwt/src/Jwt.ts:288`

```
row.id === Sessions.SessionId(sid) &&
                DateTime.toEpochMillis(row.expiresAt) > DateTime.toEpochMillis(now),
```

## Recommended fix

Extend SessionListItem with idleExpiresAt (or add the id-targeted liveness primitive from TRBS-004) and make the predicate `now < min(absolute, idle)`; alternatively have verifyLive call Sessions.verify-equivalent logic on the sid.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `None`. Already fixed by commit 6629fd2. Evidence at HEAD ec065a7: `packages/jwt/src/Jwt.ts:443`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.
