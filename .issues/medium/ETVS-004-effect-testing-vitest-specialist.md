---
ID: "ETVS-004"
Title: "TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites"
Level: medium
Category: "dx"
Status: resolved
Package: "test"
Source: "packages/test/src/TestAuth.ts:84"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-004 — TestAuth memory bundle incomplete; memory-Layer assembly duplicated and drifting across suites

`MEDIUM` · `dx` · `test` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **resolved**

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

**Plan note (2026-09-29):** Done: TestAuth's memory bundle is complete (Verification.layerMemory, a low-cost argon2id TestHasher, plus AuthEvents/AuditLog/HooksLive/erasure and export services), the second parameter is renamed middleware -> services with the doc comment rewritten, TestAuth.layer now also exposes the composed plugins' own services (so a test can yield* Password.Password), the memory-server example composes through it with no duplicate Verification/hasher (its composition is in examples/memory-server/app.ts), packages/test/test/TestAuth.test.ts has the Password bundle suite ('TestAuth.layer(Auth.make([Password]), ...) serves sign-up/sign-in with no extra layers'). NOT done (left open on purpose): step 3, migrating the hand-rolled wire-level suites onto TestAuth.layer - packages/password/test/AuthHttp.test.ts, packages/server/test/AuthHttp.test.ts (+ Cors.test.ts), packages/oauth/test/AuthHttp.test.ts, packages/passkey/test/AuthHttp.test.ts, packages/jwt/test/AuthHttp.test.ts and features/step-definitions/PasswordWorld.ts / SessionWorld.ts / PasskeyWorld.ts. Each of those swaps a port deliberately (a capturing Mailer, a listless or vanishing Sessions, a real argon2id, a stub HttpClient, a refusing RateLimiter) and several are edited concurrently by other programs (P12/P14/P16), so a bulk rewrite here would conflict for little safety gain; they now each need three more provisions after the P11 work (Erasure.layer, DataExport.layer, RateLimiter) which is exactly the duplication this issue describes, and is the argument for doing the migration as its own follow-up once those programs have landed. Acceptance grep (packages/core/test/AccountErasure.test.ts
packages/oauth/test/AuthHttp.test.ts
packages/password/test/PasswordHooksSignUp.test.ts
packages/password/test/PasswordHooksSignIn.test.ts
packages/core/test/Verification.test.ts
packages/core/test/VerificationLink.test.ts
packages/core/test/Retention.test.ts
packages/core/test/AccountExport.test.ts
packages/oauth/test/OAuthHooksVeto.test.ts
packages/oauth/test/OAuthHooksSignIn.test.ts
packages/password/test/PasswordHooksBeforeSignIn.test.ts
packages/password/test/harness.ts
packages/server/test/AuthHttp.test.ts
packages/oauth/test/OAuth.test.ts
packages/password/test/AuthHttp.test.ts
packages/password/test/Password.test.ts
packages/server/test/Cors.test.ts
packages/jwt/test/AuthHttp.test.ts) is therefore not yet satisfied.

**Plan note (2026-09-29, P20a):** Step 3 (migrating the hand-rolled wire-level suites onto TestAuth.layer) was evaluated and deliberately left open. It is not the mechanical, behavior-preserving move the plan assumed: packages/password, server, oauth, passkey and jwt `AuthHttp.test.ts` each mount only their own plugin API over `AuthHttp.routes` (no core session/account groups, which `TestAuth.layer` always serves), with their own CSRF secret, a capturing Mailer, a stub HttpClient, a specific hasher or a refusing/lagging port. Rewriting them through `Auth.make` + `TestAuth.layer` would change what each suite asserts and would collide with the programs that still edit them. What did land under this issue: the BDD Worlds written in P20a that compose whole applications (CrossCuttingApp, CsrfWorld, HttpErrorWorld, TestingHarnessWorld) are built on `TestAuth.layer`, `TestAuth.layer` gained an optional third argument mounting the OpenAPI document and docs, and every BDD World now shares one cheap-KDF/harness module (`features/step-definitions/shared/Harness.ts`). The remaining migration is best done per suite when its plugin is next reworked.

**Resolved (2026-09-29):** Step 1/2 (bundle completeness, services rename, BDD Worlds composing whole apps on TestAuth.layer) landed earlier (P11/P20a). This pass adds the shared piece the hand-rolled assemblies were duplicating: TestAuth.memoryFoundation (crypto + events + audit + hook defaults) and OrganizationMemory.layer, and moves 45 suites/Worlds onto them (see ELC-004), behavior-preserving (full test + BDD green). What stays on purpose: the wire-level AuthHttp suites of packages/password, server (+Cors), oauth, passkey and jwt still assemble their own memory stack rather than calling TestAuth.layer, because each mounts only its own plugin API over AuthHttp.routes (TestAuth.layer always serves core's session/account groups too) and swaps a port deliberately (capturing Mailer, listless/vanishing Sessions, real argon2id, stub HttpClient, refusing/lagging RateLimiter); rewriting them through Auth.make would change what they assert. They share the foundation line where the package can depend on @awthaq/test (oauth, admin, organization do; password does not, to avoid a password and test dev cycle).
