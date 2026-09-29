---
ID: "PPS-006"
Title: "No prepared-statement reuse: every hot statement is an unnamed template executed fresh"
Level: low
Category: "performance"
Status: needs-triage
Package: "sql"
Source: "packages/sql/src/Repositories.ts:424"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-006 — No prepared-statement reuse: every hot statement is an unnamed template executed fresh

`LOW` · `performance` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **needs-triage**

## Summary

A grep for .prepare( across all packages returns zero matches: every statement — including the per-request session verify lookup, the touch CAS, and tryConsume — is built as an anonymous tagged template. Any plan caching therefore depends entirely on driver defaults rather than the codebase's intent, and on Postgres each execution pays parse/plan for statements whose shapes are fully static and whose tables are the highest-QPS in the system. At moderate traffic this is measurable p99 overhead for exactly zero benefit.

## Evidence

Source: `packages/sql/src/Repositories.ts:424`

```
execute: (request) => sql`
          UPDATE sessions
          SET "secretHash" = ${request.secretHash},
```

## Recommended fix

Name and prepare the hot statements once per client (session findById, touch, tryConsume, upsertLive, findByEmail, findByProviderSubject) using the SqlClient's prepared-statement API, and add a lint/test that fails if a repository query string reaches the hot path unnamed.

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

**Plan validation (2026-09-29):** INVALID (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgClient.ts:139`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/05-sql.md`.
