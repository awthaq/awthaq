---
ID: "RSC-003"
Title: "Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:77"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-003 — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out

`HIGH` · `correctness` · `next` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

sessions.verify rotates the secret whenever the touchEvery throttle is due (memory layer: packages/core/src/Sessions.ts:317-350; the new secretHash replaces the old at line 329), and the old token then fails verify with SessionNotFound (Sessions.ts:293-296). getSession discards the rotated token unconditionally. For a Server Component that is defensible (RSCs cannot write cookies), but the same function is documented for server actions — where cookies() IS writable and withNextCookies exists precisely to bridge Set-Cookie. So in a Next.js app, the first request past the idle-refresh throttle rotates the secret server-side, the browser keeps the now-dead cookie, and the user's next navigation is a forced sign-out. A security mechanism (rotation) degrades into a correctness bug (random logouts) exactly on the framework path this package exists to serve.

## Evidence

Source: `packages/next/src/GetSession.ts:77`

```
// Upstream-hardening ticket 01: `verify` may rotate the session's
    // secret, but a Server Component/server action has no response to
    // deliver a rotated cookie through (Next.js RSCs cannot set cookies at
```

## Recommended fix

Expose the rotation result (e.g. a getSession variant returning { session, rotated }) or accept an optional CookieJarLike parameter, and document the server-action recipe: bridge rotated through withNextCookies; in pure RSCs, prefer a read-only verify that skips rotation.

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
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — GetSession.ts:77-83's comment and code match verbatim: `verify`'s rotated result is discarded unconditionally, and `withNextCookies` (packages/next/src/WithNextCookies.ts:110) exists but is never wired into `getSession`'s server-action path, so a rotated cookie is unrecoverable there. The recommended fix (expose `{session, rotated}` or accept a `CookieJarLike`) is well-scoped. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `BO-001` (shared root cause, same decision ticket) — see that finding's comment.
