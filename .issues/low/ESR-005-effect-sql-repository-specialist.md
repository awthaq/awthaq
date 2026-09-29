---
ID: "ESR-005"
Title: "findByIdentifier cannot use the identifier index for consumed history and sorts unindexed"
Level: low
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:535"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-005 — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed

`LOW` · `performance` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

The only index touching `identifier` is the partial unique index `ON verification_tokens(identifier) WHERE "consumedAt" IS NULL` (CoreMigrations.ts:173-174). This query deliberately includes consumed rows (latest-wins semantics) and orders by `createdAt`, so it cannot use that index and degrades linearly with the identifier's consumed history — which grows on every re-issued token and is never swept (see ESR-006). This is the repository's hottest lookup outside session verification, per the persona's index-design concern.

## Evidence

Source: `packages/sql/src/Repositories.ts:535`

```
sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`
```

## Recommended fix

Add a non-partial index on `(identifier, "createdAt" DESC)` in the next migration, or scope the query to `consumedAt IS NULL` (the live row the caller actually needs) so the existing partial index serves it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `verification-store-hygiene`. Duplicate of `PPS-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:644`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `PPS-003-postgres-performance-specialist` — closed by its fix (see that issue's Resolved comment).
