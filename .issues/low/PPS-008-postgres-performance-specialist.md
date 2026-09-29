---
ID: "PPS-008"
Title: "SELECT * on every hand-written lookup pulls full wide rows including ciphertext and audit columns"
Level: low
Category: "performance"
Status: wontfix
Package: "sql"
Source: "packages/sql/src/Repositories.ts:280"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-008 — SELECT * on every hand-written lookup pulls full wide rows including ciphertext and audit columns

`LOW` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **wontfix**

## Summary

All 6 hand-written queries in packages/sql select *, and the SqlModel-derived repository queries do the same. Today the damage is bounded because callers do consume most columns (decryptRow needs both token columns), but the pattern blocks covering-index plans, drags ipAddress/userAgent and TEXT payload bytes through the pool on every verify/list, and silently widens whenever a column is added — the classic hot-path regression vector on an auth table that gets one new TEXT column per feature. This compounds PPS-001's redundant reads.

## Evidence

Source: `packages/sql/src/Repositories.ts:280`

```
execute: (userId) => sql`SELECT * FROM accounts WHERE "userId" = ${userId}`,
```

## Recommended fix

Keep SELECT * only where the full row is genuinely consumed (insert/update RETURNING); project explicit column lists on find/list queries — especially accounts listByUser (drop columns when callers only need hashes) and sessions listByUser — so future wide columns cannot silently inflate hot-path row width.

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

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `sql-repository-hygiene`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:296`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/05-sql.md`.

**Wontfix (2026-09-29):** Measured against the code, not speculated: every hand-written lookup decodes into a full `Model.Class` select variant that requires all columns, so projecting means a parallel partial schema per query (doubling the drift surface the dialect-neutral `makeModels` factory exists to remove). The rows are narrow (at most 17 scalar columns, no blobs), callers consume nearly all of them (`decryptRow` needs both token columns), and the hot session-verify path is the model layer's own `findById`, so a contained projection is not available there. The model layer makes it invasive; not done. A deployment that measures egress on a specific list endpoint (audit log, sessions-by-user) adds a purpose-built repository method with its own narrow Result schema next to it.
