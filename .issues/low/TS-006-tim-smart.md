---
ID: "TS-006"
Title: "Per-package quality-metrics JSONs describe a 9-LOC placeholder, not the real packages"
Level: low
Category: "dx"
Status: resolved
Package: "—"
Source: ".quality-metrics/server.json:43"
Auditor: "tim-smart"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TS-006 — Per-package quality-metrics JSONs describe a 9-LOC placeholder, not the real packages

`LOW` · `dx` · `—` · reported by **Effect Platform & Infrastructure Maintainer** (`tim-smart`)

Status: **resolved**

## Summary

server.json and sql.json both report a single 9-line `export {}` index (their strengths even say 'Placeholder exports nothing at packages/server/src/index.ts:10'), while the actual trees are 6 files/808 LOC and 4 files/1103 LOC respectively. Any dashboard or gate consuming .quality-metrics will grade two of the most platform-critical packages on phantom data — the exact silent-staleness failure the repo's own CI comment warns about for the PG suite.

## Evidence

Source: `.quality-metrics/server.json:43`

```
"fileCount": 1,
      "totalLoc": 9,
      "avgFileLoc": 9.0,
```

## Recommended fix

Regenerate the metric JSONs from the current tree and add a freshness check (e.g. compare fileCount against glob) so future drift fails loudly instead of feeding the audit dashboard stale numbers.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: platform & SQL integration
- Full dossier: [`tim-smart`](../../.reports/tim-smart/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/server.json:42`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
