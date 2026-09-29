---
ID: "ERAS-005"
Title: "@awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure"
Level: low
Category: "performance"
Status: resolved
Package: "next"
Source: "packages/next/package.json:36"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-005 — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure

`LOW` · `performance` · `next` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **resolved**

## Summary

No module under packages/next/src (or anywhere else in the package) imports @awthaq/react — GetSession.ts:32-38 and WithNextCookies.ts import only @awthaq/api, @awthaq/core, @awthaq/server, and effect — yet the adapter declares it as a runtime dependency. That drags react (peerDependency), @effect/atom-react, and both @qadi packages into the install and resolution graph of any bundle importing @awthaq/next, including the edge/proxy bundle that needs only CookieHeader.ts plus Api.SessionCookie.key. sideEffects:false saves the emitted bytes after tree-shaking, but the dependency closure itself is cold-start-weight the persona explicitly cares about.

## Evidence

Source: `packages/next/package.json:36`

```
    "@awthaq/react": "workspace:*",
```

## Recommended fix

Remove @awthaq/react from @awthaq/next dependencies (or move it to devDependencies if a planned SSR-hydration helper will use it), and keep the proxy.ts entry surface to @awthaq/api + CookieHeader only.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-003` — @awthaq/next declares an unused @awthaq/react dependency](medium/BO-003-balazs-orban.md) `_(balazs-orban, medium)_`
- [`DESS-004` — @awthaq/next declares an unused runtime dependency on @awthaq/react](medium/DESS-004-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, medium)_`
- [`MTS-002` — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist](medium/MTS-002-monorepo-tooling-specialist.md) `_(monorepo-tooling-specialist, medium)_`
- [`NSA-005` — No peerDependencies: zero declared compatibility range for next or react](medium/NSA-005-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-007` — Unused @awthaq/react dependency and a package description promising unshipped decision hydration](low/NSA-007-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-package-manifest-hygiene`. Duplicate of `BO-003` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/package.json:30`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.
