---
ID: "NAM-012"
Title: "Next.js middleware parity is deliberately weaker — hasSessionCookie verifies nothing"
Level: low
Category: "security"
Status: resolved
Package: "next"
Source: "packages/next/src/HasSessionCookie.ts:17"
Auditor: "nextauth-authjs-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NAM-012 — Next.js middleware parity is deliberately weaker — hasSessionCookie verifies nothing

`LOW` · `security` · `next` · reported by **NextAuth.js/Auth.js Migration Specialist** (`nextauth-authjs-migration-specialist`)

Status: **resolved**

## Summary

The ubiquitous next-auth pattern `export { auth as middleware }` runs real session verification in middleware; the effect-auth equivalent, hasSessionCookie, is presence-only by explicit design (the header even cites CVE-2025-29927 as why middleware must not be the boundary). The design is right — but a migrating app that maps auth-middleware → hasSessionCookie one-for-one downgrades every route from verified to unverified gating, and nothing outside the source header warns about it. The correct migration shape (proxy.ts redirects on presence; every page/server action calls getSession, which is a real Sessions.verify) is a structural change to the app's route layout, not an import swap.

## Evidence

Source: `packages/next/src/HasSessionCookie.ts:17`

```
renders; the real boundary is `GetSession.ts`'s `getSession`, which every
page and server action reached past `proxy.ts` must still call itself.
Treating a passing `hasSessionCookie` check as authentication is exactly
```

## Recommended fix

Add the proxy.ts + getSession migration pattern (with the middleware-is-not-a-boundary rationale) to a migration guide, and consider an ESLint-style rule or doc snippet flagging hasSessionCookie used as the sole guard outside proxy.ts.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: Auth.js Migration Parity
- Full dossier: [`nextauth-authjs-migration-specialist`](../../.reports/nextauth-authjs-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 27 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-006` — No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired](medium/BO-006-balazs-orban.md) `_(balazs-orban, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `frontend-docs-truthfulness`. Evidence at HEAD ec065a7: `packages/next/src/HasSessionCookie.ts:17`. Fix: Add an Auth.js/next-auth migration note to the next README. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** packages/next/README.md 'Migrating from Auth.js / next-auth' section: table of equivalents, explicit warning that export { auth as middleware } does NOT map to hasSessionCookie (presence only, verifies nothing) and that every page/action/route handler must call getSession.
