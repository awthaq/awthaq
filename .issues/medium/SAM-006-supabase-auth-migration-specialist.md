---
ID: "SAM-006"
Title: "SQL stratum has no authorization hook: dropping RLS removes the database-level backstop"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Repositories.ts:76"
Auditor: "supabase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SAM-006 — SQL stratum has no authorization hook: dropping RLS removes the database-level backstop

`MEDIUM` · `security` · `sql` · reported by **Supabase Auth Migration Specialist** (`supabase-auth-migration-specialist`)

Status: **ready-for-agent**

## Summary

The repository layers require nothing but SqlClient (and Encryption where secrets are stored) — there is no policy, tenancy, or row-scoping parameter anywhere in the persistence stratum, and the DDL creates no RLS or tenant columns. This is a deliberate architecture (authorization lives exclusively in qadi, in application code), but it means a Supabase app that drops its RLS policies after migrating enforcement to qadi call-sites loses defense-in-depth: any incomplete call-site coverage, future query path, or ad-hoc script with a connection string reads across all tenants silently. The repo nowhere discusses the hybrid window — keeping RLS active while qadi checks roll out — or its exit criteria, which is exactly the double-enforcement/gap risk that makes Supabase migrations fail.

## Evidence

Source: `packages/sql/src/Repositories.ts:76`

```
export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
```

## Recommended fix

Document the cutover protocol: keep RLS active through the qadi rollout, drive both from one policy catalog, then disable RLS only after coverage is verified; optionally add a decision record acknowledging that effect-auth deployments give up DB-enforced isolation and what compensating controls (connection scoping, role-restricted Postgres roles for the app) are recommended.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Supabase migration readiness
- Full dossier: [`supabase-auth-migration-specialist`](../../.reports/supabase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `tenancy-residency`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:76`. Fix: The RLS backstop ships with DRS-001's opt-in RLS migrations. What remains here is documentation of the Supabase hybrid window and the recommended least-privilege database role. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
