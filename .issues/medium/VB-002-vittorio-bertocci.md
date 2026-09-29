---
ID: "VB-002"
Title: "verifyLive scans only the first page of sessions (200 rows)"
Level: medium
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/Jwt.ts:286"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-002 — verifyLive scans only the first page of sessions (200 rows)

`MEDIUM` · `correctness` · `jwt` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

The live check asks is this sid still live by listing all of the user's sessions and scanning, but Sessions.list is capped at LIST_PAGE_SIZE = 200 (packages/core/src/Sessions.ts:418; SQL listByUser(userId, undefined, 200) at Sessions.ts:570). A user with more than 200 sessions whose token references a session beyond the first cursor page gets a valid token wrongly rejected — fail-closed denial, no bypass — and every verification pays an O(n) scan plus a full user-session query that a direct id lookup would avoid.

## Evidence

Source: `packages/jwt/src/Jwt.ts:286`

```
const rows = yield* sessions.list(Users.UserId(sub));
            const stillLive = rows.some(
              (row) =>
```

## Recommended fix

Add a direct id-keyed liveness lookup to the Sessions shape (findById already exists in the SQL repository) and use it from verifyLive instead of list-and-scan.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

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
