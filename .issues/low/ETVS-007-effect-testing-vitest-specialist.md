---
ID: "ETVS-007"
Title: "Coverage collected but never enforced, with a stale pointer to qadi's 'threshold pattern'"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "vitest.config.ts:21"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-007 — Coverage collected but never enforced, with a stale pointer to qadi's 'threshold pattern'

`LOW` · `dx` · `—` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **resolved**

## Summary

The root config wires v8 coverage (text/html/lcov) and `pnpm check` runs `pnpm coverage`, but no thresholds exist anywhere - neither the referenced 'workspace-wide default' nor the per-package pattern the comment points to: packages/qadi/vitest.config.ts contains no coverage block at all. Coverage is therefore reported, never gated, in a repo whose CI discipline (`check` chain) otherwise gates everything.

## Evidence

Source: `vitest.config.ts:21`

```
      // Per-package thresholds belong here once a package needs a bar other
      // than the workspace-wide default (see qadi's own vitest.config.ts for
```

## Recommended fix

Add workspace-wide coverage.thresholds (lines/branches starting modestly, e.g. 70) and the per-package override block the comment promises; correct the qadi pointer to describe the intended pattern rather than an existing one.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-004` — Coverage is reported but never threshold-enforced, against the DoD's own gate 6](low/MM-004-mattia-manzati.md) `_(mattia-manzati, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `coverage-enforcement`. Duplicate of `MM-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `vitest.config.ts:21`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `MM-004-mattia-manzati` — closed by its fix (see that issue's Resolved comment).
