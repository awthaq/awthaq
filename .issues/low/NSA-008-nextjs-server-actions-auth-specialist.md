---
ID: "NSA-008"
Title: "Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "next"
Source: "packages/next/README.md:100"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-008 — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)

`LOW` · `dx` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **ready-for-agent**

## Summary

The recipe's internal dispatch forwards nothing from the real action request: no Cookie header, no Origin/Sec-Fetch-Site, no client IP or user-agent. Today that works only because no plugin group wires Api.CsrfProtection yet (packages/client/src/AuthClient.ts:28-31) - the moment a CSRF-wired contract is composed (it is declared requiredForClient: true, packages/api/src/Api.ts:143), this exact recipe starts failing CsrfRejected since a POST with no csrf cookie/header cannot pass the double-submit check. Sessions.issue's request metadata (ip, userAgent, packages/core/src/Sessions.ts:139) is also silently lost, so session lists show nothing.

## Evidence

Source: `packages/next/README.md:100`

```
  const request = new Request("http://internal/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json" },
```

## Recommended fix

Show forwarding the action's cookie/origin headers (and Headers.get for ip/user-agent) into the synthetic Request, and note explicitly that CSRF-wired groups need the csrf cookie/header echoed for in-process dispatch.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-002` — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder](medium/BO-002-balazs-orban.md) `_(balazs-orban, medium)_`
- [`ERS-006` — Next README dispose recipe drops the dispose promise and never drains in-flight work](low/ERS-006-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, low)_`
- [`IC-004` — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves](medium/IC-004-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-003` — README page recipe drops the force-dynamic guard that every spec recipe includes](medium/NSA-003-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `next-server-action-facade`. Evidence at HEAD ec065a7: `packages/next/README.md:100`. Fix: Forward the action's context in the dispatch path (implemented inside BO-002's in-process client) and fix the README until that lands. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
