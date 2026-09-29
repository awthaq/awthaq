---
ID: "DRS-005"
Title: "Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding"
Level: medium
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:90"
Auditor: "data-residency-sharding-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DRS-005 — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding

`MEDIUM` · `performance` · `sql` · reported by **Data Residency & Sharding Specialist** (`data-residency-sharding-specialist`)

Status: **resolved**

## Summary

Two of the hottest queries have no shard-routable key: users by lower(email) (:90, backed by the unique index at CoreMigrations.ts:215) and accounts by the (providerId, subject, issuer) triple (:274, :274's index at :93). The same global-email pattern recurs in the org plugin (organization_invitation listByEmail, InvitationRecords.ts:59; findPendingByEmailAndOrg :52). None of these predicates contains a tenant/region, so under any partitioning every sign-in becomes either a fan-out across shards or a lookup against a separate global directory — the latter reintroducing the cross-region round trip on the most latency-sensitive path in the system.

## Evidence

Source: `packages/sql/src/Repositories.ts:90`

```
execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
```

## Recommended fix

Make the global-identifier cost explicit: either accept a directory tier scoped to lookup-only (email/subject -> (shard, userId) mapping, cacheable and residency-separable from PII), or prefix these unique indexes with the tenancy column from DRS-001 so sign-in carries the tenant context (e.g. via hosted-domain or org selection) and routes directly.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: data residency readiness
- Full dossier: [`data-residency-sharding-specialist`](../../.reports/data-residency-sharding-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `tenancy-residency`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:90`. Fix: After the uniqueness-scope decision: document the users and accounts tables as the global identity directory, and let tenant-scoped routing apply only to sessions/verification/audit (recommended option A). Under option B, prefix the unique indexes with the tenant column instead. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan; user may revisit. ADR-EA-018 Decision 4 and BEH-EA-232 record users/accounts as the global identity directory (email, phone and (providerId, subject, issuer) unique across tenants, lookups take no tenant predicate); tenant routing applies to sessions/verification/audit. ("tenantId","userId") composite indexes are in migration 25. Tests: sql contract "the login lookups stay global" and core Users "another tenant request still resolves the same identity" (memory, SQL, Postgres).
