---
ID: "GC-005"
Title: "Sessions.revoke shape forces a check-then-act composition in the shell"
Level: medium
Category: "api"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Session.ts:102"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-005 — Sessions.revoke shape forces a check-then-act composition in the shell

`MEDIUM` · `api` · `server` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **ready-for-agent**

## Summary

`SessionsShape.revoke(id)` takes no owner, so the ownership invariant ('a caller may only revoke their own session') cannot be enforced inside the domain operation; the handler must compose `list` (up to LIST_PAGE_SIZE rows) with `revoke` as two separate effects, making the invariant an emergent property of the imperative shell rather than a law of the algebra. The enumeration-safety intent (BEH-EA-086) survives only because the shell carefully maps both paths to the same SessionNotFound — a discipline the domain could guarantee by construction with an owning revoke. This is the io-ts lesson applied to service shapes: put the invariant in the type/operation, not in the caller's discipline.

## Evidence

Source: `packages/server/src/Session.ts:102`

```
        const owned = yield* sessions.list(userId);
        if (!owned.some((row) => row.id === targetId)) {
```

## Recommended fix

Add an owning variant to SessionsShape (e.g. `revokeOwned(userId, id)` failing `SessionNotFound` for both unknown and foreign ids) and make the HTTP handler a single call; keep bare `revoke` for admin contexts that already hold authorization.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-handler-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:99`. Fix: Add an owning revoke to the Sessions algebra, so ownership and enumeration-safety are enforced in the domain operation. This also fixes the 200-row list cap that wrongly 404s owned sessions. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
