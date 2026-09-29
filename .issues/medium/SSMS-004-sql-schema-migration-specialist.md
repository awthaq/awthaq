---
ID: "SSMS-004"
Title: "REQ-EA-563's 'migrations apply deterministically' check never applies a migration"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "test"
Source: "packages/test/src/TestAuth.ts:285"
Auditor: "sql-schema-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SSMS-004 — REQ-EA-563's 'migrations apply deterministically' check never applies a migration

`MEDIUM` · `testing` · `test` · reported by **SQL Schema Migration Specialist** (`sql-schema-migration-specialist`)

Status: **ready-for-agent**

## Summary

The BDD scenario REQ-EA-563 (features/features/08-tooling/25-testing-harness.feature:158-162) requires applying a plugin's migrations twice, independently, and asserting both runs apply identically. The executable check instead builds Auth.make twice and JSON-compares the migration arrays: JSON.stringify drops the up Effect functions entirely, so two builds whose migrations differ only in behavior compare equal, and no migration ever touches a store. Real determinism properties - id monotonicity, whole-batch atomicity, the effect_sql_migrations tracking table - are provided by the framework Migrator and proven only inside packages/sql's own suites, not by the contract suite every plugin author is told to trust.

## Evidence

Source: `packages/test/src/TestAuth.ts:285`

```
if (JSON.stringify(builtA.migrations) !== JSON.stringify(builtB.migrations)) {
```

## Recommended fix

Add an effectful contract variant that runs the built migrations twice against in-memory SQLite (the exact pattern packages/sql/test/Repositories.test.ts:33-35 already uses) and compares resulting schema; until then, rename the check to 'migration declarations are deterministic' so traceability stops overclaiming.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: SQL schema & migrations
- Full dossier: [`sql-schema-migration-specialist`](../../.reports/sql-schema-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `test-harness-completeness`. Evidence at HEAD ec065a7: `packages/test/src/TestAuth.ts:310`. Fix: Run the built migrations twice against two fresh in-memory SQLite databases and compare resulting schemas; keep the cheap declaration check under an honest name. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
