---
ID: "DESS-005"
Title: "Per-package quality metrics describe empty placeholders from the old naming era"
Level: medium
Category: "docs"
Status: ready-for-human
Package: "—"
Source: ".quality-metrics/react.json:74"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-005 — Per-package quality metrics describe empty placeholders from the old naming era

`MEDIUM` · `docs` · `—` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **ready-for-human**

## Summary

All three audited packages' metric JSONs profile a 9-line `export {}` stub (client.json:42-51 totalLoc:9, exportedTypeCount:0; react.json and next.json likewise) while the real sources are 226/99/115+ lines with rich type surface. react.json:76 even cites a dependency on '@effect-auth/client (package.json:33)' — a package name that no longer exists anywhere in the repo (the scope is @awthaq). Any dashboard, scorecard, or reviewer consuming .quality-metrics/ — which this very audit pipeline does — will report the consumer SDK as empty scaffolding, compounding DESS-001's false 'pre-implementation' signal with numbers that look authoritative.

## Evidence

Source: `.quality-metrics/react.json:74`

```
"title": "Entire package is an unimplemented placeholder — zero type-level API surface",
        "evidence": "packages/react/src/index.ts:8-10",
```

## Recommended fix

Re-run the metrics generator over the current tree and delete or archive the stale JSONs in the meantime; if the generator is the old @effect-auth-era tool, update its scope regex so the next run does not silently re-emit phantom package names.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `quality-metrics-regeneration`. Evidence at HEAD ec065a7: `.quality-metrics/react.json:73`. Fix: Canonical for the seven 'stale .quality-metrics' findings: discard the Sep-12 snapshot and add the renderer freshness guard so stale numbers cannot be rendered silently. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-human.
