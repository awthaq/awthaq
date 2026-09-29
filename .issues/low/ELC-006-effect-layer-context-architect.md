---
ID: "ELC-006"
Title: "AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class"
Level: low
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/AuthPlugin.ts:254"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-006 — AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class

`LOW` · `correctness` · `core` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **resolved**

## Summary

dependsOn is presented as a static, declarative member of the plugin class (read via the Object.defineProperty getter at line 154), but its backing store is keyed by class identity and written by whatever AuthPlugin.layer call runs last. The API permits constructing a second layer for the same class (roles legitimately builds AuthPlugin.layer(Roles, {make}) as a sub-layer of its static), so two variants with different dependsOn arrays would leave Auth.make ordering migrations by whichever registration landed last rather than by the layer actually composed — a silent divergence between declared and enforced dependency order.

## Evidence

Source: `packages/core/src/AuthPlugin.ts:254`

```
  dependsOnByPlugin.set(plugin, options.dependsOn ?? noDependencies);
```

## Recommended fix

In AuthPlugin.layer, throw (or die with a typed error) when dependsOnByPlugin already holds a different array for the same class, or move dependsOn into the layer options read by Auth.make instead of a class-keyed side table.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MA-003` — 114 import sites of effect/unstable/* embed rc-era module paths into the library's public types](high/MA-003-michael-arnaldi.md) `_(michael-arnaldi, high)_`
- [`SAM-004` — No home for auth.users metadata; plugin-contributed fields are spec-only](medium/SAM-004-supabase-auth-migration-specialist.md) `_(supabase-auth-migration-specialist, medium)_`
- [`TTE-006` — Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary](medium/TTE-006-typescript-type-level-engineer.md) `_(typescript-type-level-engineer, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `plugin-composition-soundness`. Evidence at HEAD ec065a7: `packages/core/src/AuthPlugin.ts:254`. Fix: Refuse a second AuthPlugin.layer registration for the same class whose dependsOn ids differ from the first (a definition-time invariant violation). (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** AuthPlugin.ConflictingDependsOn (TaggedError) thrown by AuthPlugin.layer at definition time when a class is re-registered with a different (sorted-id) dependsOn set; identical re-registration allowed (Roles.layer/layerSql). Tests in AuthPlugin.test.ts (red first: symbol missing). The old cycle test that re-registered Ping with deps was rewritten to use hand-built AuthPlugin.Any values with mutually-referencing dependsOn. Full test suite proves no shipped plugin has divergent registrations.
