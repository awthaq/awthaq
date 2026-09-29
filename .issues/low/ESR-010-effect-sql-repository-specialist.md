---
ID: "ESR-010"
Title: "listByUser limit is unvalidated before being bound into LIMIT"
Level: low
Category: "api"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:313"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-010 — listByUser limit is unvalidated before being bound into LIMIT

`LOW` · `api` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

The cursor request schema accepts any `Schema.Int`, and `listByUser` falls back to `DEFAULT_PAGE_SIZE` only for `undefined`. There is no injection risk (the value is a bound parameter), but `limit: 0` returns an empty page claiming `nextCursor: none`, negative limits produce a driver-level SQL error, and an unbounded positive limit defeats the point of keyset pagination by fetching the table in one page — all observable contract weirdness a caller can trigger through the public shape.

## Evidence

Source: `packages/sql/src/Repositories.ts:313`

```
cursorId: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});
```

## Recommended fix

Constrain the request schema (e.g. `Schema.Int.pipe(Schema.between(1, 200))`) or clamp in `listByUser`, so the public contract bounds page size by construction rather than by caller discipline.

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
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-list-liveness-and-pagination`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:328`. Fix: Bound the page size by construction: clamp in `listByUser` and enforce the bound in the request schema. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/sql Repositories.ts: exported MAX_PAGE_SIZE=200; listByUser computes effectiveLimit = clamp(limit ?? 50, 1, MAX_PAGE_SIZE) once for both query and nextCursor check; SessionCursorRequest.limit is Schema.Int + isBetween(1, MAX_PAGE_SIZE). Tests (Repositories.test.ts): limit 0 clamps to 1 with a nextCursor, negative limit raises no SqlError, huge limit capped at MAX_PAGE_SIZE. core no longer has its own LIST_PAGE_SIZE (uses SqlRepositories.MAX_PAGE_SIZE).
