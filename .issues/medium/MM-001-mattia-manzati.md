---
ID: "MM-001"
Title: "Exports wildcard bun condition cannot resolve .tsx files (react Providers)"
Level: medium
Category: "dx"
Status: resolved
Package: "react"
Source: "packages/react/package.json:23"
Auditor: "mattia-manzati"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# MM-001 — Exports wildcard bun condition cannot resolve .tsx files (react Providers)

`MEDIUM` · `dx` · `react` · reported by **Mattia Manzati — Effect Developer Tooling** (`mattia-manzati`)

Status: **resolved**

## Summary

The `"./*"` exports entry maps the bun condition to `./src/*.ts`, but the package ships `src/Providers.tsx`. A Bun consumer doing a deep `import ... from '@awthaq/react/Providers'` matches the bun condition and then fails to find the file — exports conditions do not fall through to `import`/`default` on a missing file. The compiled conditions work (tsc emits lib/Providers.js + lib/Providers.d.ts, verified on disk), so only Bun deep imports are broken. None of the three package:smoke checks catch this: publint and attw validate node/bundler resolution, not the bun condition.

## Evidence

Source: `packages/react/package.json:23`

```
"bun": "./src/*.ts",
```

## Recommended fix

Use a fallback array for the bun condition (e.g. `"bun": ["./src/*.tsx", "./src/*.ts"]`) in all 21 packages, and extend package-smoke with a check that every file under src/ resolves through the exports map under at least one condition.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 80/100), domain: dev tooling
- Full dossier: [`mattia-manzati`](../../.reports/mattia-manzati/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 33 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DESS-007` — @awthaq/react's description claims integration with @awthaq/client that does not exist](low/DESS-007-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** ALREADY-FIXED (confidence high); workstream `react-package-deps`. Already fixed by commit 387838f. Evidence at HEAD ec065a7: `packages/react/package.json:14`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
