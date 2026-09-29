---
ID: "MAPS-007"
Title: "No tracing correlation of auth context anywhere in the pipeline"
Level: medium
Category: "dx"
Status: resolved
Package: "test"
Source: "packages/test/src/TestAuth.ts:31"
Auditor: "microservices-auth-propagation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MAPS-007 — No tracing correlation of auth context anywhere in the pipeline

`MEDIUM` · `dx` · `test` · reported by **Microservices Auth Propagation Specialist** (`microservices-auth-propagation-specialist`)

Status: **resolved**

## Summary

In a multi-service deployment the first question after an auth failure is 'which principal, which session, which hop' - and nothing in this codebase answers it. The only spans are repository-level (packages/sql/src/Repositories.ts spanPrefix 'Users'/'Sessions'/...); no middleware attaches principal ref, sessionId, or principal tag to any span; there is no traceparent/tracestate handling, and no logger. The testkit's own header concedes that even BEH-EA-199's 'no Redacted reaches a span' rule is unverifiable because no tracer interceptor exists. Auth decisions are therefore uncorrelatable across the Authentication middleware, the qadi SubjectExtractor bridge, and any downstream service.

## Evidence

Source: `packages/test/src/TestAuth.ts:31`

```
//   mechanically verifiable today" (no tracer/logger interceptor exists) —
```

## Recommended fix

Add span attributes (principal.type, principal.id, session.id) at the single choke point both bridges already share - resolvePrincipal/resolveSession - and a test-only tracer interceptor that finally makes the Redacted-leak rule mechanically checkable.

## Context

- Auditor verdict on this domain: **needs-work** (score 45/100), domain: Service Boundary Auth Propagation
- Full dossier: [`microservices-auth-propagation-specialist`](../../.reports/microservices-auth-propagation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `observability-substrate`. Evidence at HEAD ec065a7: `packages/server/src/Authentication.ts:205`. Fix: Annotate the principal/session on the current span at the shared resolution choke point, and rely on HttpMiddleware.tracer (MW-001) for W3C traceparent propagation. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Authentication.resolveSession (the shared choke point of Path A's middleware and Path B's SubjectExtractor) runs under awthaq.principal.resolve (auth.scheme attribute); the resolved principal type/ref and session id are annotated on the current span (auth.principal.type/ref, auth.session.id, auth.outcome=success) and on every log the handler writes (annotateLogs), ids only. W3C traceparent propagation is HttpMiddleware.tracer's (the re-export). Test: packages/server/test/Authentication.test.ts (span with principal/session attributes, no credential in any attribute).
