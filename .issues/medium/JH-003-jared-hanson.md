---
ID: "JH-003"
Title: "Tap ordering implements 2 of 3 spec keys via a module-global counter"
Level: medium
Category: "api"
Status: resolved
Package: "core"
Source: "packages/core/src/HookPoint.ts:44"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-003 — Tap ordering implements 2 of 3 spec keys via a module-global counter

`MEDIUM` · `api` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

BEH-EA-091/096 specify tap order as "dependency order, then declared `order`, then plugin id" (spec/behaviors/12-hooks.md:63-64). The implementation applies declared order then registration sequence, where the sequence is `let nextSequence = 0` at module scope (HookPoint.ts:152) shared by every point in the process. Two consequences: (1) a dependency-first guarantee — normalize from a base plugin before a dependent plugin's veto — is unavailable, contradicting the spec authors can rely on; (2) resolved order depends on layer-build order at runtime, so BEH-EA-096's "resolved order ... derivable from the installed plugin tuple alone, printable by tooling" is unimplementable as built. The module-global counter also breaks the codebase's own per-composition-registry convention (Slots.ts:32-37).

## Evidence

Source: `packages/core/src/HookPoint.ts:44`

```
// This module implements the piece that doesn't depend on it: declared
// `order` (a plain number, default 0), then registration sequence, frozen
// the first time a point runs (BEH-EA-024's "must freeze at first read").
```

## Recommended fix

Take an owner (PluginOwner-style `{ id }`) parameter on tap(), the way Slots.override and RateLimits.rule already do, record it per registration, and order by the composition's topological position (available in Auth.make), then declared order, then owner id — replacing the global counter with per-composition registration state. That simultaneously unlocks `plugin list --hooks`.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `hook-registry-per-composition`. Evidence at HEAD ec065a7: `packages/core/src/HookPoint.ts:180`. Fix: Capture tap ownership and sort by the spec'd three keys (dependency order, declared order, plugin id) at freeze time, using the composition's topological order that Auth.make already computes. (effort M). Full dossier: `.plan/slices/02-core-events-hooks.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Tap ordering is the spec's three keys: TapOptions.owner (structural TapOwner {id, dependsOn}), HookPoint.compareTaps (dependency level, declared order, plugin id; app taps last), applied at freeze time; a pure function of owners/orders independent of registration order. Tests in packages/core/test/HookPoint.test.ts (dependency order beats registration order; order then id tie-break; compareTaps). Decision (dependency order key): dependency depth over the owners' dependsOn graph rather than Auth.make's Kahn index, so declared order and plugin id remain meaningful between independent plugins.
