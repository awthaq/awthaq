---
ID: "ELC-002"
Title: "Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Slots.ts:44"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-002 — Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer

`MEDIUM` · `architecture` · `core` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

The compile-time SlotConflict<P> check is structurally impossible for Context.Reference (its ROut is `never`, documented in Slots.ts:11-30), which is honest — but the replacement runtime check fires only if the application remembers to provide Slots.layer. Without it, two plugins claiming the same slot compose silently and last-override-wins, so a composition that violates BEH-EA-021/INV-EA-004 passes Validate<P>, passes madge, and boots correctly with one plugin's policy quietly disabled. TestAuth.layer's MemoryPorts does not include Slots.layer, so the default test pipeline never checks conflicts either.

## Evidence

Source: `packages/core/src/Slots.ts:44`

```
// provide `Slots.layer`. An application that wants the real conflict check
// provides `Slots.layer` once, application-wide, the same way it opts into
// `RateLimits.layer` or `AuthEvents.layer` today; one that doesn't still
```

## Recommended fix

Include Slots.layer (and RateLimits.layer) in TestAuth.layer's MemoryPorts so every test composition checks conflicts, and document in the plugin-contract spec that applications which accept third-party plugins must provide Slots.layer in production to get the INV-EA-004 guarantee.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JH-005` — Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default](medium/JH-005-jared-hanson.md) `_(jared-hanson, medium)_`
- [`MA-005` — Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer](medium/MA-005-michael-arnaldi.md) `_(michael-arnaldi, medium)_`
- [`TS-004` — SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in](medium/TS-004-torin-sandall.md) `_(torin-sandall, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `plugin-composition-soundness`. Duplicate of `MA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Slots.ts:39`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
