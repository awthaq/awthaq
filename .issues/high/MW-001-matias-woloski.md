---
ID: "MW-001"
Title: "No observability substrate: two log statements in the whole library, no tracer/logger interceptor"
Level: high
Category: "architecture"
Status: ready-for-agent
Package: "test"
Source: "packages/test/src/TestAuth.ts:31"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-001 — No observability substrate: two log statements in the whole library, no tracer/logger interceptor

`HIGH` · `architecture` · `test` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **ready-for-agent**

## Summary

An identity runtime at Auth0 scale lives or dies on request-scoped logs, spans, and auth-event metrics. Today the entire packages/ tree contains exactly two Effect.logError call sites (packages/core/src/HookPoint.ts:258 and packages/core/src/AuthEvents.ts:294, both for observer failures); there is no request logging middleware in @awthaq/server, no span around session verify or password verify, and the testkit itself concedes there is no tracer/logger interceptor to assert against. Silent-failure modes (rate-limit consumption, session rotation, migration drift) would be invisible in production.

## Evidence

Source: `packages/test/src/TestAuth.ts:31`

```
already, honestly, documented by that behavior file itself as "not
//   mechanically verifiable today" (no tracer/logger interceptor exists)
```

## Recommended fix

Add an HttpApi middleware in @awthaq/server emitting structured request logs/spans (method, route, principal kind, outcome), wrap Sessions.verify and password verify in Effect.withSpan, and add a tracer-interceptor-based contract test so BEH-EA-199's no-secret-in-spans invariant stops being 'not mechanically verifiable today'.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Observability substrate (logging/tracing)](../../.scratch/resolve-ready-for-human-findings/issues/27-observability-substrate.md) — reuse Effect v4's own `HttpMiddleware.logger`/`tracer` at the HTTP boundary (re-exported from `AuthHttp`), add `Effect.withSpan` around session/password verify and hook/event dispatch, a fixed `auth.*` log/span field convention, a minimal `Metric` taxonomy, and a `@awthaq/test` redaction-asserting `Tracer`/`Logger` interceptor to make BEH-EA-199 mechanically verifiable. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `TestAuth.ts:28-30` matches the evidence verbatim. `grep -rn "Effect.logError" packages/**/src` finds exactly the two cited call sites (`AuthEvents.ts:294`, `HookPoint.ts:258`), and `grep -rl "withSpan" packages/**/src` finds none — no request-logging middleware or span instrumentation exists anywhere in the tree. Designing an observability substrate (what to log, span boundaries, a tracer-interceptor contract test) is a genuine architecture/product decision, not a mechanical patch. Status → ready-for-human.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `observability-substrate`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:284`. Fix: Implement wayfinder ticket 27 in its stated order: HTTP re-exports, business-logic spans, field convention + metrics, then the redaction interceptor (EOTS-002). (effort L). Full dossier: `.plan/slices/02-core-events-hooks.md`.
