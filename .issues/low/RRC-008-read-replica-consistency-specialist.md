---
ID: "RRC-008"
Title: "No staleness or lag-injection coverage: SQL contract suites run single-client semantics only"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/test/Repositories.test.ts:3"
Auditor: "read-replica-consistency-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRC-008 — No staleness or lag-injection coverage: SQL contract suites run single-client semantics only

`LOW` · `testing` · `sql` · reported by **Read Replica Consistency Specialist** (`read-replica-consistency-specialist`)

Status: **ready-for-agent**

## Summary

Both repository suites (in-memory SQLite here and the Postgres variant) run one SqlClient against one database, so every test passes by construction in the only topology where read-your-writes holds unconditionally. Nothing exercises a stale read (a replayed pre-rotation secretHash, a resurrected revoked session, a membership decision served from a lagging snapshot), nothing asserts ordering between a membership write and a qadi decision read, and no lag metric exists that could detect this failure class in production before users report mysterious 401s or over-broad access. The domain's characteristic failure mode is currently invisible to the entire test suite.

## Evidence

Source: `packages/sql/test/Repositories.test.ts:3`

```
// Exercises `Models.ts`/`Repositories.ts` against a real, in-memory SQLite
// database (`node:sqlite` via `@effect/sql-sqlite-node`) — the same
```

## Recommended fix

Add a lag-injecting SqlClient wrapper to the testkit and contract tests for the four critical handoffs — issue->verify, rotation->next verify, revoke->verify, membership write->qadi read — each asserting the outcome under an injected stale read, so a future routing layer cannot land without exposing these windows.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: replica consistency
- Full dossier: [`read-replica-consistency-specialist`](../../.reports/read-replica-consistency-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`SEA-004` — All SQLite tests run :memory:, so the WAL configuration production gets is never exercised](low/SEA-004-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `read-replica-routing`. Evidence at HEAD ec065a7: `packages/sql/test/Repositories.test.ts:27`. Fix: Land a lag-injecting replica test double together with ReadRouting, and cover the four causal handoffs. (effort M). Full dossier: `.plan/slices/05-sql.md`. Status → ready-for-agent.
