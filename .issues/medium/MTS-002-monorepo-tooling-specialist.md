---
ID: "MTS-002"
Title: "packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist"
Level: medium
Category: "dx"
Status: resolved
Package: "next"
Source: "packages/next/package.json:36"
Auditor: "monorepo-tooling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MTS-002 — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist

`MEDIUM` · `dx` · `next` · reported by **Monorepo Tooling Specialist** (`monorepo-tooling-specialist`)

Status: **resolved**

## Summary

No file under packages/next/src or packages/next/test imports @awthaq/react (grep across the package matches only this manifest line, the CHANGELOG, and tsconfig paths/references), yet next declares it as a runtime dependency, references ../react/tsconfig.src.json in its build graph, and knip.json line 55 explicitly silences the finding with `ignoreDependencies: ["@awthaq/react"]`. Every consumer of @awthaq/next would install @awthaq/react for nothing once published, and react rebuilds invalidate next in tsc -b for no reason. The knip ignore converts a dependency-graph fact into invisible config — exactly the drift the tool exists to catch.

## Evidence

Source: `packages/next/package.json:36`

```
    "@awthaq/react": "workspace:*",
```

## Recommended fix

Remove @awthaq/react from next's dependencies and drop the react path/reference from next/tsconfig.src.json; delete the knip.json ignore. If the intent is a future re-export seam, gate it on the import actually landing.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: monorepo build tooling
- Full dossier: [`monorepo-tooling-specialist`](../../.reports/monorepo-tooling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 36 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-003` — @awthaq/next declares an unused @awthaq/react dependency](medium/BO-003-balazs-orban.md) `_(balazs-orban, medium)_`
- [`DESS-004` — @awthaq/next declares an unused runtime dependency on @awthaq/react](medium/DESS-004-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`ERAS-005` — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure](low/ERAS-005-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`NSA-005` — No peerDependencies: zero declared compatibility range for next or react](medium/NSA-005-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-007` — Unused @awthaq/react dependency and a package description promising unshipped decision hydration](low/NSA-007-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-package-manifest-hygiene`. Duplicate of `BO-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/package.json:30`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
