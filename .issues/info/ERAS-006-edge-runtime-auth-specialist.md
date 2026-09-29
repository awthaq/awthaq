---
ID: "ERAS-006"
Title: "SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented"
Level: info
Category: "architecture"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Repositories.ts:76"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-006 — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented

`INFO` · `architecture` · `sql` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

The boundary is drawn correctly: repositories require the ambient SqlClient (Repositories.ts:6,22), and @effect/sql-pg / @effect/sql-sqlite-node are devDependencies of @awthaq/sql, not runtime deps — so no raw-TCP driver enters a consumer bundle by default. The consequence stands unspoken: the raw-TCP Postgres client cannot run in Workers/Vercel Edge isolates at all, so DB-backed Sessions (and therefore getSession) must stay on origin; only an HTTP-endpoint driver (e.g. libsql-over-http style, not shipped here) could ever move them. This is the single most important boundary for an edge split and the repo never states it.

## Evidence

Source: `packages/sql/src/Repositories.ts:76`

```
export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
```

## Recommended fix

State the boundary in the persistence spec or a deployment ADR: edge runtime = stateless verification + presence checks; origin (Node) = SqlClient-backed sessions, users, credentials, migrations.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- [`ESR-007` — verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding](low/ESR-007-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `packages/sql/package.json:31`. Fix: Document the edge/origin split and the driver matrix, and prove one HTTP-capable sqlite-dialect driver against the contract suite so the documentation isn't aspirational. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** README 'Runtimes & drivers' driver matrix and the edge/origin split (also in spec/overview.md). @effect/sql-libsql added as a dev dependency (catalog + minimumReleaseAgeExclude in pnpm-workspace.yaml) and packages/sql/test/Repositories.libsql.test.ts runs the shared contract cases and coreMigrations over a libSQL file: database (20/20 green), which also proves Migrator's withTransaction works on libSQL. D1/sqlite-do/pglite are documented as untested with the D1 no-interactive-transactions caveat (run migrations from Node). No ADR added; the overview note carries it.
