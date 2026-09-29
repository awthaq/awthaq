---
ID: "NSA-009"
Title: "Per-package quality metrics describe the package as an empty export-{} placeholder - badly stale"
Level: info
Category: "testing"
Status: resolved
Package: "—"
Source: ".quality-metrics/next.json:21"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-009 — Per-package quality metrics describe the package as an empty export-{} placeholder - badly stale

`INFO` · `testing` · `—` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

The metrics snapshot (fileCount 1, totalLoc 9, 'exports nothing') predates the implementation: packages/next/src now holds 5 modules exporting 3 functions and 4 types, with 14 tests. Any dashboard or gate reading .quality-metrics/next.json will materially misreport this package; this audit measured from source instead.

## Evidence

Source: `.quality-metrics/next.json:21`

```
"The package exports nothing (`export {};`), so the planned Next.js server/client boundary, cookie forwarding, and SSR decision hydration (spec BEH-EA-185-192) have no types to verify; its two runtime deps (@effect-auth/react, effect) are entirely unexercised."
```

## Recommended fix

Regenerate .quality-metrics/next.json from the current tree and add a staleness check that fails when a package's index.ts exports diverge from the metrics' recorded surface.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `quality-metrics-regeneration`. Duplicate of `DESS-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `.quality-metrics/next.json:21`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `DESS-005-developer-experience-sdk-specialist` — closed by its fix (see that issue's Resolved comment).
