---
ID: "SSMS-002"
Title: "Zero FK constraints and the shipped whole-user cascade runs without a transaction"
Level: medium
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-002 — Zero FK constraints and the shipped whole-user cascade runs without a transaction

`MEDIUM` · `correctness` · `server` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

No migration declares a FOREIGN KEY (accounts.userId at CoreMigrations.ts:84 and sessions.userId at :117 are bare TEXT NOT NULL), so cascade-on-delete is caller-managed - a defensible choice only if every caller composes the three deletes atomically. deleteUser does not: accounts are deleted, then sessions revoked, then the user row deleted, each a separate auto-committed statement. A failure or crash between the first and last step leaves durable partial state - a live user with zero credentials, or orphaned accounts - with no recovery path. The repository layer deliberately holds no transaction boundary (packages/sql/src/Repositories.ts:6-8), and the SqlTransaction port built for exactly this (packages/ports/src/SqlTransaction.ts) is not required by this handler. The contrast inside the repo proves the pattern is known: Accounts.unlink wraps its read-and-delete in sql.withTransaction (packages/core/src/Accounts.ts:407).

## Evidence

Source: `packages/server/src/Account.ts:76`

```
yield* accounts.deleteAllByUser(userId);
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
        yield* users
```

## Recommended fix

Require SqlTransaction in AccountHandlers and wrap the three-way cascade, mirroring Accounts.unlink; longer term, add FK ON DELETE CASCADE for accounts.userId/sessions.userId in an expand migration, or document the FK-less choice as an explicit invariant with a reconciliation job.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SEA-001` — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade](medium/SEA-001-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `gdpr-erasure-export`. Duplicate of `SEA-001` — closed by that issue's fix. Already fixed by commit e940a12. Evidence at HEAD ec065a7: `packages/server/src/Account.ts:103`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
