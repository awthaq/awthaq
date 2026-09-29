---
ID: "PPS-004"
Title: "Zero connection-pool configuration for the shared PgClient anywhere in the repo"
Level: medium
Category: "dx"
Status: resolved
Package: "sql"
Source: "packages/sql/test/Repositories.postgres.test.ts:51"
Auditor: "postgres-performance-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PPS-004 — Zero connection-pool configuration for the shared PgClient anywhere in the repo

`MEDIUM` · `dx` · `sql` · reported by **Postgres Performance Specialist** (`postgres-performance-specialist`)

Status: **resolved**

## Summary

The only PgClient instantiation in the entire repo passes just a url, and the documentation's own wiring example (spec/overview.md:132) does the same with layerConfig. This is the client the persona brief describes as shared by every plugin package via Effect DI — pool sizing against the server's max_connections, idle/client lifetime, and a statement_timeout are all left to library defaults with zero guidance. Under pgbouncer transaction-mode pooling (the common production topology), unconfigured per-connection session state and unbounded per-fiber checkout are exactly the failure mode that produces pool-exhaustion latency spikes; nothing in the repo acknowledges this.

## Evidence

Source: `packages/sql/test/Repositories.postgres.test.ts:51`

```
const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });
```

## Recommended fix

Ship an ops-ready Layer (or documented recipe) that exposes explicit pool min/max sized against max_connections minus headroom for other clients, idle timeouts, and a statement_timeout on the shared PgClient, plus a short doc section on pgbouncer transaction-mode implications; surface pool-exhaustion as a distinguishable SqlError so callers can alert on it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Postgres performance
- Full dossier: [`postgres-performance-specialist`](../../.reports/postgres-performance-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ESR-009` — Postgres contract suite omits the touch CAS and encryption round-trip behaviors](low/ESR-009-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-docs-operations`. Evidence at HEAD ec065a7: `packages/sql/test/Repositories.postgres.test.ts:52`. Fix: Ship a documented, ops-ready PgClient recipe and update the spec example. Distinguishable pool-exhaustion errors are an upstream @effect/sql-pg concern and are out of scope. (effort S). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** README 'Postgres client configuration': PgClient.layerConfig with maxConnections/minConnections/idleTimeout/connectionTTL/applicationName, sizing formula, prepare:false behind pgbouncer transaction pooling, role-level statement_timeout, pool exhaustion left to upstream. spec/overview.md example updated. spec:verify:strict passes.
