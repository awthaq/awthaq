---
ID: "PPS-003"
Title: "findByIdentifier cannot use the partial unique index and verification_tokens history grows unboundedly"
Level: medium
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:535"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-003 — findByIdentifier cannot use the partial unique index and verification_tokens history grows unboundedly

`MEDIUM` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

The only index on verification_tokens is the partial unique index on (identifier) WHERE "consumedAt" IS NULL (CoreMigrations.ts:173-174). findByIdentifier has no consumedAt predicate, so Postgres cannot use that index at all and falls back to a sequential scan; consumed rows are never deleted (upsertLive deliberately preserves history per ADR-EA-016), so the table grows with every issued token and this query degrades linearly. tryConsume's UPDATE (Repositories.ts:570-577) is fine — its consumedAt IS NULL predicate implies the partial index — but findByIdentifier is a public repository method with no production callsite yet; the first caller inherits a table scan over unbounded history.

## Evidence

Source: `packages/sql/src/Repositories.ts:535`

```
sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
```

## Recommended fix

Add a plain (non-partial) btree index on (identifier, "createdAt" DESC) so findByIdentifier is an index scan, and/or define a retention story (scheduled delete of consumed rows past a TTL) so the history table does not grow without bound; both are cheap to add in a new forward-only migration.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-store-hygiene`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:640`. Fix: Scope `findByIdentifier` to the live row so the existing partial unique index serves it with at most one row and no sort. History growth is handled by CSG-003's retention sweep (ticket 30), not a new index. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** VerificationRepository.findByIdentifier is scoped to the live row (AND consumedAt IS NULL, no ORDER BY/LIMIT) so the partial unique index serves it. Tests: findByIdentifier returns None after consume; EXPLAIN QUERY PLAN uses verification_tokens_live_identifier with no temp b-tree (packages/sql/test/Repositories.test.ts); postgres assertion added to the skipped pg suite.
