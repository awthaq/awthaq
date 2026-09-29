---
ID: "ELC-005"
Title: "Design doc claims AuthPlugin.layer merges taps; shipped implementation does two things, not three"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "archive/design/plugins-as-layers.md:142"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-005 — Design doc claims AuthPlugin.layer merges taps; shipped implementation does two things, not three

`LOW` · `docs` · `—` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

Cross-checking the doc claim against code: AuthPlugin.ts:255-256 implements exactly `Layer.effect(plugin, options.make)` and an optional `Layer.provideMerge(options.handlers, own)` — there is no `Layer.mergeAll` of taps inside AuthPlugin.layer; taps are installed via HookPoint's own `.tap()` layers and merged separately (e.g. OrganizationHooks.ts:270). The doc describes an earlier revision of the same algebra this domain depends on, and the doc is the onboarding path for plugin authors.

## Evidence

Source: `archive/design/plugins-as-layers.md:142`

```
Everything after `Service` is plain `Layer` algebra. `AuthPlugin.layer` only does three things: `Layer.effect(plugin, make)`, `Layer.provideMerge` of the handlers so they see the plugin service, and `Layer.mergeAll` of the taps.
```

## Recommended fix

Update plugins-as-layers.md §142 to the shipped two-step algebra and point to HookPoint.tap + OrganizationHooksLive as the actual tap composition mechanism.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `design-docs-archive`. Evidence at HEAD ec065a7: `archive/design/plugins-as-layers.md:142`. Fix: Fix the governing ADR-EA-008 text to the shipped two-step algebra and point to HookPoint `.tap` layers + per-plugin *HooksLive merges as the tap mechanism; leave archive/ as historical record but add a one-line correction note. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** ADR-EA-008 now describes the shipped AuthPlugin.layer (Layer.effect, provideMerge of handlers, contributes registry layers, and taps declared in the taps option installed as the plugin, ADR-EA-033) instead of the archive's 'three things'. Note: the dossier's 'two steps, no tap merge' was itself out of date at HEAD because ADR-EA-033 added declared taps, so the ADR follows the code, not the dossier. archive/design/plugins-as-layers.md gets a bracketed correction note and stays otherwise unchanged.
