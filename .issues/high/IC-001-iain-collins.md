---
ID: "IC-001"
Title: "getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:77"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-001 — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps

`HIGH` · `correctness` · `next` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

Sessions.verify rotates the session secret on the throttled idle touch (at most once per touchEvery, default 1h — packages/core/src/Sessions.ts:303-317 memory, 507-521 SQL) and the old secret stops verifying immediately with no grace window (Sessions.ts:159-161). getSession calls the same verify and then intentionally discards the rotated token, reasoning that 'a real HTTP request through @awthaq/server's Authentication middleware is what actually delivers rotation to the browser'. In a Next.js app whose protected pages and actions verify via getSession — the adapter's own documented primary path (packages/next/README.md:71-87) — the Effect HTTP middleware never runs, so the rotated token is never delivered: the browser keeps a now-dead cookie, the next render fails verification with SessionNotFound, and getSession returns undefined, i.e. the user is forcibly signed out roughly once per hour of active use. No test in packages/next/test covers rotation (grep for 'rotated' finds nothing), so the logout loop is unobserved.

## Evidence

Source: `packages/next/src/GetSession.ts:77`

```
// Upstream-hardening ticket 01: `verify` may rotate the session's
    // secret, but a Server Component/server action has no response to
    // deliver a rotated cookie through (Next.js RSCs cannot set cookies at
```

## Recommended fix

Deliver rotation through the adapter: include the rotated token in the returned Session struct (or accept an optional onRotate callback / cookie jar), so a server action can bridge it via a synthetic Set-Cookie through withNextCookies; for pure-RSC renders, either add a verify option that skips rotation for contexts with no delivery channel, or document a mandated pattern. Add a test: after a throttled touch via getSession, a subsequent getSession with the original cookie still resolves.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/next/src/GetSession.ts:76-84` destructures only `{ session }` from `sessions.verify(...)`, discarding `rotated`, with the quoted comment present verbatim; `packages/core/src/Sessions.ts:150-182,303-350` confirms rotation is throttled to once per `touchEvery` (default 1h) with no grace window for the old secret. `packages/next/README.md:71-87` confirms `getSession` is documented as "the real boundary" primary path, and no test under `packages/next/test` references "rotated". The fix requires deciding the adapter's public delivery mechanism (struct field vs. callback vs. cookie-jar vs. a skip-rotation mode) — a genuine API design choice, not a pure mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Next.js RSC session rotation delivery + per-request memoization](../../.scratch/resolve-ready-for-human-findings/issues/16-nextjs-rsc-session-rotation-delivery.md) — Resolved via the same `rotated`/`applyRotatedSession` delivery mechanism described in the ticket — Server Actions/Route Handlers now have a real channel to deliver a rotated cookie; pure RSC rendering stays a documented platform limitation. Status → ready-for-agent.

**Resolved (2026-09-19):** Same fix as `BO-001` (shared root cause, same decision ticket) — see that finding's comment.
