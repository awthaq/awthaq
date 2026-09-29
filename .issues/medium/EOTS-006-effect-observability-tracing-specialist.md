---
ID: "EOTS-006"
Title: "packages/server ships no logging/observability surface; example app uses bare console.log"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "examples/memory-server/index.ts:88"
Auditor: "effect-observability-tracing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EOTS-006 — packages/server ships no logging/observability surface; example app uses bare console.log

`MEDIUM` · `dx` · `—` · reported by **Effect Observability & Tracing Specialist** (`effect-observability-tracing-specialist`)

Status: **ready-for-agent**

## Summary

`packages/server/src` contains six modules and not one reference to `Effect.log*`, `Logger`, `effect/unstable/observability`, or middleware-level request logging — `AuthHttp.ts` is pure re-exports of `HttpApiBuilder.layer`/`HttpApiScalar.layer`. The runnable example (memory-server) relies on Effect's default pretty console logger and logs its own startup with `console.log`. An application adopting awthaq gets no opinionated, production-ready logging default — no structured JSON logger, no request logger, no OTLP export — even though the installed effect@4.0.0-rc ships `effect/unstable/observability` (Otlp, OtlpLogger, OtlpMetrics, PrometheusMetrics) that `archive/design/usage-examples-v4.md:947-948` already sketches wiring for. `.quality-metrics/server.json` still claims `fileCount: 1, totalLoc: 9` for this package, so no metric would even notice observability code landing there.

## Evidence

Source: `examples/memory-server/index.ts:88`

```
console.log("awthaq example (memory-backed, Password + Organization) listening on :3001");
```

## Recommended fix

Add an `AuthObservability` layer to `@awthaq/server` that composes a Logger replacement (structured JSON by default, pretty when NODE_ENV=development) and optionally `effect/unstable/observability`'s Otlp/Prometheus layers; use it in the example app.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: observability & tracing
- Full dossier: [`effect-observability-tracing-specialist`](../../.reports/effect-observability-tracing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ALF-008` — Zero subscribers shipped anywhere — a default install records security events nowhere](medium/ALF-008-audit-logging-forensics-specialist.md) `_(audit-logging-forensics-specialist, medium)_`
- [`CSD-010` — The only runnable example composes a permissive limiter — out-of-the-box showcase has throttling off](low/CSD-010-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`PCS-005` — Zero tests exercise the cached-decision path or any invalidation trigger in this repo](medium/PCS-005-permission-caching-specialist.md) `_(permission-caching-specialist, medium)_`
- [`SEA-007` — The one runnable example deliberately avoids any SQL backend, so no end-to-end SQLite composition is demonstrated](info/SEA-007-sqlite-embedded-auth-specialist.md) `_(sqlite-embedded-auth-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `observability-substrate`. Evidence at HEAD ec065a7: `examples/memory-server/index.ts:106`. Fix: Follow wayfinder ticket 27 (MW-001's decision): re-export HttpMiddleware.tracer/logger from AuthHttp (not a bespoke AuthObservability logger — the decision leaves logging/metrics backends to the host), and make the example demonstrate the recommended composition: structured JSON logging + request logger + Effect.logInfo startup line. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
