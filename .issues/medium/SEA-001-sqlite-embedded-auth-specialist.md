---
ID: "SEA-001"
Title: "Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Account.ts:76"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-001 — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade

`MEDIUM` · `correctness` · `server` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **ready-for-agent**

## Summary

Account deletion cascades across three separate service calls with no transaction and no compensating guard, while the DDL declares no REFERENCES clauses on any child table (accounts.userId, sessions.userId in CoreMigrations.ts migrations 2-3) and no code — repo or driver — sets PRAGMA foreign_keys (SQLite defaults it off per connection; the node driver only sets busy_timeout at SqliteClient.ts:148 and journal_mode at :151). A crash between the first two statements leaves accounts orphaned; a crash between the last two leaves a user with no credentials; Sessions.layerSql verify (packages/core/src/Sessions.ts:482-502) checks only the session row's expiry and hash, never the owning user's existence, so any stranded session row remains fully usable. Each domain service carefully holds transaction boundaries internally (e.g. Accounts.layerSql unlink's sql.withTransaction), but no owner holds the boundary across the three-service cascade.

## Evidence

Source: `packages/server/src/Account.ts:76`

```
        yield* accounts.deleteAllByUser(userId);
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
        yield* users
```

## Recommended fix

Either declare REFERENCES ... ON DELETE CASCADE in both dialect branches plus PRAGMA foreign_keys=ON at client construction, or route deleteUser through a single domain service that wraps the three calls in one sql.withTransaction (BEGIN IMMEDIATE on the node driver already makes that safe and simple). At minimum, make Sessions verify reject rows whose userId no longer exists.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSG-001` — Erasure cascade covers only core tables; plugin-owned PII survives account deletion](high/CSG-001-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`CSG-007` — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll](low/CSG-007-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, low)_`
- [`DRS-002` — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables](high/DRS-002-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, high)_`
- [`SSMS-002` — Zero FK constraints and the shipped whole-user cascade runs without a transaction](medium/SSMS-002-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`
- [`TS-004` — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port](medium/TS-004-tim-smart.md) `_(tim-smart, medium)_`
- [`TRBS-008` — deleteUser still uses the retired SessionId("") revokeOthers trick instead of revokeAll](low/TRBS-008-token-revocation-blacklist-specialist.md) `_(token-revocation-blacklist-specialist, low)_`
- [`WPS-001` — Deleting a user orphans passkey credentials, which can still mint a live session for the deleted user](high/WPS-001-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `gdpr-erasure-export`. Already fixed by commit e940a12. Evidence at HEAD ec065a7: `packages/server/src/Account.ts:103`. Fix: The untransactional cascade is fixed (e940a12). What remains is making the FK-less design an explicit, tested invariant, not adding FKs, since spec/behaviors/12-hooks.md:133 deliberately prefers hook-driven erasure to DB-level cascades. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
