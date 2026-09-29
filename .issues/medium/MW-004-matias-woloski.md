---
ID: "MW-004"
Title: "Cross-plugin tap ordering is registration-sequence dependent; spec's dependency-order rule unimplemented"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:45"
Auditor: "matias-woloski"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MW-004 — Cross-plugin tap ordering is registration-sequence dependent; spec's dependency-order rule unimplemented

`MEDIUM` · `architecture` · `core` · reported by **Matias Woloski — Co-founder/former CTO of Auth0** (`matias-woloski`)

Status: **resolved**

## Summary

BEH-EA-111 specifies 'dependency order, then declared order, then plugin id' for tap ordering, but only declared order + registration sequence exist; the header itself calls dependency order 'a follow-up'. When two unrelated plugins tap the same point with equal declared order, the winner is decided by module import/init order — an environment-dependent outcome for security-relevant veto chains (e.g. a ban-list tap racing an allow-list tap). Observe taps additionally run under concurrency: "unbounded" (HookPoint.ts:261), so cross-plugin observation order is nondeterministic even for equal orders.

## Evidence

Source: `packages/core/src/HookPoint.ts:45`

```
This module implements the piece that doesn't depend on it: declared
// `order` (a plain number, default 0), then registration sequence, frozen
// the first time a point runs (BEH-EA-024's "must freeze at first read").
```

## Recommended fix

Thread plugin identity into .tap() (Auth.make already computes topological position) so the full three-key ordering can be applied at freeze time, and document that equal-order observe taps have no ordering guarantee until then.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: engineering-scale posture
- Full dossier: [`matias-woloski`](../../.reports/matias-woloski/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `hook-registry-per-composition`. Duplicate of `JH-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:44`. Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → resolved.
