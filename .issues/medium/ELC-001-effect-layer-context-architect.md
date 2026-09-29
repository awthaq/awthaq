---
ID: "ELC-001"
Title: "HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:174"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-001 — HookPoint tap registry is module-scoped mutable state, contradicting the codebase's own per-composition service convention

`MEDIUM` · `architecture` · `core` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

Each hook point closes over a module-level `entries` array and a `frozen` flag, and OrganizationHooks.ts:268 confirms taps share 'the same shared, module-scoped registry'. Slots.ts:36-37 states the project's own rule for registries: 'never module-level state, so unrelated compositions/tests never share one registry and one test's read never freezes another's writes'. Two Layer builds in one process (two ManagedRuntimes, or a second Layer.launch in a test file) share taps and freeze state: a tap installed for composition A is visible to composition B, the first `run` anywhere freezes the tap list process-wide, and any later `tap` build dies with HookPointFrozen — the exact cross-composition interference the Slots/RateLimits registries were redesigned to prevent.

## Evidence

Source: `packages/core/src/HookPoint.ts:174`

```
const entries: Array<Registration<VetoTap<Input>>> = [];
    let frozen: ReadonlyArray<VetoTap<Input>> | undefined;
    const resolveTaps = (): ReadonlyArray<VetoTap<Input>> => {
```

## Recommended fix

Give each hook point a per-composition registry service (the SlotsRegistry pattern): taps register through a Context service with a default no-op registry, so state lives in the layer memo map instead of the module, and `Effect.serviceOption` keeps taps optional exactly as Slots.override does.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AOMS-006` — Zero hook points wired into real auth flows: no Auth0 Action/Rule insertion point exists](high/AOMS-006-auth0-okta-migration-specialist.md) `_(auth0-okta-migration-specialist, high)_`
- [`BCR-004` — Password sign-in declares no divert hook point — the exact enabler the challenge flow needs](high/BCR-004-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`BE-005` — Core lifecycle hook points are declared but never fired by signUp/signIn](medium/BE-005-bereket-engida.md) `_(bereket-engida, medium)_`
- [`CSG-002` — BeforeUserDelete hook point relied on by spec and BDD does not exist in code](high/CSG-002-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, high)_`
- [`ECF-006` — HookPoint.observe runs taps with concurrency "unbounded", making declared tap order advisory only](low/ECF-006-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`ERS-005` — Hook-point taps run with unbounded concurrency, making tap order cosmetic](low/ERS-005-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`GC-006` — Module-level mutable tap-sequence counter contradicts the scoped-registry convention](low/GC-006-giulio-canti.md) `_(giulio-canti, low)_`
- [`GC-009` — Hook point input schemas are phantom witnesses, never decoded](info/GC-009-giulio-canti.md) `_(giulio-canti, info)_`
- … 14 more findings touch `packages/core/src/HookPoint.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hook-registry-per-composition`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:200`. Fix: Move each point's tap registry out of the module closure into the point's own per-composition service: the point's `.layer` owns a `Ref` of registrations; `tap()` returns a Layer that *requires* the point (RIn = Self) and registers through it. Freezing becomes per-built-layer. (effort L). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Per-composition hook registries: HookPoint.ts no longer has module-level state (the registry is allocated by each point's own .layer via makeRegistry<F>); tap() returns Layer<never, never, Self> so tapping an unprovided point is a compile error (packages/core/test/HookPoint.types.test.ts, @ts-expect-error). Freezing is per built layer (test 'two independently built compositions do not share taps or freeze state'). nextSequence counter deleted. Comments describing the singleton updated (Hooks.ts, RateLimits.ts, Organization.ts, Passkey.ts, docs/plugin-authoring.md, test headers); spec/traceability.md INV-EA-005 row now names the type test. Erasure taps in Organization/Passkey stay separate exports for now: CSG-001 (P11) replaces them with the ErasureRegistry. Gates: typecheck, full vitest, test:bdd, spec:verify:strict, oxlint.
