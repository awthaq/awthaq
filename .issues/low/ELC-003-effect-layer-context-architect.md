---
ID: "ELC-003"
Title: "Madge cycle guard skips type imports, leaving type-level cycles undetected"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "scripts/circular.mjs:22"
Auditor: "effect-layer-context-architect"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ELC-003 — Madge cycle guard skips type imports, leaving type-level cycles undetected

`LOW` · `dx` · `—` · reported by **Effect Layer/Context Architect** (`effect-layer-context-architect`)

Status: **ready-for-agent**

## Summary

The static guard mirrors effect's own script and only catches value-level cycles; `import type` cycles are invisible to it. Type-only circularity does not crash the runtime, but it does degrade `tsc -b` incremental builds and type inference across the strata (core/ports/api/server), and this codebase leans heavily on precise conditional types (Validate<P>, FoldLayer) that are exactly what type cycles corrupt. The script comment documents why it exists (glob/madge empty-input crashes) but not that type cycles are out of scope.

## Evidence

Source: `scripts/circular.mjs:22`

```
detectiveOptions: {
      ts: {
        skipTypeImports: true,
```

## Recommended fix

Keep skipTypeImports for the fast value check, but add a comment stating the scope, and rely on the existing `pnpm typecheck` (tsc -b) as the type-cycle backstop; if type cycles become a real risk, run a second madge pass without skipTypeImports in CI only.

## Context

- Auditor verdict on this domain: **pass** (score 84/100), domain: Layer/Context architecture
- Full dossier: [`effect-layer-context-architect`](../../.reports/effect-layer-context-architect/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 52 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `scripts/circular.mjs:19`. Fix: Break the one existing type cycle, then make circular.mjs run a second, type-inclusive madge pass (and scan .tsx) so type-level cycles fail `pnpm circular`. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
