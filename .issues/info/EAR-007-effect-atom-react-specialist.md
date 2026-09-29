---
ID: "EAR-007"
Title: "No integration joins packages/next's server session to Providers' initialSession prop"
Level: info
Category: "architecture"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:15"
Auditor: "effect-atom-react-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EAR-007 — No integration joins packages/next's server session to Providers' initialSession prop

`INFO` · `architecture` · `next` · reported by **Effect Atom/React Reactivity Specialist** (`effect-atom-react-specialist`)

Status: **resolved**

## Summary

The SSR story has two implemented halves that never meet: packages/next's GetSession resolves a database-verified session as a 3-field struct (principal/user/session), while Providers expects initialSession as a SessionContract.SessionDto — a different shape requiring caller-side mapping that no example demonstrates (grep finds zero references to @awthaq/react or Providers in packages/next or examples/). Every consumer must invent the server-to-prop wiring, the exact wiring where hydration mismatches (EAR-005) and per-request registry isolation mistakes are most likely, and the subject half (SubjectResolver against the principal) is likewise left as an exercise.

## Evidence

Source: `packages/next/src/GetSession.ts:15`

```
// Returns a 3-field struct, not `spec/overview.md`'s aspirational 4-field
```

## Recommended fix

Ship a reference composition (a Next.js example app or a documented helper in packages/next) that maps GetSession's result to SessionDto for initialSession and resolves the SubjectDto for initialSubject, including the per-request seeding and router.refresh() re-seed caveats from EAR-001.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Atom/React reactivity
- Full dossier: [`effect-atom-react-specialist`](../../.reports/effect-atom-react-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `next-react-ssr-bridge`. Duplicate of `RSC-005` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/next/src/GetSession.ts:13`. Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `RSC-005-react-server-components-auth-specialist` — closed by its fix (see that issue's Resolved comment).
