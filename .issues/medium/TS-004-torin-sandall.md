---
ID: "TS-004"
Title: "SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in"
Level: medium
Category: "architecture"
Status: resolved
Package: "core"
Source: "packages/core/src/Slots.ts:39"
Auditor: "torin-sandall"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-004 — SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in

`MEDIUM` · `architecture` · `core` · reported by **Torin Sandall — Co-creator of Open Policy Agent (OPA)** (`torin-sandall`)

Status: **resolved**

## Summary

SubjectResolver exclusivity is the composition-level fail-closed guarantee: exactly one plugin may own subject resolution, or authorization inputs silently depend on Layer ordering. The compile-time SlotConflict check is structurally impossible in this Effect version (Context.Reference's Identifier is never, so overrides vanish from ROut unions), and the runtime replacement — SlotsRegistry — is opt-in. A repo-wide search shows only packages/core's own Slots.ts and its test reference Slots.layer: no plugin, example, or application provides it, so the default posture composes two overriding plugins without any error. The authoritative authorization input has weaker conflict protection than rate-limit rules.

## Evidence

Source: `packages/core/src/Slots.ts:39`

```
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R`
```

## Recommended fix

Make Auth.make provide Slots.layer (or fail composition when a plugin used Slots.override and no registry is present) so the conflict check is on by default rather than documented.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Authorization architecture
- Full dossier: [`torin-sandall`](../../.reports/torin-sandall/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ELC-002` — Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer](medium/ELC-002-effect-layer-context-architect.md) `_(effect-layer-context-architect, medium)_`
- [`JH-005` — Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default](medium/JH-005-jared-hanson.md) `_(jared-hanson, medium)_`
- [`MA-005` — Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer](medium/MA-005-michael-arnaldi.md) `_(michael-arnaldi, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `plugin-composition-soundness`. Duplicate of `MA-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/core/src/Slots.ts:39`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MA-005-michael-arnaldi` — closed by its fix (see that issue's Resolved comment).
