---
ID: "SSMS-007"
Title: "Boolean write path uses literal 1 and leans on driver reconciliation for Postgres"
Level: low
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:97"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-007 — Boolean write path uses literal 1 and leans on driver reconciliation for Postgres

`LOW` · `correctness` · `sql` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **resolved**

## Summary

The DDL itself is dialect-correct (BOOLEAN on pg, INTEGER on sqlite, CoreMigrations.ts:62/71), and the read schema is Schema.BooleanFromBit, which accepts only the literals 0|1 (effect Schema.ts:9906-9908) - i.e., it is pinned to SQLite's encoding. The raw UPDATE writes literal 1, which works on Postgres only through its integer-to-boolean assignment cast, and pg reads return driver-decoded booleans (cross-checked @effect/sql-pg PgTypes.ts:1165-1168 decodes OID.bool to JS true/false), so the pg round-trip holds together through behavior the model schema does not itself declare. It is currently proven - the CI-gated Postgres contract suite asserts emailVerified round-trips (.github/workflows/check.yml:28-42, Repositories.postgres.test.ts:130-131) - but a driver change or a local run without AWTHAQ_POSTGRES_URL (where the suite silently skips) would surface this as a decode failure far from the cause.

## Evidence

Source: `packages/sql/src/Repositories.ts:97`

```
yield* sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`;
```

## Recommended fix

Write TRUE (accepted by both dialects) or encode through the model's own BooleanFromBit instead of a raw literal, and consider asserting in the SQLite suite that the persisted form is 0/1 so both encodings stay pinned independently of the optional pg run.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `sql-dialect-neutral-models`. Already fixed by commit b8d6177. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:105`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.

**Resolved (2026-09-29):** Already fixed by b8d6177; now superseded by PPS-007/TS-001 (dialect boolean codec, real Postgres verifyEmail case green).
