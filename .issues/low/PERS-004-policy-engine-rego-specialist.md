---
ID: "PERS-004"
Title: "Observe taps run unbounded-concurrency with swallowed failures — observer side effects are unordered and silent"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:261"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-004 — Observe taps run unbounded-concurrency with swallowed failures — observer side effects are unordered and silent

`LOW` · `correctness` · `core` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **resolved**

## Summary

Observe points are where decision-log forwarding, audit writes, and webhook fan-out to an external policy engine's collectors would live. Fail isolation (BEH-EA-092) is correct, but running all observers concurrently with unbounded concurrency gives their side effects no ordering guarantee — two audit sinks can interleave arbitrarily — and a persistently failing observer is reduced to one Effect.logError line with no counter or metric, so a broken decision-log pipeline is invisible until someone looks. For an auditability-first extension point, silent and unordered is the wrong default.

## Evidence

Source: `packages/core/src/HookPoint.ts:261`

```
{ concurrency: "unbounded", discard: true },
```

## Recommended fix

Default observe runs to sequential (matching the documented declared-order semantics) with concurrency as an explicit opt-in, and attach a metric (e.g. auth.hook.observer.error counter) next to the log line so observer health is monitorable.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: Policy Extension Points
- Full dossier: [`policy-engine-rego-specialist`](../../.reports/policy-engine-rego-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 28 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-run-semantics`. Duplicate of `JH-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:278`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JH-002-jared-hanson` — closed by its fix (see that issue's Resolved comment).
