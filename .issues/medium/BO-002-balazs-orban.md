---
ID: "BO-002"
Title: "No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "next"
Source: "packages/next/README.md:105"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-002 — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder

`MEDIUM` · `dx` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **ready-for-agent**

## Summary

Auth.js's Next.js adapter is bought as handlers/auth/signIn/signOut; here every application hand-rolls dispatch of a Request against its own composed router to obtain a Response whose Set-Cookie headers it can harvest — and the flagship README snippet for the primary sign-in path literally has a 'build your web handler from AppApi' hole where the machinery should be. The hard parts (per-composition router construction, toWebHandler lifecycle, CSRF header injection) are undocumented application plumbing, which is precisely the part that will be re-broken (or forked wrongly) by each adopter and by each future framework adapter.

## Evidence

Source: `packages/next/README.md:105`

```
  const { handler } = await runtime.runPromise(/* build your web handler from AppApi */);
  const response = await handler(request);
  withNextCookies(response, await cookies());
```

## Recommended fix

Ship an Auth.handlers-style helper (or a documented, reusable toWebHandler runtime recipe) plus server-action signIn/signOut wrappers that compose the dispatch + withNextCookies bridge in one call; make the README example runnable end to end.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ERS-006` — Next README dispose recipe drops the dispose promise and never drains in-flight work](low/ERS-006-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`IC-004` — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves](medium/IC-004-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-003` — README page recipe drops the force-dynamic guard that every spec recipe includes](medium/NSA-003-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-008` — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)](low/NSA-008-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-server-action-facade`. Evidence at HEAD ec065a7: `packages/next/README.md:99`. Fix: Ship a typed, in-process server-action client: `HttpApiClient` over the app's own composed api whose transport dispatches to the app's web handler, forwards the action request's cookies/CSRF/origin/UA, and harvests Set-Cookie into Next's jar — so `client.password.signIn({...})` works for ANY composed plugin set. Respects the existing next-package decision (no runtime construction owned by the package: the app passes its handler/runtime). (effort L). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
