---
ID: "RBS-007"
Title: "Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense"
Level: medium
Category: "dx"
Status: resolved
Package: "test"
Source: "packages/test/src/TestAuth.ts:89"
Auditor: "rate-limiting-brute-force-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RBS-007 — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense

`MEDIUM` · `dx` · `test` · reported by **Rate Limiting & Brute-Force Defense Specialist** (`rate-limiting-brute-force-specialist`)

Status: **resolved**

## Summary

BEH-EA-110 requires official plugins to ship default rules so 'an application MUST NOT have to add rate limiting itself to get a sane default' — and the rules are shipped and registered, but the README quickstart explicitly composes RateLimiter.layerPermissive (README.md:139, and the configuration table at README.md:216 documents the default as 'no real limiting'), TestAuth.layer wires layerPermissive for all test-kit compositions, and the runnable examples/memory-server/index.ts inherits it through TestAuth. A developer who copies either canonical starting point deploys with all six password limits and the OAuth callback cap registered-but-inert, which is worse than absent: the registry makes it look protected.

## Evidence

Source: `packages/test/src/TestAuth.ts:89`

```
RateLimiter.layerPermissive,
```

## Recommended fix

Ship a RateLimiter.layerMemory convenience composite (layer + layerStoreMemory, two lines today) as the documented production default, keep layerPermissive for tests only, and have the example server use it; consider a boot-time warning when a composition registers rules while a permissive limiter is provided.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: brute-force defense
- Full dossier: [`rate-limiting-brute-force-specialist`](../../.reports/rate-limiting-brute-force-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `canonical-starter-defaults`. Evidence at HEAD ec065a7: `README.md:216`. Fix: Ship a real in-memory limiter composite as the documented default, reserve permissive for tests, and warn when rules are registered under a permissive limiter. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** RateLimiter.layerMemory (layer over layerStoreMemory, inferred type) added and made the documented single-process default in the README table and ports README; layerPermissive now logs one warning at the first consume (the moment a rule actually runs against it) instead of the dossier's registered()-read hook, because registered() is only read by introspection and would never fire in a normal composition; per-layer Ref, no key logged. memory-server example passes RateLimiter.layerMemory through TestAuth's middleware param so it serves a real limiter. Tests (red first): ports RateLimiter.test.ts layerMemory enforces the limit, layerPermissive warns once. The README quickstart already used the real SQL-store limiter (fixed earlier). Spec BEH-EA-112 note.
**Resolved (2026-09-29):** RateLimiter.layerMemory (layer over the bounded in-memory store) is the documented one-line real limiter; RateLimiterShape gains an optional permissive marker set by layerPermissive; RateLimits' registry warns 'auth.ratelimit.permissive' once per registry when a rule is registered under a permissive limiter, from inside the registering plugin's build, and stays quiet under NODE_ENV=test (Config.String, where the permissive limiter is the intended default). README ports table updated (the quickstart already used the SQL limiter). Tests: ports RateLimiter.test.ts (layerMemory enforces; permissive marker) and core RateLimits.test.ts (warns once; quiet under a real limiter; quiet under NODE_ENV=test). Deviation: examples/memory-server still composes through TestAuth (permissive bundle default); a host wanting real limiting there passes RateLimiter.layerMemory in TestAuth.layer's services.
