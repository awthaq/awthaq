---
ID: "MTS-009"
Title: "build.mjs and circular.mjs use cwd-relative globs and silently succeed from the wrong directory"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: "scripts/build.mjs:13"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-009 — build.mjs and circular.mjs use cwd-relative globs and silently succeed from the wrong directory

`LOW` · `dx` · `—` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **resolved**

## Summary

scripts/build.mjs:11 and scripts/circular.mjs:9 glob `packages/*` relative to process.cwd(); run from anywhere other than the repo root, globSync returns [] and both scripts print their 'skipping' message and exit 0 — a green build/circular check that did nothing. scripts/package-smoke.mjs:22-27 already solves this correctly by anchoring rootDir from import.meta.url and globbing with absolute paths, so the fix is a convention alignment, and the empty-monorepo guards both scripts still carry (their comments say 'until M1 Core adds real packages') are dead now that 21 packages exist and only add the silent-skip footgun.

## Evidence

Source: `scripts/build.mjs:13`

```
if (packages.length === 0) {
  console.log("build: no packages/* yet, skipping");
```

## Recommended fix

Port package-smoke.mjs's rootDir anchoring into build.mjs and circular.mjs, and drop the packages.length === 0 early-exit branches — an actually-empty glob from the repo root is now a bug worth failing on, not skipping.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MM-009` — Dev scripts are POSIX/tsc-on-PATH only; Windows contributors break](low/MM-009-mattia-manzati.md) `_(mattia-manzati, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `dev-scripts-tooling`. Evidence at HEAD ec065a7: `scripts/build.mjs:11`. Fix: Anchor build.mjs/circular.mjs (and package-smoke.mjs's empty-guard) at the repo root and turn the empty-glob skip into a hard failure. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New scripts/_root.mjs (repo root anchor); build.mjs, circular.mjs, package-smoke.mjs (and the new clean/sync scripts) resolve from the root and an empty roster is a hard failure (exit 1) instead of a skip. circular.mjs also scans .tsx. Verified: circular.mjs run from /tmp still scans the repo (root-anchored); an empty roster is a hard failure by construction.
