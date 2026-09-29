---
ID: "MA-005"
Title: "Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Slots.ts:186"
Auditor: "michael-arnaldi"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MA-005 — Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer

`MEDIUM` · `architecture` · `core` · reported by **Michael Arnaldi — Creator of Effect** (`michael-arnaldi`)

Status: **resolved**

## Summary

override registers its claim through Effect.serviceOption(SlotsRegistry) — deliberately optional (Slots.ts header: an application 'that doesn't still gets the correct default/override value semantics... just without the conflict check'). But the failure mode without the registry is not 'no check': because Context.Reference's ROut is never, both layers providing the same slot merge silently and whichever provideMerge runs last wins the composition — a silent behavioral choice between two plugins, exactly the plugin-conflict class the architecture's own principles (spec/overview.md: 'two plugins cannot both provide the hasher... by construction') promise to eliminate. The compile-time SlotConflict<P> is a confirmed structural impossibility on this effect version (Reference Identifier is never, so overrides vanish from any ROut walk) — well documented — but the runtime substitute only protects compositions that remember to provide one more layer, and nothing at Auth.make's type level or its runtime linkPlugins pass verifies that.

## Evidence

Source: `packages/core/src/Slots.ts:186`

```
export const override = <Name extends string, Shape, E, R>(
  owner: PluginOwner,
  slot: Slot<Name, Shape>,
```

## Recommended fix

Have Auth.make itself provide Slots.layer (and RateLimits.layer) into the composed layer by default — one composition, one registry, no opt-in — or at minimum make linkPlugins detect two plugins claiming the same slot key from their manifests (SlotConflict already carries everything needed) so the check cannot be forgotten.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 78/100), domain: Effect v4 architecture
- Full dossier: [`michael-arnaldi`](../../.reports/michael-arnaldi/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-002` — Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer](medium/ELC-002-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`JH-005` — Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default](medium/JH-005-jared-hanson.md) `_(jared-hanson, medium)_`
- [`TS-004` — SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in](medium/TS-004-torin-sandall.md) `_(torin-sandall, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `plugin-composition-soundness`. Evidence at HEAD ec065a7: `packages/core/src/Slots.ts:39`. Fix: Make slot-conflict checking always-on: Auth.make provides one SlotsRegistry per composition, and Slots.override requires the registry instead of looking it up optionally. (effort M). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Slots.override now requires SlotsRegistry (in RIn, no serviceOption); Auth.make's composeLayer provideMerges one Slots.layer per composition and Built<P>['layer'] = ProvideMerged<FoldLayer<P>, typeof Slots.layer>, so two overriders always fail the build with SlotConflict naming both owners with no Slots.layer in application code. TestAuth MemoryPorts also provides Slots.layer for standalone plugin layers (memory-server example RolesLive); roles tests that build Roles.layer standalone provide Slots.layer. Tests: AuthPlugin.test.ts INV-EA-004 two-overrider composition (red first), single overrider resolves, Slots.test override-requires-registry type test. Spec BEH-EA-012 + INV-EA-004 text, REQ-EA-642 scenario, Slots.ts header. RateLimits.layer folding left out (optional per dossier).
