---
ID: "FAMS-009"
Title: "verifyLive scans all of a user's sessions per token check"
Level: low
Category: "performance"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:286"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-009 — verifyLive scans all of a user's sessions per token check

`LOW` · `performance` · `jwt` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

Firebase ID tokens are stateless — verification is signature plus expiry, with revocation handled via validSince/auth_time. effect-auth's verifyLive instead materializes every session row for the subject on each verification to check whether the sid is still live. That couples JWT validity to server state (stronger revocation than Firebase, a genuine plus), but the check is O(sessions-per-user) per verified token and touches a growing table for any user with many devices.

## Evidence

Source: `packages/jwt/src/Jwt.ts:286`

```
const rows = yield* sessions.list(Users.UserId(sub));
const stillLive = rows.some(
```

## Recommended fix

Add a Sessions.existsLive(userId, sessionId) capability (a keyed lookup) or a compact sid-liveness cache, keeping the stronger-than-Firebase revocation semantics without the full listing.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`MAPS-006` — verifyLive live-check scans every session of the subject user to find one sid](medium/MAPS-006-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-19):** Fixed as a byproduct of resolving the higher-severity `TIR-002` (same source file, same evidence line — `verifyLive`'s live-check was wrong by half the expiry model, not just O(sessions-per-user) instead of O(1)). Added `Sessions.isLive(userId, id)`, a single keyed lookup — exactly the `Sessions.existsLive`-shaped capability this finding's own recommended fix asked for — replacing `Jwt.ts`'s `sessions.list(...)` scan entirely. See `TIR-002`'s resolution comment for full detail.
