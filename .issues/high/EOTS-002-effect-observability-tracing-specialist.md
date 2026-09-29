---
ID: "EOTS-002"
Title: "BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half"
Level: high
Category: "compliance"
Status: ready-for-agent
Package: "test"
Source: "packages/test/src/TestAuth.ts:29"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-002 — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half

`HIGH` · `compliance` · `test` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **ready-for-agent**

## Summary

spec/behaviors/25-testing-harness.md:137-140 requires `runPluginContractTests` to fail when a Redacted value reaches a span or event, 'not merely a code review', and features/08-tooling/25-testing-harness.feature:180-185 (REQ-EA-566) restates it. The module header admits only the contract-hash half is implemented. This is the redaction-by-default discipline the hiring rubric demands ('by default, not by review') — currently the guarantee is passive (Redacted's toString) plus review, with whole `Cause` payloads serialized at the only two log sites (EOTS-005) and no interceptor to catch a plugin author who logs or attributes a Redacted value.

## Evidence

Source: `packages/test/src/TestAuth.ts:29`

```
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   already, honestly, documented by that behavior file itself as "not
//   mechanically verifiable today" (no tracer/logger interceptor exists) —
```

## Recommended fix

Build the interceptor in `@awthaq/test`: install a test `Tracer` and `Logger` that walk every span attribute and log payload, deep-inspect for Redacted instances (and fail on their plaintext), and wire it into `runPluginContractTests` so REQ-EA-566 and REQ-EA-089 scenarios become executable.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/test/src/TestAuth.ts:29-31` verbatim, including the module's own admission that the check is "not mechanically verifiable today (no tracer/logger interceptor exists)". `runPluginContractTests` indeed implements only the contract-hash half. Building the described test `Tracer`/`Logger` interceptor is a well-scoped, if substantial, mechanical task. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `observability-substrate`. Evidence at HEAD ec065a7: `packages/test/src/TestAuth.ts:29`. Fix: Build a redaction-asserting Tracer + Logger in @awthaq/test, install it in TestAuth.layer, and run it inside runPluginContractTests (ticket 27 §5). (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`.
