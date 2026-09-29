---
ID: "ERS-005"
Title: "Hook-point taps run with unbounded concurrency, making tap order cosmetic"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:261"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-005 — Hook-point taps run with unbounded concurrency, making tap order cosmetic

`LOW` · `correctness` · `core` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **resolved**

## Summary

observe's run dispatches all resolved taps via Effect.forEach with concurrency: "unbounded". Taps are sorted by order (resolveTaps, line 232-235), but unbounded concurrent execution means order is only a fan-out sequence number, not an execution ordering guarantee — a tap written expecting earlier taps to have completed observes a race. Unbounded concurrency also gives an arbitrary number of slow taps unlimited simultaneous latitude on the request path (these hooks run inside signIn/signUp), with no knob to bound it. The divert-style hook point (BEH-EA-089/093) presumably must run taps sequentially to make 'first tap to divert wins' deterministic; observe's own semantics are weaker than its sorting suggests.

## Evidence

Source: `packages/core/src/HookPoint.ts:261`

```
{ concurrency: "unbounded", discard: true },
```

## Recommended fix

Either execute observe taps sequentially (order becomes real, cost is bounded by tap count) or keep concurrency but document that order is advisory, and expose a bounded-concurrency option (default e.g. 4) so a tap-heavy composition cannot fan out arbitrarily on the auth path.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-run-semantics`. Duplicate of `JH-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:278`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JH-002-jared-hanson` — closed by its fix (see that issue's Resolved comment).
