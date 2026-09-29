---
ID: "MTS-005"
Title: "tsconfig.test.json duplicates the identical paths block it already inherits"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "tsconfig.test.json:25"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-005 — tsconfig.test.json duplicates the identical paths block it already inherits

`LOW` · `dx` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **ready-for-agent**

## Summary

tsconfig.test.json extends ./tsconfig.base.json (line 2) and then re-declares the exact 21-entry paths map that base already defines (lines 45-67) — same entries, same order, and both files live in the repo root so relative resolution is identical. This is 22 lines of pure duplication in a file that exists precisely to be the test-mode diff from base (declaration:false etc.), and it is one of the five rosters from MTS-004 that must drift eventually.

## Evidence

Source: `tsconfig.test.json:25`

```
    "paths": {
      "@awthaq/api": ["./packages/api/src/index.ts"],
      "@awthaq/ports": ["./packages/ports/src/index.ts"],
```

## Recommended fix

Delete the paths block from tsconfig.test.json and rely on the inherited one; keep only the overrides that differ.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `workspace-roster-sync`. Evidence at HEAD ec065a7: `tsconfig.test.json:2`. Fix: Delete the paths block (and its comment) from tsconfig.test.json; rely on inheritance. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
