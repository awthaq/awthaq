---
ID: "MTS-004"
Title: "Adding a package requires hand-syncing five 21-entry lists with no enforcement"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "tsconfig.base.json:43"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-004 — Adding a package requires hand-syncing five 21-entry lists with no enforcement

`MEDIUM` · `dx` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **ready-for-agent**

## Summary

The 21-package roster is duplicated by hand in five places: root tsconfig.json references (lines 3-73), tsconfig.packages.json references (lines 3-67), tsconfig.base.json paths (lines 45-67), tsconfig.test.json paths (lines 25-47, a verbatim copy of base), and .changeset/config.json's fixed group (lines 5-29). The base file's own comment documents this as a manual step. Any one of the five forgotten produces a different class of silent failure: a package missing from tsconfig.packages.json never builds in `pnpm build` (release publishes stale lib/), missing from the changeset fixed group breaks lockstep versioning, missing from paths breaks source resolution for tests.

## Evidence

Source: `tsconfig.base.json:43`

```
    // tsconfig.base.json lists every @qadi/* package. Add a new entry here
    // whenever a new package is scaffolded.
```

## Recommended fix

Generate all five lists from one source of truth (glob packages/*) in a scripts/sync.mjs run via `prepare`, or add a check-mode script to `pnpm check` that fails when the five rosters diverge from packages/*/package.json.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-008` — noPropertyAccessFromIndexSignature disabled in an otherwise maximal strict profile](low/AH-008-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AH-009` — Global DOM lib in base config lets server packages type-check DOM references](info/AH-009-anders-hejlsberg.md) `_(anders-hejlsberg, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `workspace-roster-sync`. Evidence at HEAD ec065a7: `tsconfig.base.json:41`. Fix: Add scripts/sync-workspace.mjs that derives every roster from packages/*/package.json (name, private flag) and either writes (`--write`) or verifies (`--check`) the five lists; run `--check` in `pnpm check`. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
