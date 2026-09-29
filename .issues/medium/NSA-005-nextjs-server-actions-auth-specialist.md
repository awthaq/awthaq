---
ID: "NSA-005"
Title: "No peerDependencies: zero declared compatibility range for next or react"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "next"
Source: "packages/next/package.json:33"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-005 — No peerDependencies: zero declared compatibility range for next or react

`MEDIUM` · `api` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **ready-for-agent**

## Summary

The package has no peerDependencies section at all (nothing between the exports block ending at line 27 and dependencies at line 33), even though its whole purpose is Next.js integration and its recipes target Next 15+ async request APIs and the Next 16.3 proxy.ts convention (packages/next/src/HasSessionCookie.ts:6-7). A consumer can install @awthaq/next into a Next 13/14 app where the README's proxy.ts file does not exist and cookies()/headers() are synchronous, with no install-time warning. The Next 15/16 posture is real in the code but entirely implicit and undeclared.

## Evidence

Source: `packages/next/package.json:33`

```
  "dependencies": {
    "@awthaq/api": "workspace:*",
    "@awthaq/core": "workspace:*",
```

## Recommended fix

Declare peerDependencies { next: ">=15", react: ">=19" } (peerDependenciesMeta optional where apt), and add a one-line README note that pre-16.3 apps put the recipe in middleware.ts instead of proxy.ts.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-003` — @awthaq/next declares an unused @awthaq/react dependency](medium/BO-003-balazs-orban.md) `_(balazs-orban, medium)_`
- [`DESS-004` — @awthaq/next declares an unused runtime dependency on @awthaq/react](medium/DESS-004-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`ERAS-005` — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure](low/ERAS-005-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, low)_`
- [`MTS-002` — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist](medium/MTS-002-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`
- [`NSA-007` — Unused @awthaq/react dependency and a package description promising unshipped decision hydration](low/NSA-007-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `next-package-manifest-hygiene`. Evidence at HEAD ec065a7: `packages/next/package.json:42`. Fix: Declare the Next.js range the recipes assume and document the proxy.ts/middleware.ts split. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Plan note (2026-09-29):** Partially done: README now states the proxy.ts (Next 16.3+) vs middleware.ts split and the Next 15+ assumption. NOT done: `peerDependencies.next` (+ optional meta). pnpm auto-installs the peer for this workspace package, so adding it makes the lockfile resolve next + sharp (~500 lines) and breaks `pnpm install --offline` for every other worktree (no next metadata in the offline mirror). Enable by adding `"next": ">=15.0.0"` to packages/next peerDependencies with `peerDependenciesMeta.next.optional = true` and regenerating the lockfile online, at merge time.
