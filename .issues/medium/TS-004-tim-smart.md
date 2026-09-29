---
ID: "TS-004"
Title: "deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port"
Level: medium
Category: "architecture"
Status: resolved
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-004 — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port

`MEDIUM` · `architecture` · `server` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **resolved**

## Summary

The persistence spec is explicit that transaction boundaries belong to the calling service (BEH-EA-035; core's layerSql honors it, e.g. Accounts.layerSql's `sql.withTransaction(performUnlink(id))`, Accounts.ts:407), and `@awthaq/ports` even ships a runtime-agnostic `SqlTransaction` port for exactly this (layerNoop for memory, layerSql wrapping SqlClient.withTransaction, SqlTransaction.ts:37-50). The HTTP-layer account-deletion sequence ignores both: a failure after `deleteAllByUser` but before `users.delete` strands a user row with no credentials (or sessions still alive) on SQL backends, with no way to retry through the API since authentication now fails.

## Evidence

Source: `packages/server/src/Account.ts:76`

```
yield* accounts.deleteAllByUser(userId);
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
        yield* users
```

## Recommended fix

Require `SqlTransaction` in the account-group layer and wrap the three writes in `sqlTransaction.withTransaction(...)`; compose `SqlTransaction.layerNoop` into memory/test layers and `layerSql` into SQL compositions, matching the established port convention.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `gdpr-erasure-export`. Already fixed by commit e940a12. Evidence at HEAD ec065a7: `packages/server/src/Account.ts:103`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
