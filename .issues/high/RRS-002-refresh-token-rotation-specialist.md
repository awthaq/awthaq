---
ID: "RRS-002"
Title: "Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out"
Level: high
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/GetSession.ts:83"
Auditor: "refresh-token-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# RRS-002 — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out

`HIGH` · `correctness` · `next` · reported by **Refresh Token Rotation Specialist** (`refresh-token-rotation-specialist`)

Status: **resolved**

## Summary

GetSession's resolve calls sessions.verify(token) (line 83) in a context that by its own comment cannot deliver a rotated cookie. When an RSC render lands past the touchEvery boundary, verify rotates the stored secretHash server-side and returns a new token that is thrown away; the browser's cookie still holds the old secret, which stopped verifying the instant the rotation write committed (no grace window, Sessions.ts:161). The user's very next request fails SessionNotFound and they are hard-logged out — a self-inflicted false-positive revocation that recurs once per touchEvery per session, triggered by ordinary navigation in any Next app that renders Server Components. A server action could set the cookie; an RSC render cannot, and this path serves both.

## Evidence

Source: `packages/next/src/GetSession.ts:83`

```
// secret, but a Server Component/server action has no response to
    // deliver a rotated cookie through (Next.js RSCs cannot set cookies at
    // all) — `rotated` is intentionally discarded here; a real HTTP
```

## Recommended fix

Never rotate in an undeliverable context: give Sessions a read-only verify variant (or a deliverRotation flag) and use it from the RSC path so the throttled touch/rotation is skipped there, or accept the previous secretHash for a short grace window after any rotation.

## Context

- Auditor verdict on this domain: **needs-work** (score 54/100), domain: Refresh & Token Rotation
- Full dossier: [`refresh-token-rotation-specialist`](../../.reports/refresh-token-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-001` — getSession consumes secret rotation with no delivery channel — periodic silent logout on the RSC path](high/BO-001-balazs-orban.md) `_(balazs-orban, high)_`
- [`EAR-007` — No integration joins packages/next's server session to Providers' initialSession prop](info/EAR-007-effect-atom-react-specialist.md) `_(effect-atom-react-specialist, info)_`
- [`IC-001` — getSession discards rotated session tokens, signing active users out roughly hourly in RSC-only apps](high/IC-001-iain-collins.md) `_(iain-collins, high)_`
- [`NSA-001` — getSession discards rotated session tokens while verify invalidates the old secret immediately - forced logout once per touch window](high/NSA-001-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`NSA-002` — No per-request memoization: two getSession calls in one render re-run verify and can lose the rotation race mid-render](high/NSA-002-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, high)_`
- [`RSC-003` — Idle-refresh session rotation is silently dropped on the RSC/server-action path, hard-logging users out](high/RSC-003-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, high)_`
- [`RSC-005` — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves](medium/RSC-005-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, medium)_`
- [`RSC-007` — getSession resolves three services strictly sequentially in the RSC hot path](low/RSC-007-react-server-components-auth-specialist.md) `_(react-server-components-auth-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/next/src/GetSession.ts:77-83` matches the evidence (the "rotated is intentionally discarded here" comment), and `.scratch/upstream-hardening/issues/01-session-token-rotation.md` confirms the team deliberately chose immediate invalidation with no grace window, delivering rotation only via `Set-Cookie`/`set-auth-token` on real HTTP responses — a path the RSC render cannot use. `sessions.verify`'s rotation therefore is genuinely undeliverable here, matching the claimed hard-logout. The recommended fix (a read-only verify variant skipping rotation on this path) is concretely scoped and follows the already-decided no-grace-window policy rather than reopening it. Status → ready-for-agent.

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `next-getsession-hardening`. Evidence at HEAD ec065a7: `packages/next/src/GetSession.ts:90`. Fix: Finish the ticket-16 design: export `applyRotatedSession`, fix the README snippet, and test through the public entry. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`.

**Resolved (2026-09-29):** packages/next/src/index.ts now exports applyRotatedSession (test imports go through ../src/index.ts; red = TS2305 before the export); README snippet imports headers. Pure-RSC rotation limit unchanged (ticket 16). Gates: typecheck, next tests under --sequence.shuffle, full suite.
