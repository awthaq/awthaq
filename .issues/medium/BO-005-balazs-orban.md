---
ID: "BO-005"
Title: "Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login"
Level: medium
Category: "dx"
Status: resolved
Package: "core"
Source: "packages/core/src/Sessions.ts:124"
Auditor: "balazs-orban"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BO-005 — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login

`MEDIUM` · `dx` · `core` · reported by **Balázs Orbán — Lead Maintainer, Auth.js** (`balazs-orban`)

Status: **resolved**

## Summary

SESSION_COOKIE_ATTRIBUTES fixes secure/httpOnly/sameSite/path but carries no maxAge or expires, so the __Host-session cookie is a browser-session cookie: it dies when the browser closes while the server-side session remains valid for 30 days absolute / 7 days idle (Sessions.ts:71-75). A returning user is forced through sign-in again even though the store still holds a perfectly valid session — a visible divergence from Auth.js's cookie maxAge-aligned defaults, and one that also leaves server-side 'active' sessions orphaned in the sessions list. The __Host- prefix and the fixed attribute set are otherwise sound; only the lifetime is misaligned.

## Evidence

Source: `packages/core/src/Sessions.ts:124`

```
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
```

## Recommended fix

Set the cookie's Max-Age from the session's absolute TTL at issuance (or expose it as a SessionConfig knob), keeping the __Host- prefix and the rest of the fixed attribute set; document the tradeoff in BEH-EA-055.

## Context

- Auditor verdict on this domain: **needs-work** (score 61/100), domain: Framework adapters
- Full dossier: [`balazs-orban`](../../.reports/balazs-orban/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- [`EOTS-004` — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs](medium/EOTS-004-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-cookie-policy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:151`. Fix: Give the session cookie a Max-Age derived from the session's absoluteExpiresAt (recomputed at every rotation), via IC-007's cookie helper, with a 'browserSession' opt-out. (effort S). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-human.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option B per plan (default persistence 'absolute'); user may revisit. Session cookies now carry Max-Age = remaining absolute lifetime (SessionCookie.renderAt, never negative), at issuance and recomputed at every rotation (server rotationDelivery passes the refreshed SessionView; Next applyRotatedSession uses session.absoluteExpiresAt); persistence 'browserSession' opts out. Tests: core SessionCookie.test.ts (Max-Age from absoluteExpiresAt, shrinks, browserSession omits), server Authentication.test.ts ('rotated cookie Max-Age = 30d - 2h'), password AuthHttp.test.ts (sign-up Set-Cookie ~30d Max-Age). Spec BEH-EA-055.
