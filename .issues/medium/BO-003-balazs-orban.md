---
ID: "BO-003"
Title: "@awthaq/next declares an unused @awthaq/react dependency"
Level: medium
Category: "architecture"
Status: resolved
Package: "next"
Source: "packages/next/package.json:36"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-003 — @awthaq/next declares an unused @awthaq/react dependency

`MEDIUM` · `architecture` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

No source file in packages/next imports @awthaq/react (or @qadi/*, @effect/atom-react) — grep over the package finds it only in package.json, tsconfig paths, and the changelog. The dependency drags the entire client React/Qadi/atom graph into a server-only adapter's install and bundler graph, for zero use. Beyond the weight, it is a false statement of the package's stratum: the next package's own header comment prides itself on staying off of qadi entirely.

## Evidence

Source: `packages/next/package.json:36`

```
    "@awthaq/core": "workspace:*",
    "@awthaq/react": "workspace:*",
    "@awthaq/server": "workspace:*",
```

## Recommended fix

Remove @awthaq/react from dependencies and the tsconfig.src.json path mapping; let the changelog note it as a dependency cleanup.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DESS-004` — @awthaq/next declares an unused runtime dependency on @awthaq/react](medium/DESS-004-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`ERAS-005` — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure](low/ERAS-005-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`MTS-002` — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist](medium/MTS-002-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`
- [`NSA-005` — No peerDependencies: zero declared compatibility range for next or react](medium/NSA-005-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-007` — Unused @awthaq/react dependency and a package description promising unshipped decision hydration](low/NSA-007-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-package-manifest-hygiene`. Evidence at HEAD ec065a7: `packages/next/package.json:27`. Fix: Remove the phantom @awthaq/react edge everywhere and make the description truthful. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Removed @awthaq/react from packages/next dependencies, tsconfig.src.json path+reference and the knip ignoreDependencies entry; description reworded to what ships (getSession/hasSessionCookie/withNextCookies); lockfile refreshed offline. Gates: typecheck, knip clean for packages/next without the ignore (remaining knip findings are pre-existing: migrate-better-auth devDep, features CsrfTestSupport exports). Changeset intentionally not added: no changeset has ever been committed in this repo and all packages are private.
