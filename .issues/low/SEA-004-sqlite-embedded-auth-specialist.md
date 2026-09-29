---
ID: "SEA-004"
Title: "All SQLite tests run :memory:, so the WAL configuration production gets is never exercised"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/test/Repositories.test.ts:27"
Auditor: "sqlite-embedded-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SEA-004 — All SQLite tests run :memory:, so the WAL configuration production gets is never exercised

`LOW` · `testing` · `sql` · reported by **SQLite Embedded Auth Specialist** (`sqlite-embedded-auth-specialist`)

Status: **ready-for-agent**

## Summary

The driver unconditionally runs PRAGMA journal_mode = WAL unless disableWAL is set (SqliteClient.ts:150-151), but journal_mode=WAL is a no-op on a :memory: database — in-memory DBs cannot use a write-ahead log. Every SQLite contract test in the monorepo (packages/sql, core, organization, passkey, jwt, admin test files all construct SqliteClient.layer({ filename: ":memory:" })) therefore exercises a journal mode no production deployment runs. File-backed behaviors that matter for auth durability — WAL recovery after a crash, busy-timeout contention between two connections on one file, checkpoint timing under write load — have zero coverage, and no test ever opens two connections to one file to prove the touch CAS holds across processes.

## Evidence

Source: `packages/sql/test/Repositories.test.ts:27`

```
const SqlLive = SqliteClient.layer({ filename: ":memory:" });
```

## Recommended fix

Add one contract-suite pass against a temp-dir file database (and a two-client contention test asserting exactly one concurrent touch/claim wins); the same test bodies can run over both SqlLive variants, mirroring how the Postgres suite reuses the SQLite suite's bodies.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 70/100), domain: Embedded SQLite Persistence
- Full dossier: [`sqlite-embedded-auth-specialist`](../../.reports/sqlite-embedded-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`RRC-008` — No staleness or lag-injection coverage: SQL contract suites run single-client semantics only](low/RRC-008-read-replica-consistency-specialist.md) `_(read-replica-consistency-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-contract-test-coverage`. Evidence at HEAD ec065a7: `packages/sql/test/Repositories.test.ts:27`. Fix: Run the SQLite contract cases against a temp-file database as well, and add a two-connection contention test for the CAS primitives. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
