---
ID: "ESR-007"
Title: "verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding"
Level: low
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:97"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-007 — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding

`LOW` · `correctness` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

`Models.ts:43-49` goes out of its way to build a `0 | 1` database encoding for `emailVerified` specifically because SQLite has no boolean bind type — then the one custom statement that writes the column bypasses that encoding with a raw literal `1`. It works today (SQLite INTEGER assignment; Postgres accepts the integer-to-boolean assignment cast), but it is a second convention beside the model's deliberate encoding and will silently break if the column encoding or dialect set changes — the exact class of cross-dialect assumption the hiring rubric flags.

## Evidence

Source: `packages/sql/src/Repositories.ts:97`

```
yield* sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`
```

## Recommended fix

Bind a `Schema.BooleanFromBit`-encoded value (or encode `true` through the model's insert schema) instead of inlining the literal, so the statement inherits whatever database encoding the model declares.

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

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `sql-dialect-neutral-models`. Already fixed by commit b8d6177. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:103`. Full dossier: `.plan/slices/05-sql.md`. Status → resolved.
