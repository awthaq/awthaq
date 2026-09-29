---
ID: "ETVS-004"
Title: "TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "test"
Source: "packages/test/src/TestAuth.ts:84"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-004 — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites

`MEDIUM` · `dx` · `test` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **ready-for-agent**

## Summary

TestAuth.layer's MemoryPorts provides Users/Accounts/Sessions/Mailer/RateLimiter/RateLimits/SqlTransaction over memory - but omits Verification, AuthEvents, and PasswordHasher, which every credential plugin (Password today, magic-link/two-factor later) requires (Password.ts:370-373). So its 'whole pipeline over memory' claim holds only for plugins with no token/hook needs; the memory-server example and any future consumer must re-solve the same extras through the 'middleware' parameter (which in practice carries plugin support Layers like OrganizationMemory, not middleware). Meanwhile the BDD Worlds (PasswordWorld.ts:36-41, SessionWorld.ts:33-38) and the server/password/oauth/passkey AuthHttp suites hand-roll near-identical CoreLive/TestServices assemblies that have already diverged from MemoryPorts (Worlds add Verification+AuthEvents; TestAuth adds RateLimits+SqlTransaction). Only admin, jwt and organization suites actually consume TestAuth.

## Evidence

Source: `packages/test/src/TestAuth.ts:84`

```
const MemoryPorts = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
```

## Recommended fix

Complete the bundle (add AuthEvents.layer and Verification.layerMemory to MemoryPorts), migrate the remaining AuthHttp suites and the BDD Worlds onto TestAuth.layer, and rename the second parameter (e.g. pluginServices) to stop conflating HTTP middleware with support Layers. This collapses ~5 copies of the assembly into one tested one.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERAS-002` — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships](medium/ERAS-002-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, medium)_`
- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `test-harness-completeness`. Evidence at HEAD ec065a7: `packages/test/src/TestAuth.ts:94`. Fix: Complete the memory bundle, rename the second parameter, and migrate the hand-rolled suites onto TestAuth.layer. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
