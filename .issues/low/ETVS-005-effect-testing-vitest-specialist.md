---
ID: "ETVS-005"
Title: "Contract suite's 'migrations apply deterministically' never applies a migration"
Level: low
Category: "testing"
Status: resolved
Package: "test"
Source: "packages/test/src/TestAuth.ts:285"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-005 — Contract suite's 'migrations apply deterministically' never applies a migration

`LOW` · `testing` · `test` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **resolved**

## Summary

The check compares JSON.stringify of two Auth.make builds' migration arrays - a purely static comparison. JSON.stringify drops the `up` effect functions entirely, so two migrations differing only in behavior compare equal, and no migration is ever executed against a store. The BDD scenario it implements (REQ-EA-563, 25-testing-harness.feature:159-162) says 'applies "invite"'s migrations twice, independently / asserts both runs apply the migrations identically' - the executable check is weaker than its traced requirement.

## Evidence

Source: `packages/test/src/TestAuth.ts:285`

```
          if (JSON.stringify(builtA.migrations) !== JSON.stringify(builtB.migrations)) {
```

## Recommended fix

Add an effectful variant (it.effect running both builds' migrations against in-memory SQLite via the existing @effect/sql-sqlite-node pattern used in Migrations.test.ts) inside runPluginContractTests when a framework with Effect support is supplied, or rename the check to 'migration declarations are deterministic' so traceability stops overclaiming.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `test-harness-completeness`. Duplicate of `SSMS-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/test/src/TestAuth.ts:310`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
