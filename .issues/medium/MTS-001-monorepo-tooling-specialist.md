---
ID: "MTS-001"
Title: "32 of 85 project-reference edges are unreachable from src imports (template-copied reference lists)"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "core"
Source: "packages/core/tsconfig.src.json:25"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-001 — 32 of 85 project-reference edges are unreachable from src imports (template-copied reference lists)

`MEDIUM` · `correctness` · `core` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **ready-for-agent**

## Summary

Comparing every packages/*/tsconfig.src.json references array against the actual `from "@awthaq/*"` import map shows 32 of 85 edges whose target is not reachable via any src import path: core/ports/sql each reference api without importing it; next references react (never imported); test references qadi; admin, oauth, organization, passkey and password each reference server although only their test/ files import it; the four stub packages (cli, api-key, magic-link, two-factor, sources are literally `export {}`) reference the full 5-6 package upstream chain; react references client without importing it. Ten packages share byte-identical 5-edge reference blocks (same #F495 snapshot), betraying a copy-paste template. Today the error is only in the wasteful direction (extra builds), but the same habit that pastes 5 edges into every package is what will eventually omit a needed edge — the red-flag failure mode for tsc -b, where a missing reference surfaces as silently stale .d.ts in dependent packages. Extra edges also inflate incremental invalidation: editing api invalidates every project referencing it, not just importers.

## Evidence

Source: `packages/core/tsconfig.src.json:25`

```
      "path": "../api/tsconfig.src.json"
```

## Recommended fix

Trim each tsconfig.src.json references to the packages its src actually imports (tsc -b resolves transitives through each referenced project's own references); keep test-only imports out of the src build graph. Add a guard script to `pnpm check` that diffs the madge import graph against the reference graph so drift fails CI instead of accumulating.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `build-tooling-hygiene`. Evidence at HEAD ec065a7: `packages/core/tsconfig.src.json:25`. Fix: Trim every tsconfig.src.json references list to its transitive src-import closure and add a CI guard. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
