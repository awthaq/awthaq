---
ID: "RSC-007"
Title: "getSession resolves three services strictly sequentially in the RSC hot path"
Level: low
Category: "performance"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:83"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-007 — getSession resolves three services strictly sequentially in the RSC hot path

`LOW` · `performance` · `next` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

The resolve pipeline runs verify -> findById -> resolver.resolve with three sequential awaits. users.findById(session.userId) and resolver.resolve(session) both depend only on the verified session and are independent of each other, so they could run concurrently (Effect.all), cutting one full store round trip from every Server Component render and every server-action invocation — the hottest authenticated path in a Next.js deployment. For SQL backends this is a real per-request latency tax (two sequential queries where one parallel batch would do); for the memory layer it is negligible but the shape still models the wrong concurrency contract for implementors.

## Evidence

Source: `packages/next/src/GetSession.ts:83`

```
const { session } = yield* sessions.verify(Redacted.make(token));
    const user = yield* users.findById(session.userId);
    const principal = yield* resolver.resolve(session);
```

## Recommended fix

Run user and principal fetches with Effect.all after verify: const [user, principal] = yield* Effect.all([users.findById(session.userId), resolver.resolve(session)], { concurrency: 2 }).

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: RSC auth boundary
- Full dossier: [`react-server-components-auth-specialist`](../../.reports/react-server-components-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-getsession-hardening`. Evidence at HEAD ec065a7: `packages/next/src/GetSession.ts:90`. Fix: Run the two post-verify lookups concurrently. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** GetSession.resolve runs users.findById and resolver.resolve under Effect.all({concurrency:'unbounded'}); new GetSession test gates findById on the resolver (red = 'deadlock' with concurrency 1, green concurrent). Gates: typecheck, tests, oxlint.
