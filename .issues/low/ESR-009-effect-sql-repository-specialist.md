---
ID: "ESR-009"
Title: "Postgres contract suite omits the touch CAS and encryption round-trip behaviors"
Level: low
Category: "testing"
Status: resolved
Package: "sql"
Source: "packages/sql/test/Repositories.postgres.test.ts:169"
Auditor: "effect-sql-repository-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ESR-009 — Postgres contract suite omits the touch CAS and encryption round-trip behaviors

`LOW` · `testing` · `sql` · reported by **Effect SQL Repository Specialist** (`effect-sql-repository-specialist`)

Status: **resolved**

## Summary

The real-Postgres suite (7 cases, skipped locally without `AWTHAQ_POSTGRES_URL`) deliberately targets quoted-column resolution per repository — good design — but its sessions case covers only list/delete statements. The `touch` compare-and-swap (`UPDATE … WHERE "secretHash" = … RETURNING *`, the security-relevant session-rotation primitive) and the encrypted-token insert/read path are exercised only on SQLite, so a Postgres-specific failure in the CAS's quoted `RETURNING` decode or timestamptz parameter binding would ship untested on the production dialect.

## Evidence

Source: `packages/sql/test/Repositories.postgres.test.ts:169`

```
"Sessions.listByUser/deleteAllForUserExcept/deleteAllByUser all resolve the quoted userId/createdAt columns"
```

## Recommended fix

Add two cases to the Postgres suite mirroring the SQLite suite's touch-race test and encrypted round-trip test; both are direct copies of existing cases against the `PgClient` layer.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 76/100), domain: SQL persistence layer
- Full dossier: [`effect-sql-repository-specialist`](../../.reports/effect-sql-repository-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`PPS-004` — Zero connection-pool configuration for the shared PgClient anywhere in the repo](medium/PPS-004-postgres-performance-specialist.md) `_(postgres-performance-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-dialect-neutral-models`. Evidence at HEAD ec065a7: `packages/sql/test/Repositories.postgres.test.ts:169`. Fix: Mirror the security-relevant SQLite cases into the Postgres suite once TS-001 makes pg row decode possible. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/sql/test/contract.ts now holds the dialect-neutral contract cases as contractCases(label, dialect, layer) run by Repositories.test.ts (:memory:), Repositories.file.test.ts (WAL file) and Repositories.postgres.test.ts (real Postgres, 28/28 green against postgres:16-alpine). New shared cases: touch CAS and encrypted round trip (already shared), tombstone/markReused/reauthenticate/revokeFamily RETURNING decode, AuditLog.list occurredAt range.
