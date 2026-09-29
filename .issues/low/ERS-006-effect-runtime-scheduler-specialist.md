---
ID: "ERS-006"
Title: "Next README dispose recipe drops the dispose promise and never drains in-flight work"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "next"
Source: "packages/next/README.md:40"
Auditor: "effect-runtime-scheduler-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERS-006 — Next README dispose recipe drops the dispose promise and never drains in-flight work

`LOW` · `dx` · `next` · reported by **Effect Runtime & Scheduler Specialist** (`effect-runtime-scheduler-specialist`)

Status: **ready-for-agent**

## Summary

The globalThis-pinned ManagedRuntime recipe is the runtime-construction pattern every Next.js application copies, and its shutdown half is `void made.dispose()` on SIGINT/SIGTERM. Discarding the promise means process exit can race layer finalizers (e.g. a SQL pool closing under an in-flight transaction), and nothing coordinates disposal with in-flight runtime.runPromise server actions — GetSession.ts:114 issues one per request, each an independent fiber root the recipe never tracks. This is the persona's red flag in miniature: the signal handler exists, but there is no drain of in-flight critical operations before resources close.

## Evidence

Source: `packages/next/README.md:40`

```
const dispose = () => void made.dispose();
```

## Recommended fix

Track in-flight runPromise calls with a counter (or have the recipe wrap them), and on SIGTERM await a bounded drain (e.g. Promise.race([drain(), timeout(10s)])) followed by `await made.dispose()` before allowing exit. Ten lines in the README recipe would set the correct default for every app that copies it.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: runtime scheduling
- Full dossier: [`effect-runtime-scheduler-specialist`](../../.reports/effect-runtime-scheduler-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-002` — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder](medium/BO-002-balazs-orban.md) `_(balazs-orban, medium)_`
- [`IC-004` — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves](medium/IC-004-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-003` — README page recipe drops the force-dynamic guard that every spec recipe includes](medium/NSA-003-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`NSA-008` — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)](low/NSA-008-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-server-action-facade`. Evidence at HEAD ec065a7: `packages/next/README.md:38`. Fix: Fix the recipe (the decision keeps runtime pinning as README-only, so the fix is documentation). (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
