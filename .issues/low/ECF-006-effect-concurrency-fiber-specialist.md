---
ID: "ECF-006"
Title: "HookPoint.observe runs taps with concurrency \"unbounded\", making declared tap order advisory only"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:252"
Auditor: "effect-concurrency-fiber-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECF-006 — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only

`LOW` · `correctness` · `core` · reported by **Effect Concurrency & Fiber Specialist** (`effect-concurrency-fiber-specialist`)

Status: **resolved**

## Summary

resolveTaps() sorts taps by declared order then registration sequence (header lines 44-46), but run fans out with { concurrency: "unbounded", discard: true } (line 261) — all tap fibers start together, so completion (i.e. side-effect) ordering is nondeterministic and TapOptions.order cannot actually sequence observations like audit-before-analytics. It is also the exact unbounded-fan-out shape a login-path reviewer flags, though the failure isolation (catchCause + logError per tap) and the fact that no hook point is wired into real signUp/signIn flows yet (header lines 50-56) keep today's impact at zero.

## Evidence

Source: `packages/core/src/HookPoint.ts:252`

```
const run: ObserveShape<Input>["run"] = (value) =>
      Effect.forEach(
        resolveTaps(),
```

## Recommended fix

Run observe taps sequentially (discard: true, no concurrency option) to make order meaningful, or rename/document order as start-priority under concurrent execution; when BEH-EA-090/092 wire points into real flows, decide deliberately. Veto/divert already run sequentially and are correct.

## Context

- Auditor verdict on this domain: **needs-work** (score 68/100), domain: Concurrency & Fibers
- Full dossier: [`effect-concurrency-fiber-specialist`](../../.reports/effect-concurrency-fiber-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ELC-001` — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention](medium/ELC-001-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-run-semantics`. Duplicate of `JH-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:278`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JH-002-jared-hanson` — closed by its fix (see that issue's Resolved comment).
