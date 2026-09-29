---
ID: "SEA-005"
Title: "TEXT timestamp ordering correctness rests on an implicit fixed-width ISO encoding invariant"
Level: low
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:386"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-005 — TEXT timestamp ordering correctness rests on an implicit fixed-width ISO encoding invariant

`LOW` · `correctness` · `sql` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **resolved**

## Summary

The SQLite DDL stores every timestamp as TEXT (CoreMigrations.ts:128-141) and pagination/expiry logic compares those strings directly with > and =. This is chronologically correct only because the whole encode path funnels through DateTime.formatIso, i.e. Date.prototype.toISOString (effect Schema.ts:10778-10779) — fixed-width YYYY-MM-DDTHH:mm:ss.sssZ in UTC, whose lexicographic order matches time order. Nothing enforces that invariant: the columns are not STRICT, any writer binding a differently-formatted string (offset form, missing fractional digits, where Z sorts after .) would silently corrupt cursor pagination and the expiresAt > now checks in tryConsume/claim. The chain is sound today (Model.DateTimeInsert and DateTimeUtcFromString both encode via formatIso; the model comments in Models.ts show the team reasoning about affinity carefully), but it is one dependency behavior-change away from a silent ordering bug.

## Evidence

Source: `packages/sql/src/Repositories.ts:386`

```
                  AND ("createdAt" > ${request.cursorCreatedAt}
                       OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId}))
```

## Recommended fix

Declare STRICT tables in the SQLite DDL (SQLite >= 3.37) to pin column types, and add one contract test asserting 'createdAt DESC query order equals epoch order' so any encoding drift fails loudly.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-contract-test-coverage`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:440`. Fix: Pin the encoding invariant with contract tests. STRICT tables are rejected: they enforce only the TEXT type, not the format, and need table rebuilds. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Repositories.test.ts pins the encoding invariant: every persisted SQLite timestamp column (18 columns across every write path) matches /^\d{4}-\d{2}-\d{2}T..:..:..\.\d{3}Z$/, and keyset listByUser order equals epoch order across ms/second/minute rollovers. markReused now goes through a Request schema (one encoder) instead of a hand-encoded parameter.
