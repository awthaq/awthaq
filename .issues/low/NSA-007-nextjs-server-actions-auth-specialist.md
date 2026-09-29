---
ID: "NSA-007"
Title: "Unused @awthaq/react dependency and a package description promising unshipped decision hydration"
Level: low
Category: "dx"
Status: resolved
Package: "next"
Source: "packages/next/package.json:5"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-007 — Unused @awthaq/react dependency and a package description promising unshipped decision hydration

`LOW` · `dx` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

The description promises 'SSR decision hydration', but no hydration code exists in the package and the design spec explicitly rules it out of scope (.scratch/next-package/spec.md:236-245). Likewise @awthaq/react is declared as a runtime dependency (package.json:36) yet imported nowhere in src/ or test/ - a grep finds it only in package.json, tsconfig paths, and the CHANGELOG. Both misstate the package's surface to consumers and add install weight; the implementation decisions doc says the react dependency was for re-exports that never landed.

## Evidence

Source: `packages/next/package.json:5`

```
  "description": "Next.js adapter: server/client boundary, cookie forwarding, SSR decision hydration.",
```

## Recommended fix

Drop @awthaq/react from dependencies until something re-exports it, and reword the description to 'server session verification, optimistic proxy check, Set-Cookie bridging for server actions'.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-003` — @awthaq/next declares an unused @awthaq/react dependency](medium/BO-003-balazs-orban.md) `_(balazs-orban, medium)_`
- [`DESS-004` — @awthaq/next declares an unused runtime dependency on @awthaq/react](medium/DESS-004-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`ERAS-005` — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure](low/ERAS-005-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`MTS-002` — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist](medium/MTS-002-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`
- [`NSA-005` — No peerDependencies: zero declared compatibility range for next or react](medium/NSA-005-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-package-manifest-hygiene`. Duplicate of `BO-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/package.json:5`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BO-003-balazs-orban` — closed by its fix (see that issue's Resolved comment).
