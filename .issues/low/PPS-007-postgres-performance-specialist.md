---
ID: "PPS-007"
Title: "verifyEmail pays an extra round trip: UPDATE followed by a separate findById instead of RETURNING"
Level: low
Category: "performance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:97"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-007 — verifyEmail pays an extra round trip: UPDATE followed by a separate findById instead of RETURNING

`LOW` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

The UPDATE discards its result and a second SELECT re-fetches the row — two round trips and two plan executions for what RETURNING * delivers in one. Same pattern family as PPS-001 but on a colder path (email verification happens once per signup); worth fixing as part of the same sweep since makeRepository-derived findById makes the one-statement form trivial.

## Evidence

Source: `packages/sql/src/Repositories.ts:97`

```
yield* sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`;
        return yield* repo.findById(id);
```

## Recommended fix

Use UPDATE ... WHERE id = $1 RETURNING * and decode the returned row through the same Schema, failing with NoSuchElementError when zero rows come back; delete the follow-up findById.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-dialect-neutral-models`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:103`. Fix: Collapse verifyEmail into one `UPDATE ... RETURNING *` decoded through the dialect model. Bind the boolean through the model's own encoding so the per-dialect literal branch disappears. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** UsersRepository.verifyEmail is one UPDATE ... RETURNING * decoded through the dialect model; the boolean binds via the dialect wire codec so the onDialectOrElse literal branch is gone. Tests (Repositories.test.ts): single sql.execute span, NoSuchElementError on unknown id; pg case green on real Postgres.
