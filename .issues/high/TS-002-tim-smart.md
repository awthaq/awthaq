---
ID: "TS-002"
Title: "verifyEmail writes the SQLite boolean literal `= 1` against Postgres's BOOLEAN column"
Level: high
Category: "correctness"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:97"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-002 — verifyEmail writes the SQLite boolean literal `= 1` against Postgres's BOOLEAN column

`HIGH` · `correctness` · `sql` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **resolved**

## Summary

The `1` is verbatim SQL text (not a bind parameter), and the pg DDL declares `"emailVerified" BOOLEAN NOT NULL` (CoreMigrations.ts:62). Postgres has no assignment cast from integer to boolean, so on PostgreSQL this UPDATE fails with 'column "emailVerified" is of type boolean but expression is of type integer'. The same statement is correct on SQLite, where the column is `emailVerified INTEGER NOT NULL` (CoreMigrations.ts:71) — the query is silently single-dialect in a package whose own comments elsewhere (Repositories.ts:418-446) demonstrate exactly this class of cross-dialect care for identifier quoting.

## Evidence

Source: `packages/sql/src/Repositories.ts:97`

```
yield* sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`;
```

## Recommended fix

Branch the assignment dialect-wise like the migrations do: `sql.onDialectOrElse({ pg: () => sql`... "emailVerified" = TRUE ...`, sqlite: () => sql`... "emailVerified" = 1 ...` })`, or bind a parameter the driver types as boolean.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/Repositories.ts:97` matches the evidence exactly (`UPDATE users SET "emailVerified" = 1, ...`); `CoreMigrations.ts:62` declares `"emailVerified" BOOLEAN NOT NULL` for Postgres (vs. `INTEGER` for SQLite at `:71`), and Postgres has no implicit integer→boolean assignment cast, so this UPDATE fails on PG. `sql.onDialectOrElse` is an established pattern already used identically in `CoreMigrations.ts`. Mechanical, well-scoped fix. Status → ready-for-agent.

**Resolved (2026-09-19):** Took the recommended fix's first option — `verifyEmail` (`packages/sql/src/Repositories.ts`) now branches via `sql.onDialectOrElse`: `"emailVerified" = TRUE` for `pg`, the original `"emailVerified" = 1` preserved for `sqlite`, mirroring `CoreMigrations.ts`'s own DDL-branching idiom applied here to a DML literal.

Verification note: the repo's existing `Repositories.postgres.test.ts` already carries a purpose-built regression test for exactly this ("Users.verifyEmail sets emailVerified/updatedAt via the quoted columns"), skip-gated on `AWTHAQ_POSTGRES_URL`. Ran it against a real, throwaway Postgres 16 container (`docker run postgres:16-alpine`) — it still fails end-to-end, but for the separate, already-tracked, larger `TS-001` bug (`BooleanFromBit` encoding `false` as JS `0`, which the pinned `@effect/sql-pg` binary protocol cannot bind to a `BOOLEAN` column — confirmed independently: a bare `INSERT ... VALUES (${0})` against a boolean column fails the same way, before `verifyEmail`'s own `UPDATE` is ever reached). `TS-001` is explicitly scoped as an architecture decision (dialect-neutral model strategy), out of scope here.

Given that, this specific defect was verified directly, isolating exactly the changed code from `TS-001`'s unrelated encode/decode path: against the same real Postgres container, (1) reproduced the original bug verbatim — a raw `UPDATE ... SET "emailVerified" = 1 ...` against a `BOOLEAN` column throws the exact quoted Postgres error (`42804`, "is of type boolean but expression is of type integer"); (2) ran the new code's exact `sql.onDialectOrElse` block (both branches, via the real `effect`/`@effect/sql-pg` client, not a raw driver call) — the `pg` branch's `= TRUE` succeeds and round-trips correctly (`emailVerified: true`), while re-running the old unconditional `= 1` statement through the same client reproduces the failure. This is a genuine fail/pass cycle against real Postgres for the exact statement this finding is about; the pre-existing `Repositories.postgres.test.ts` test will start passing once `TS-001` is separately resolved, since no further change is needed on `verifyEmail`'s own account. `sqlite` path unaffected: `packages/sql/test/Repositories.test.ts`'s full suite (17 tests) stays green. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (659 passed, 7 skipped — unchanged, since the Postgres suite stays skip-gated locally).
