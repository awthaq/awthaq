---
ID: "BO-010"
Title: "CookieJarLike does not structurally satisfy SvelteKit's Cookies.set (path required) — second-adapter fit untested"
Level: info
Category: "api"
Status: needs-triage
Package: "next"
Source: "packages/next/src/WithNextCookies.ts:44"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-010 — CookieJarLike does not structurally satisfy SvelteKit's Cookies.set (path required) — second-adapter fit untested

`INFO` · `api` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **needs-triage**

## Summary

CookieSetOptions makes every attribute optional, but SvelteKit's Cookies.set requires path in its options object, so a SvelteKit event.cookies is not assignable to CookieJarLike without a wrapper (Astro's superset-shaped options would fit). All awthaq-issued cookies do set path=/ (Sessions.ts:128, Csrf.ts:158), so the runtime data is fine — the friction is purely the structural fit, and nothing in the repo documents or tests the second adapter against it. This is the concrete shape of 'what would break supporting Astro/SvelteKit next': not the logic, but the unowned boundary types.

## Evidence

Source: `packages/next/src/WithNextCookies.ts:44`

```
export interface CookieJarLike {
  readonly set: (name: string, value: string, options?: CookieSetOptions) => unknown;
}
```

## Recommended fix

When hoisting the adapter core (BO-004), add a compatibility table or test per target framework's cookie API (Next ResponseCookies, Astro Astro.cookies, SvelteKit Cookies), and default path in the bridge so a missing attribute still satisfies path-required jars.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-004` — Framework-neutral adapter code lives in a Next-named package, stranding Astro/SvelteKit reuse](medium/BO-004-balazs-orban.md) `_(balazs-orban, medium)_`
- [`NSA-006` — parseSetCookie percent-decodes values browsers would store verbatim, and NaN/Invalid Date options can reach the jar](low/NSA-006-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** WONTFIX-CANDIDATE (confidence medium); workstream `next-edge-stateless-tier`. Evidence at HEAD ec065a7: `packages/next/src/WithNextCookies.ts:44`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/11-frontend-next-react-client.md`.
