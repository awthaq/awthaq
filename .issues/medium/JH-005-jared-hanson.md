---
ID: "JH-005"
Title: "Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Slots.ts:44"
Auditor: "jared-hanson"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# JH-005 — Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default

`MEDIUM` · `architecture` · `core` · reported by **Jared Hanson — Creator of Passport.js** (`jared-hanson`)

Status: **resolved**

## Summary

Slots.override registers its claim only when a SlotsRegistry happens to be in context; without Slots.layer, two plugins claiming the same slot compose silently and the later-built layer wins (Slots.ts:39-48, 191-198). RateLimits.rule has the same shape: "the composition must also provide `RateLimits.layer` itself ... for these contributions to land anywhere" (RateLimits.ts:144-150). This is exactly the "last one wins merge-order accident" ADR-EA-010 rejected for ports, reintroduced one layer down. In an ecosystem of independently developed plugins — Passport's history is instructive here — the conflict case is the common case, and it will surface as two plugins that both work alone, break together, with zero signal.

## Evidence

Source: `packages/core/src/Slots.ts:44`

```
// provides `Slots.layer` once, application-wide, the same way it opts into
// `RateLimits.layer` or `AuthEvents.layer` today; one that doesn't still
// gets the correct default/override *value* semantics (BEH-EA-021's actual
```

## Recommended fix

Have Auth.make install SlotsRegistry/RateLimitsRegistry per composition by default (they are per-composition Refs already, so this cannot cross-contaminate tests), reducing override's Effect.serviceOption lookup to a plain requirement. Fail composition (typed SlotConflict) instead of ignoring unregistered claims; keep an explicit escape hatch for genuinely optional registries.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 68/100), domain: plugin strategy architecture
- Full dossier: [`jared-hanson`](../../.reports/jared-hanson/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-002` — Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer](medium/ELC-002-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`MA-005` — Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer](medium/MA-005-michael-arnaldi.md) `_(michael-arnaldi, medium)_`
- [`TS-004` — SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in](medium/TS-004-torin-sandall.md) `_(torin-sandall, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `plugin-composition-soundness`. Duplicate of `MA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Slots.ts:39`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.
