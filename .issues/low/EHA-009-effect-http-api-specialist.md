---
ID: "EHA-009"
Title: "Session 'current' handler defects to a 500 on a concurrent-revoke race"
Level: low
Category: "correctness"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Session.ts:67"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-009 — Session 'current' handler defects to a 500 on a concurrent-revoke race

`LOW` · `correctness` · `server` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **ready-for-agent**

## Summary

The current endpoint finds the caller's own row via items.find((row) => row.current) after the Authentication middleware has already verified the live session, but the revocation can land in another tab between verification and sessions.list — the window is the signOut/revoke/revoke-others handlers in this very group. In that case the handler Effect.die's, surfacing as an unhandled 500 for a request whose truthful answer is 'your session was just revoked' (the same race the signOut handler explicitly handles by swallowing SessionNotFound, and the same one EHA-002's broken catchTag at :108 was meant to cover for revoke). A caller polling session state gets an opaque server error for a fully expected lifecycle event.

## Evidence

Source: `packages/server/src/Session.ts:67`

```
return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
```

## Recommended fix

Treat a missing current row as the contract's Unauthenticated (or a typed SessionNotFound) instead of a defect: fail with a declared error so the client's session atom clears and the user is routed to sign-in rather than shown a 500.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-handler-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:60`. Fix: Answer a concurrently-revoked current session with a typed 401 and an expired cookie, not a 500 defect. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
