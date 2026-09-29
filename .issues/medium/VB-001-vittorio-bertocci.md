---
ID: "VB-001"
Title: "verifyLive's session liveness check ignores idle expiry"
Level: medium
Category: "security"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:391"
Auditor: "vittorio-bertocci"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# VB-001 — verifyLive's session liveness check ignores idle expiry

`MEDIUM` · `security` · `core` · reported by **Vittorio Bertocci — Token-Based Identity Protocol Expert** (`vittorio-bertocci`)

Status: **resolved**

## Summary

Sessions.list maps its single expiresAt field from absoluteExpiresAt (identically in the SQL layer at Sessions.ts:576), and Jwt.verifyLive (packages/jwt/src/Jwt.ts:286-291) accepts a JWT when any listed row has expiresAt past now. An idle-expired session — one that can no longer authenticate a single cookie or bearer request — still counts as live for the JWT live-check for up to 23 more days (30d absolute minus 7d idle). The revocation surface of the delegation token is therefore strictly weaker than the revocation surface of the credential that minted it: killing a session by inactivity does not propagate to tokens checked through verifyLive.

## Evidence

Source: `packages/core/src/Sessions.ts:391`

```
expiresAt: row.absoluteExpiresAt,
```

## Recommended fix

Expose absoluteExpiresAt/idleExpiresAt on SessionListItem (or add a dedicated Sessions.isLive(userId, sessionId) capability) and have verifyLive require now < idleExpiresAt as well, matching what Sessions.verify itself enforces.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: token architecture
- Full dossier: [`vittorio-bertocci`](../../.reports/vittorio-bertocci/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `session-list-correctness`. Already fixed by commit 6629fd2. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:586`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
