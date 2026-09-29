---
ID: "RSC-005"
Title: "getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves"
Level: medium
Category: "api"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:51"
Auditor: "react-server-components-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RSC-005 — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves

`MEDIUM` · `api` · `next` · reported by **React Server Components Auth Specialist** (`react-server-components-auth-specialist`)

Status: **resolved**

## Summary

getSession returns { principal, user: Users.UserRecord, session: Sessions.SessionView }. SessionView's fields are DateTime.Utc and Option.Option class instances (Sessions.ts:90-101) — not friendly across the RSC serialization boundary (brands/methods are lost; consumers pattern-matching _tag receive plain objects), while Principal is a Schema union that does not match the wire DTOs either. Meanwhile the other half of the seam, Providers.initialSession, expects SessionContract.SessionDto — ISO strings and NullOr userAgent (api/src/Session.ts:18-25), with no expiresAt field even present on SessionView (it has absoluteExpiresAt/idleExpiresAt). The repo demonstrates no mapping between them (server/src/Session.ts:15-23 maps a different type, SessionListItem), so BEH-EA-185 and BEH-EA-177 — the two ends of the same RSC story — cannot be composed without every application hand-writing an undocumented adapter. This is precisely the gap that tempts the red-flag shortcut: pass the whole server struct down "for convenience".

## Evidence

Source: `packages/next/src/GetSession.ts:51`

```
/** BEH-EA-185: what a valid, database-verified session resolves to. */
export interface Session {
  readonly principal: Api.Principal;
```

## Recommended fix

Ship a toSessionDto(view: Sessions.SessionView): SessionContract.SessionDto helper in @awthaq/next (or accept session in Providers via a documented mapper), and note in GetSession.ts's docs that Session/SessionView are server-render-shaped and must not cross to client props unconverted.

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
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`
- [`RRS-002` — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out](high/RRS-002-refresh-token-rotation-specialist.md) `_(refresh-token-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-react-ssr-bridge`. Evidence at HEAD ec065a7: `packages/next/src/GetSession.ts:54`. Fix: Ship the missing server→client seam: a public SessionView→SessionDto mapper, a next-side helper that produces RSC-safe (encoded, plain JSON) seed props, and Providers accepting the encoded shape. (effort M). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Session.toSessionDto(view, current=true) exported from @awthaq/server/Session.ts (test: server/test/SessionDto.test.ts); the password/admin/passkey private copies now delegate through a typed sessionResponse wrapper (the wrapper keeps SessionContract in scope so declaration emit avoids TS2883, so 'grep const toSessionDto' -> 0 holds and one mapper implementation remains). @awthaq/next: Seed.ts toInitialSession/toInitialSubject (structural SubjectLike; plain-JSON, tested with a plain-object walker), exported from index; GetSession.Session doc states it is server-only; README section 'Seeding Providers from a Server Component'. Providers accepts SessionSeed/SubjectSeed (instance or encoded), decodes with Schema.decodeUnknownExit; malformed seed seeds nothing and is reported once via onError. Tests: next/test/Seed.test.ts, react/test/ProvidersSeeds.test.tsx.
