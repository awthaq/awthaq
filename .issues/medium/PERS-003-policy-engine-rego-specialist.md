---
ID: "PERS-003"
Title: "Hook tap ordering implements 2 of the 3 spec'd ordering keys and has no introspection"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/HookPoint.ts:157"
Auditor: "policy-engine-rego-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PERS-003 — Hook tap ordering implements 2 of the 3 spec'd ordering keys and has no introspection

`MEDIUM` · `correctness` · `core` · reported by **Policy Engine / Rego Specialist** (`policy-engine-rego-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-091 and REQ-EA-248 require tap order to resolve as dependency order, then declared order, then plugin id; the implementation sorts by declared order then a global registration sequence, and the module header (lines 36-48) documents dependency order as a follow-up. For policy chaining this is load-bearing: the canonical 'normalize before domain allow-list' veto chain is only correct if the amendment tap runs first, and today that guarantee rests on Layer construction order rather than a declared, verifiable rule. BEH-EA-096's resolved-order introspection (plugin list --hooks) is also absent — the point classes expose only kind/tap/layer/run — so an operator cannot audit which policy taps are installed or in what order without running the chain.

## Evidence

Source: `packages/core/src/HookPoint.ts:157`

```
.toSorted((a, b) => a.order - b.order || a.sequence - b.sequence)
```

## Recommended fix

Thread plugin identity into tap registration (the header already sketches this) to finish the three-key sort, and expose the resolved (frozen) entry list on the point service so ordering is introspectable without executing taps.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hook-registry-per-composition`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:180`. Fix: Make taps statically declarable on a plugin (the BEH-EA-024 illustration's `AuthPlugin.layer(Self, { make, taps: [...] })` shape) so Auth.make can print the resolved per-point order into its manifest without running anything; also expose the frozen order at runtime. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.
