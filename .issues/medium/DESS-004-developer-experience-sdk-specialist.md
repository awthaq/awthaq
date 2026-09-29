---
ID: "DESS-004"
Title: "@awthaq/next declares an unused runtime dependency on @awthaq/react"
Level: medium
Category: "dx"
Status: resolved
Package: "next"
Source: "packages/next/package.json:36"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-004 — @awthaq/next declares an unused runtime dependency on @awthaq/react

`MEDIUM` · `dx` · `next` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **resolved**

## Summary

Nothing under packages/next/src imports @awthaq/react (grep over packages/next/src shows imports only of @awthaq/api, @awthaq/core, @awthaq/server, effect, and local modules), yet it is declared as a runtime dependency (package.json:36) and mapped in tsconfig.src.json:14. Because @awthaq/react carries a react >=19.3.0 peerDependency (packages/react/package.json:51-53), every @awthaq/next install — including API-only Next apps that never render the providers — is nudged into installing React, inflating the install footprint and generating peer-warning noise on the very first npm/pnpm install a consumer runs.

## Evidence

Source: `packages/next/package.json:36`

```
    "@awthaq/core": "workspace:*",
    "@awthaq/react": "workspace:*",
    "@awthaq/server": "workspace:*",
```

## Recommended fix

Drop @awthaq/react from @awthaq/next's dependencies and tsconfig paths (or, if future SSR hydration will need it, move it to peerDependencies with a comment); re-verify the package typechecks with the dependency removed.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-003` — @awthaq/next declares an unused @awthaq/react dependency](medium/BO-003-balazs-orban.md) `_(balazs-orban, medium)_`
- [`ERAS-005` — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure](low/ERAS-005-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`MTS-002` — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist](medium/MTS-002-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`
- [`NSA-005` — No peerDependencies: zero declared compatibility range for next or react](medium/NSA-005-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-007` — Unused @awthaq/react dependency and a package description promising unshipped decision hydration](low/NSA-007-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-package-manifest-hygiene`. Duplicate of `BO-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/package.json:30`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BO-003-balazs-orban` — closed by its fix (see that issue's Resolved comment).
