---
ID: "IC-004"
Title: "No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves"
Level: medium
Category: "dx"
Status: resolved
Package: "next"
Source: "packages/next/README.md:100"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-004 — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves

`MEDIUM` · `dx` · `next` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

The documented sign-in server action requires constructing a synthetic Request, dispatching it through the app's own composed router web handler, calling withNextCookies, and inspecting response.ok — versus Auth.js's single await signIn("credentials", ...) (or a provider redirect) that hides dispatch, cookie handling, and error mapping. Combined with the mandatory hand-written globalThis-pinned ManagedRuntime recipe and the 120-line server quickstart (README.md:44-163), the time-to-first-login is an afternoon of Effect-specific plumbing for what is a five-line config in the incumbent. The explicit-runtime seam is a principled choice, but nothing packages the common case on top of it.

## Evidence

Source: `packages/next/README.md:100`

```
  const request = new Request("http://internal/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
```

## Recommended fix

Add an opt-in convenience layer (not a replacement): a globalThis-pinning helper taking the app Layer, plus signIn/signOut server-action helpers that internally dispatch the composed router and bridge cookies, leaving the current three-function surface intact for advanced users.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-002` — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder](medium/BO-002-balazs-orban.md) `_(balazs-orban, medium)_`
- [`ERS-006` — Next README dispose recipe drops the dispose promise and never drains in-flight work](low/ERS-006-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`NSA-003` — README page recipe drops the force-dynamic guard that every spec recipe includes](medium/NSA-003-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-008` — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)](low/NSA-008-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-server-action-facade`. Duplicate of `BO-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/README.md:100`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `BO-002-balazs-orban` — closed by its fix (see that issue's Resolved comment).
