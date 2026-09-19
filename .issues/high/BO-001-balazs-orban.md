---
ID: "BO-001"
Title: "getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:83"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-001 — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path

`HIGH` · `correctness` · `next` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

Sessions.verify rotates the session secret on the throttled touch and overwrites the old hash in the same atomic write — per Sessions.ts:159-161 it 'stops verifying immediately — no grace window'. getSession is exactly that throttled caller: when an RSC render's verify wins the touch window (at most once per touchEvery, 1h default), the freshly rotated token is discarded because an RSC cannot set cookies, yet the browser's old cookie is now permanently invalid. The user's next request fails SessionNotFound, getSession returns undefined, and the app redirects to sign-in: a forced re-login roughly once per hour of activity, invisible to the adapter and untested (GetSession.test.ts has no rotation case). This is the exact 'breaking session credential without logging users out' class of bug a session vendor must never ship.

## Evidence

Source: `packages/next/src/GetSession.ts:83`

```
const { session } = yield* sessions.verify(Redacted.make(token));
    const user = yield* users.findById(session.userId);
    const principal = yield* resolver.resolve(session);
```

## Recommended fix

Give verify a rotation opt-out (or return the rotated token and let the adapter act): on the adapter path either skip rotation entirely, or fail with a typed RotatedUndeliverable condition the app maps to a redirect through a middleware-delivered endpoint that sets the new cookie. Add a regression test where verify actually rotates during a getSession call.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/core/src/Sessions.ts:159-161`'s own comment states the rotated secret "stops verifying immediately — no grace window," and `packages/next/src/GetSession.ts:76-82` has an inline comment acknowledging `rotated` "is intentionally discarded here" since an RSC "cannot set cookies at all." `packages/next/test/GetSession.test.ts` has no rotation test case (only absent/malformed/nonexistent/expired-cookie cases). The upstream-hardening ticket 03 memoization (referenced in Sessions.ts) fixes a different problem (double-verify within one request), not this one. The fix requires choosing a rotation-delivery strategy (opt-out vs. typed error vs. middleware-delivered endpoint) — a real architecture decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Next.js RSC session rotation delivery + per-request memoization](../../.scratch/resolve-ready-for-human-findings/issues/16-nextjs-rsc-session-rotation-delivery.md) — Resolved via exposing `verify`'s `rotated` token on `getSession`'s `Session` result plus a new `applyRotatedSession` helper (reusing `WithNextCookies.ts`'s `CookieJarLike`) for Server Actions/Route Handlers to deliver it; pure Server Component renders remain a documented, honest platform limitation, not silently worked around. Status → ready-for-agent.

**Resolved (2026-09-19):** Implemented the design recorded in [Next.js RSC session rotation delivery + per-request memoization](../../.scratch/resolve-ready-for-human-findings/issues/16-nextjs-rsc-session-rotation-delivery.md): `Session` (the `getSession` return type) gains `rotated: Redacted.Redacted<string> | undefined`, populated from `verify`'s own `rotated` Option (previously discarded); a new `applyRotatedSession(session, jar)` export (reusing `WithNextCookies.ts`'s `CookieJarLike`/`Sessions.SESSION_COOKIE_ATTRIBUTES`) writes it for a Server Action/Route Handler's mutable cookie jar. `getSession`'s internal `resolve` is now wrapped in `React.cache()` (new `react` peer+dev dependency, mirroring `@awthaq/react`'s own pattern), closing NSA-002's per-request memoization gap the same way ticket 03's `Authentication.ts` cache closed it for the HTTP path. A pure Server-Component-only render remains a documented, honest platform limitation (README addition) — Next.js RSCs cannot set cookies under any circumstances — not silently worked around. Two new regression tests in `packages/next/test/GetSession.test.ts` (a real throttled-touch rotation via a short-`touchEvery` `SessionConfig` override, and `applyRotatedSession`'s jar-write/no-op behavior) — verified to genuinely fail with the `rotated` field reverted to always-`undefined`. Full monorepo typecheck and test suite (623 tests) pass. Note: `React.cache()`'s actual per-render memoization is empirically un-testable in this repo's plain Vitest environment (confirmed via a standalone Node script: `cache()` does not memoize outside an active React render/cache scope, so it correctly reduces to today's always-verify-fresh behavior there) — its correctness rests on React's own documented API contract, the same category of "structural fix, real behavior only observable under a real host runtime" as this session's `SqlTransaction` wraps.
