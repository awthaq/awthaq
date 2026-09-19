---
ID: "NSA-002"
Title: "No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:112"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-002 — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render

`HIGH` · `correctness` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

Calling getSession from both a layout and its page - the normal Next guard pattern - runs Sessions.verify twice against the same cookie value. When the throttled touch is due, the first call wins the compare-and-swap and overwrites the stored secretHash; the second call presents the now-stale secret and fails SessionNotFound (packages/core/src/Sessions.ts:288-297), yielding undefined mid-render and a spurious redirect. This is exactly the architectural risk ticket 03 eliminated on the HTTP path via resolveSession's per-request memoization keyed on HttpServerRequest (packages/server/src/Authentication.ts:176-182) - a mechanism the Next path cannot use since it calls sessions.verify directly with no ambient request identity.

## Evidence

Source: `packages/next/src/GetSession.ts:112`

```
  const token = cookieValue(headers.get("cookie"), Api.SessionCookie.key);
  return token === undefined ? Promise.resolve(undefined) : runtime.runPromise(resolve(token));
```

## Recommended fix

Memoize per Next request (e.g. cache the resolved Session on a React cache()/AsyncLocalStorage key that both layout and page share), or route getSession through Authentication.resolveSession with an injectable per-request identity; add a regression test with TestClock advanced past touchEvery issuing two getSession calls.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/next/src/GetSession.ts` has no caching/memoization mechanism at all (no `React.cache()`, no `AsyncLocalStorage`, no module-level `WeakMap`); `getSession` (lines 106-115) calls `runtime.runPromise(resolve(token))` directly on every invocation, and `resolve` (lines 72-98) calls `sessions.verify` with no request-scoped reuse, unlike `packages/server/src/Authentication.ts:123-179`'s `WeakMap<HttpServerRequest, ...>` memoization on the HTTP path. `packages/core/src/Sessions.ts`'s throttled-touch compare-and-swap (~line 320) overwrites `secretHash` on the winning call, and the losing call's presented secret then fails the constant-time hash comparison (~Sessions.ts:287-294) and returns `SessionNotFound` — confirming the described race. The fix requires choosing a per-request memoization strategy (React `cache()` vs `AsyncLocalStorage` vs routing through `resolveSession` with an injectable per-request identity), each with different dependency/runtime-compatibility (Edge vs Node) trade-offs — a design decision, not a mechanical patch. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Next.js RSC session rotation delivery + per-request memoization](../../.scratch/resolve-ready-for-human-findings/issues/16-nextjs-rsc-session-rotation-delivery.md) — Confirmed NOT fixed by `d2b6f85` (that commit only memoized `packages/server/src/Authentication.ts`'s HTTP path, keyed on `HttpServerRequest` identity, which `GetSession.ts` never has). Resolved via wrapping `GetSession.ts`'s `resolve` in React's `cache()`, giving the Next path true per-request memoization for the first time. Status → ready-for-agent.

**Resolved (2026-09-19):** Closed by the same change's `React.cache()` half — see `BO-001`'s own comment.
