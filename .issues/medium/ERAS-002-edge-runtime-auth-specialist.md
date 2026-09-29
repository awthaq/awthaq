---
ID: "ERAS-002"
Title: "Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships"
Level: medium
Category: "dx"
Status: resolved
Package: "test"
Source: "packages/test/src/TestAuth.ts:92"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-002 — Only Crypto.Crypto provider in the repo is Node's — no WebCrypto-backed layer ships

`MEDIUM` · `dx` · `test` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

Every core service (Sessions, Verification, Users, Accounts) and server CSRF requires the ambient Crypto.Crypto service, and the effect runtime packages provide concrete Crypto implementations per host platform. But the only provider composed anywhere in this repository is @effect/platform-node/NodeCrypto.layer, inside the testkit (TestAuth.ts:63,92) — which every example (examples/memory-server/index.ts builds on @awthaq/test/TestAuth) copies. An edge deployment must hand-roll Crypto.make({ randomBytes, digest }) over globalThis.crypto.getRandomValues/crypto.subtle.digest; nothing documents that requirement, and the Node provider is the pattern every consumer will inherit.

## Evidence

Source: `packages/test/src/TestAuth.ts:92`

```
  SqlTransaction.layerNoop,
).pipe(Layer.provideMerge(NodeCrypto.layer));
```

## Recommended fix

Ship a platform-neutral Crypto layer (Crypto.make over globalThis.crypto) next to the ports it serves, reference it from the next-package README's globalThis-pinned runtime recipe, and use it in an edge-deployable example so the NodeCrypto testkit dependency stops being the de facto template.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EOTS-002` — BEH-EA-199 'no Redacted reaches span or event' has no mechanical enforcement; contract test implements only half](high/EOTS-002-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, high)_`
- [`ETVS-004` — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites](medium/ETVS-004-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, medium)_`
- [`ETVS-005` — Contract suite's 'migrations apply deterministically' never applies a migration](low/ETVS-005-effect-testing-vitest-specialist.md) `_(effect-testing-vitest-specialist, low)_`
- [`MW-001` — No observability substrate: two log statements in the whole library, no tracer/logger interceptor](high/MW-001-matias-woloski.md) `_(matias-woloski, high)_`
- [`MAPS-007` — No tracing correlation of auth context anywhere in the pipeline](medium/MAPS-007-microservices-auth-propagation-specialist.md) `_(microservices-auth-propagation-specialist, medium)_`
- [`RBS-007` — Every canonical entry point ships the permissive limiter — out of the box there is no brute-force defense](medium/RBS-007-rate-limiting-brute-force-specialist.md) `_(rate-limiting-brute-force-specialist, medium)_`
- [`SSMS-004` — REQ-EA-563's 'migrations apply deterministically' check never applies a migration](medium/SSMS-004-sql-schema-migration-specialist.md) `_(sql-schema-migration-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `canonical-starter-defaults`. Evidence at HEAD ec065a7: `packages/test/src/TestAuth.ts:107`. Fix: Ship a tiny, dependency-free WebCrypto-backed Crypto layer in @awthaq/ports and document it for edge runtimes. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/ports/src/WebCrypto.ts: WebCrypto.layer, a Crypto.Crypto over globalThis.crypto (getRandomValues in 64 KiB chunks, subtle.digest, dies at build with no Web Crypto object; the Web Crypto object is a Context.Reference for tests), exported from @awthaq/ports without a browser-platform dependency. Docs: README ports table (Crypto row) and packages/next/README.md edge section. Tests: packages/ports/test/WebCrypto.test.ts (length/entropy, SHA-256 and HMAC-SHA256 parity with NodeCrypto, uuidv7, no-crypto dies) and packages/core/test/SessionsWebCrypto.test.ts (Sessions issue/verify round-trip under WebCrypto.layer).
