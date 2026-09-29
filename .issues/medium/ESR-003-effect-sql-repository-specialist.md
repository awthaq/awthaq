---
ID: "ESR-003"
Title: "Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Repositories.ts:90"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-003 — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization

`MEDIUM` · `correctness` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **ready-for-agent**

## Summary

The repository and the unique index (`CoreMigrations.ts:215-216`, `users_email_unique ON users (lower(email))`) fold with SQL `lower()`, while the app normalizes with JS `toLowerCase()` (`Users.ts:221`) and the sign-in handler passes the raw input email through (`Password.ts:518`). SQLite's `lower()` folds ASCII only; Postgres folds per collation; JS folds per Unicode. For a non-ASCII local part (e.g. `MÜLLER@…` stored as JS-lowercased `müller@…`), a mixed-case sign-in misses on SQLite — the dialect every test in this repo actually runs — while succeeding on Postgres: precisely the 'correct on one dialect, silently broken on the other' class this codebase's own quoted-column comments work to prevent.

## Evidence

Source: `packages/sql/src/Repositories.ts:90`

```
execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`
```

## Recommended fix

Pick one fold and make it the only fold: normalize the bound parameter with `String.prototype.toLowerCase()` in the repository before binding and compare against the stored (already JS-normalized) column directly — `WHERE email = ${email.toLowerCase()}` — keeping the index on the raw column, so behavior is dialect-independent by construction.

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
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-repository-hygiene`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:90`. Fix: Make JS `toLowerCase()` the only fold. Normalize the bound parameter in the repository and keep `lower(email)` on the column side so the existing `users_email_unique` expression index still serves the lookup. Stored values are already JS-lowercased, so column-side `lower()` is a no-op for them on every dialect. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
