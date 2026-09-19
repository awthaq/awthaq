---
ID: "MAPS-006"
Title: "verifyLive live-check scans every session of the subject user to find one sid"
Level: medium
Category: "performance"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:286"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-006 — verifyLive live-check scans every session of the subject user to find one sid

`MEDIUM` · `performance` · `jwt` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

The only revocation-sensitive verification path exists because Sessions exposes no id-only lookup ('verifyLive has no bare id-only session lookup to call', Jwt.ts:35-36), so it lists all of the user's sessions and scans for the sid. Per check that is O(active sessions of the user) rows read from the store - and a power user with dozens of devices makes every live-verified hop proportionally heavier. It also means the natural building block for an introspection endpoint (MAPS-002) is missing at the core layer.

## Evidence

Source: `packages/jwt/src/Jwt.ts:286`

```
const rows = yield* sessions.list(Users.UserId(sub));
```

## Recommended fix

Add Sessions.getById(id) to the SessionsShape (both memory and SQL layers), and re-implement verifyLive on it; the introspection endpoint should reuse the same lookup.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-012` — Sessions and JWTs carry no authentication-method record (no amr/acr equivalent)](low/AOMS-012-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, low)_`
- [`FAMS-009` — verifyLive scans all of a user's sessions per token check](low/FAMS-009-firebase-auth-migration-specialist.md) `_(firebase-auth-migration-specialist, low)_`
- [`JH-008` — Ports-never-provided sandboxing rule is convention, not an enforced boundary](low/JH-008-jared-hanson.md) `_(jared-hanson, low)_`
- [`MAPS-005` — x-jwt-token mirrored onto every authenticated response hands out a portable credential silently](medium/MAPS-005-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`NAM-001` — No stateless JWT session strategy: Jwt plugin still requires the live Sessions store](high/NAM-001-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, high)_`
- [`OCM-006` — JWT mint is exclusively session-bound — no path issues a token to a machine credential](info/OCM-006-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, info)_`
- [`OCM-007` — No immediate revocation story exists for machine credentials; the only revocation-aware verify is session-scoped](low/OCM-007-oauth2-client-credentials-m2m-specialist.md) `_(oauth2-client-credentials-m2m-specialist, low)_`
- [`PDR-003` — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out](medium/PDR-003-philippe-de-ryck.md) `_(philippe-de-ryck, medium)_`
- … 11 more findings touch `packages/jwt/src/Jwt.ts`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-19):** Fixed as a byproduct of resolving the higher-severity `TIR-002` (same source file, same evidence line — `verifyLive`'s live-check was wrong by half the expiry model, not just O(sessions-per-user) instead of O(1)). Added `Sessions.isLive(userId, id)` — a keyed lookup, exactly this finding's own `Sessions.getById`-shaped recommendation — replacing `Jwt.ts`'s `sessions.list(...)` scan; both `verifyLive` and `introspectLive` (MAPS-002's own endpoint building block) now share this one implementation via `sidStillLive`. See `TIR-002`'s resolution comment for full detail.
