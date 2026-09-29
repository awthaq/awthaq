---
ID: "TRBS-004"
Title: "verifyLive liveness check scans a 200-row oldest-first page and can reject live tokens"
Level: medium
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:286"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-004 — verifyLive liveness check scans a 200-row oldest-first page and can reject live tokens

`MEDIUM` · `correctness` · `jwt` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

verifyLive answers 'is session sid still live' by listing the user's sessions and searching the page for the sid. `sessions.list` pages LIST_PAGE_SIZE = 200 (Sessions.ts:418) ordered `createdAt ASC, id ASC` (Repositories.ts:383-384), so page one is the user's 200 oldest sessions. A user with more than 200 concurrent sessions (the exact heavy-automation profile that uses API-style JWTs) has newer sessions — including the one the JWT names — outside page one, so `stillLive` is false and verifyLive rejects a perfectly live token: fail-closed, but a correctness cliff with no error distinguishing it from real revocation. It is also O(page) work on every live-check where an id-targeted lookup would be O(1).

## Evidence

Source: `packages/jwt/src/Jwt.ts:286`

```
const rows = yield* sessions.list(Users.UserId(sub));
            const stillLive = rows.some(
              (row) =>
```

## Recommended fix

Add an id-targeted liveness primitive to Sessions (findByIdIncludingExpired or isLive(sid)) and use it in verifyLive; keep the list endpoint for device UI only.

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
