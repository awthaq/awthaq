---
ID: "JH-002"
Title: "observe taps are sorted by declared order then run unbounded-concurrent"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/HookPoint.ts:261"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-002 — observe taps are sorted by declared order then run unbounded-concurrent

`MEDIUM` · `correctness` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **ready-for-agent**

## Summary

sortEntries (HookPoint.ts:155-158) orders registrations by `order` then sequence, and observe's run feeds that sorted array into Effect.forEach with concurrency "unbounded" — the computed order is discarded and taps race. sortEntries exists precisely so an author can rely on ordering (BEH-EA-091's normalization-before-allow-list pattern), and observe taps have real relative-order semantics (audit-log entry before welcome email; metric before notification). A tap author who declares { order: 0 } gets no ordering guarantee at all, silently.

## Evidence

Source: `packages/core/src/HookPoint.ts:261`

```
{ concurrency: "unbounded", discard: true },
```

## Recommended fix

Run observe taps sequentially ({ concurrency: 1 }) like veto/divert — observer side effects are typically cheap relative to correctness of order — or, if concurrency is intentional for latency, remove the sort and document observe points as unordered so authors stop declaring meaningless order values.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hook-run-semantics`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:278`. Fix: Run observe taps sequentially in resolved order (like veto/divert), and add an observer-failure metric next to the existing log line. (effort S). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
