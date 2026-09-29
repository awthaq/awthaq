---
ID: "NSA-003"
Title: "README page recipe drops the force-dynamic guard that every spec recipe includes"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "next"
Source: "packages/next/README.md:79"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-003 — README page recipe drops the force-dynamic guard that every spec recipe includes

`MEDIUM` · `security` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **ready-for-agent**

## Summary

Every worked recipe in the repo's own material guards the session page with `export const dynamic = "force-dynamic"` (archive/design/usage-examples-v4.md:675, archive/design/usage-qadi.md:491, spec/appendices/03-nextjs-ssr-decision-hydration.md:49), but the shipped README recipe omits it. The recipe currently stays dynamic only through the implicit side effect of calling headers(); that is undocumented and fragile under rendering-mode changes (PPR/shell caching in Next 15+), and a statically cached page shell that renders session-derived content would leak one user's data to another - the exact pitfall this persona screens for.

## Evidence

Source: `packages/next/README.md:79`

```
export default async function Page() {
  const session = await getSession(await headers(), runtime);
  if (session === undefined) redirect("/sign-in");
```

## Recommended fix

Add `export const dynamic = "force-dynamic"` (or an explicit caching section explaining when a route becomes dynamic and why PPR needs care) to the README's page recipe, matching the repo's own spec appendix.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-002` — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder](medium/BO-002-balazs-orban.md) `_(balazs-orban, medium)_`
- [`ERS-006` — Next README dispose recipe drops the dispose promise and never drains in-flight work](low/ERS-006-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`IC-004` — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves](medium/IC-004-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-008` — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)](low/NSA-008-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-server-action-facade`. Evidence at HEAD ec065a7: `packages/next/README.md:79`. Fix: Add the guard and a short caching note to the page recipe. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
