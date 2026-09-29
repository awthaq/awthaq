---
ID: "TS-006"
Title: "Hook tap ordering implements 2 of 3 specified keys; veto chains are composition-order sensitive"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:155"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-006 — Hook tap ordering implements 2 of 3 specified keys; veto chains are composition-order sensitive

`LOW` · `correctness` · `core` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

BEH-EA-091/111 specify 'dependency order, then declared order, then plugin id'; the shipped sort uses declared order then a process-global registration sequence (nextSequence, HookPoint.ts:152). For veto points — where taps amend the input for later taps and the operation — two plugins that both default to order 0 execute in Layer-build order, so the amended value a downstream policy sees depends on composition order that no type or runtime check constrains. The header honestly documents this as a follow-up blocked on plugin identity at tap() time, but the result today is that tap ordering on the future external-policy seam is deterministic only per fixed composition, not specified.

## Evidence

Source: `packages/core/src/HookPoint.ts:155`

```
const sortEntries = <F>(entries: ReadonlyArray<Registration<F>>): ReadonlyArray<F> =>
  entries
    .toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
```

## Recommended fix

Thread the plugin id through tap() via the owning AuthPlugin.Service (available once taps are declared inside plugin layer initializers, which is already the intended pattern) and sort by dependency order then order then id before the API freezes.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-registry-per-composition`. Duplicate of `JH-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:180`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JH-003-jared-hanson` — closed by its fix (see that issue's Resolved comment).
