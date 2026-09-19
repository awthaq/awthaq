---
ID: "NSA-001"
Title: "getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:83"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-001 — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window

`HIGH` · `correctness` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

Sessions.verify rotates the secret on the throttled touch write and the old secret 'stops verifying immediately - no grace window' (packages/core/src/Sessions.ts:160-161). The HTTP path delivers the rotated token via deliverRotation (packages/server/src/Authentication.ts:207-227), but getSession discards `rotated` with no alternative delivery. A Next app whose RSC navigation traffic is authenticated by getSession therefore hard-logs the user out on the first render after each touchEvery window (default 1 hour, packages/core/src/Sessions.ts:74): the browser still holds the old cookie, the next getSession fails SessionNotFound, and the page redirects to sign-in. The comment documents the discard but not this consequence.

## Evidence

Source: `packages/next/src/GetSession.ts:83`

```
// Upstream-hardening ticket 01: `verify` may rotate the session's
    // secret, but a Server Component/server action has no response to
    // deliver a rotated cookie through
```

## Recommended fix

Deliver rotation in Next contexts: give getSession an optional CookieJarLike out-param (the same structural seam withNextCookies already uses) so a server action can write the rotated token, and/or rotate only when a delivery channel exists; at minimum document the forced-logout behavior prominently in the README recipe.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/next/src/GetSession.ts:77-83` destructures only `{ session }` from `sessions.verify(...)` and discards `rotated`, exactly as the comment there admits; `packages/core/src/Sessions.ts:160-166` confirms the old secret's hash is overwritten in the same atomic write with no grace window; `packages/server/src/Authentication.ts:207-224`'s `deliverRotation` shows the HTTP path has a real delivery channel (Set-Cookie/`set-auth-token`) that the Next path lacks. `packages/next/src/WithNextCookies.ts` already exports a `CookieJarLike` structural seam used elsewhere in this same package for writing cookies from a server action, so wiring an optional out-param through that existing pattern is a well-scoped, mechanical change confined to `packages/next`. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `BO-001` (shared root cause, same decision ticket) — see that finding's comment.
