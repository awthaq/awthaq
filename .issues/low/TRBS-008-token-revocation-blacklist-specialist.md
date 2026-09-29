---
ID: "TRBS-008"
Title: "deleteUser still uses the retired SessionId(\"\") revokeOthers trick instead of revokeAll"
Level: low
Category: "api"
Status: resolved
Package: "server"
Source: "packages/server/src/Account.ts:77"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-008 — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll

`LOW` · `api` · `server` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **resolved**

## Summary

Upstream-hardening ticket 02 added the real `revokeAll` primitive specifically to retire the empty-string-id trick, and Password.ts:664 was migrated (`sessions.revokeAll(userId)`), but Account.ts's deleteUser kept the sentinel: it works only because no real session can ever have id "" — an invariant nothing in the Sessions type enforces (SessionId is a bare branded string). If issuance ever minted or a caller supplied an id of "", this call would keep that session alive while killing the rest, and every reader must re-derive the trick's safety from a comment. The cutover ticket's own intent ('retiring the empty-string-id revokeOthers trick', Password.ts:660-663) is only half-landed.

## Evidence

Source: `packages/server/src/Account.ts:77`

```
yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
```

## Recommended fix

Replace with `sessions.revokeAll(userId)` — same observable effect (deleteUser wants every session gone, including the caller's own, which revokeOthers-with-sentinel already targets), completing the ticket-02 cutover.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `gdpr-erasure-export`. Already fixed by commit ec065a7. Evidence at HEAD ec065a7: `packages/server/src/Account.ts:112`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
