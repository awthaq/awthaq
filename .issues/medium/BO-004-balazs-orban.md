---
ID: "BO-004"
Title: "Framework-neutral adapter code lives in a Next-named package, stranding Astro/SvelteKit reuse"
Level: medium
Category: "architecture"
Status: resolved
Package: "next"
Source: "packages/next/src/WithNextCookies.ts:110"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-004 — Framework-neutral adapter code lives in a Next-named package, stranding Astro/SvelteKit reuse

`MEDIUM` · `architecture` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

Two of the three exports are framework-agnostic by construction: getSession consumes a structural HeadersLike, and withNextCookies is a pure Response-to-jar bridge containing nothing Next-specific (its own header says it 'never imports from next/headers'). Only the names and the package home are Next-bound. A SvelteKit or Astro adapter must therefore either import @awthaq/next (wrong name, wrong dependency graph, includes finding BO-003's react dep) or fork ~200 lines. This is the adapter-first red flag in my own hiring rubric, inverted: the core is right, but the packaging bakes one framework's name into shared code.

## Evidence

Source: `packages/next/src/WithNextCookies.ts:110`

```
export const withNextCookies = (response: Response, jar: CookieJarLike): void => {
```

## Recommended fix

Hoist GetSession/HasSessionCookie/WithNextCookies/CookieHeader into a framework-agnostic package (e.g. @awthaq/adapters-core or a server-adjacent home); keep @awthaq/next as a thin re-export shell and add @awthaq/sveltekit/@awthaq/astro shells as the API-fit test.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-010` — CookieJarLike does not structurally satisfy SvelteKit's Cookies.set (path required) — second-adapter fit untested](info/BO-010-balazs-orban.md) `_(balazs-orban, info)_`
- [`NSA-006` — parseSetCookie percent-decodes values browsers would store verbatim, and NaN/Invalid Date options can reach the jar](low/NSA-006-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `next-edge-stateless-tier`. Evidence at HEAD ec065a7: `packages/next/src/WithNextCookies.ts:110`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/11-frontend-next-react-client.md`.

**Resolved (2026-09-29):** Extracted the framework-neutral core into a new `@awthaq/web` package (packages/web): `CookieHeader.ts`/`CookieJar.ts` (jar abstraction, `applyResponseCookies`, `parseSetCookie`, `setCookie`), `Session.ts` (`getSession`, `makeGetSession(verify)`, `applyRotatedSession`, `verifySessionToken`), `HasSessionCookie.ts`, `InProcessClient.ts` (CSRF-echoing client) and an edge-safe `@awthaq/web/cookies` subpath. Chosen over a `./core` subpath of @awthaq/next because that would still drag the Next-named package, its `react`/`next` peers and `React.cache` into an Astro/SvelteKit graph; @awthaq/next stays the Next adapter (`React.cache` dedup through `makeGetSession`, `withNextCookies`/`serverActionClient` aliases, Seed, edge) and lost its direct core/client dependencies. Tests moved with the code (packages/web/test: CookieJar, Session incl. the injected-verify seam, HasSessionCookie, InProcessClient) and packages/next/test/GetSession.test.ts pins the re-export identity; EdgeImports test still proves the edge entry never reaches core/server. Spec 24-nextjs-ssr.md, traceability, READMEs, changeset (.changeset/web-adapter-core.md) updated. Gates: clean-build typecheck + tsc -p tsconfig.test.json, package:smoke (web PASS), oxlint, knip, format:check, circular, check:readmes, check:error-tags, workspace:check, coverage thresholds, test:bdd, spec:verify:strict. No astro/sveltekit shell packages were added (no consumer; the SvelteKit/Astro jar shapes are pinned by a compile-time test).
