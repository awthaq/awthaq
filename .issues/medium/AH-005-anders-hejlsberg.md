---
ID: "AH-005"
Title: "Shipped type-KPI metrics are stale and contradict the source"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: ".quality-metrics/oauth.json:8"
Auditor: "anders-hejlsberg"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-005 — Shipped type-KPI metrics are stale and contradict the source

`MEDIUM` · `dx` · `—` · reported by **Anders Hejlsberg — Creator/Lead Architect of TypeScript** (`anders-hejlsberg`)

Status: **resolved**

## Summary

oauth.json reports typeAssertions: 0, fileCount: 1, totalLoc: 9 (lines 8, 42-43) while oauth/src actually has 5 files, ~1033 lines, and at least 6 assertion sites. core.json reports brandedTypes: 0 (line 15) against 4 real branded types and totalLoc: 611 (line 43) against 3458 actual. The central dashboard will render confident wrong numbers for exactly the type-safety signals this audit is scored on, and repo-checks.json's typecheckOk: true cannot be reconciled with any recent source state by a reader.

## Evidence

Source: `.quality-metrics/oauth.json:8`

```
"typeAssertions": 0,
```

## Recommended fix

Re-run the metrics generator (scripts/generate-quality-dashboard.mjs) against current source before the dashboard consumes them, and add a freshness guard (e.g. commit hash or max-age check) so a stale snapshot fails loudly instead of certifying zeros.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Type system design
- Full dossier: [`anders-hejlsberg`](../../.reports/anders-hejlsberg/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/oauth.json:8`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
