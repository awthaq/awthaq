---
ID: "CSS-002"
Title: "No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "server"
Source: "packages/server/src/Session.ts:84"
Auditor: "cookie-security-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSS-002 — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar

`MEDIUM` · `security` · `server` · reported by **Cookie Security Specialist** (`cookie-security-specialist`)

Status: **ready-for-agent**

## Summary

signOut revokes server-side and returns void with no Set-Cookie; deleteUser (packages/server/src/Account.ts:73-85) revokes every session and likewise writes no cookie; a repo-wide search finds zero maxAge-0/clearing sites across all five cookie-writing endpoints. After sign-out the browser keeps replaying the dead __Host-session on every subsequent request, each costing a wasted session.verify plus a 401, and on shared machines the 256-bit token value sits in the jar until absolute expiry. Session revocation is correct server-side (fails closed), so this is cookie hygiene and request noise rather than an open door — but 'sign out' that visibly leaves the auth cookie in place is a real shared-machine weakness and a poor observable contract.

## Evidence

Source: `packages/server/src/Session.ts:84`

```
signOut: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        yield* sessions
          .revoke(Sessions.SessionId(principal.sessionId))
```

## Recommended fix

On signOut, revoke-all, and deleteUser, call HttpApiBuilder.securitySetCookie(Api.SessionCookie, "", { ...Sessions.SESSION_COOKIE_ATTRIBUTES, maxAge: 0 }) so the response expires the cookie, and add a wire test asserting the Set-Cookie on POST /session/sign-out.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 58/100), domain: Cookie & Set-Cookie security
- Full dossier: [`cookie-security-specialist`](../../.reports/cookie-security-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-cookie-expiry`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:84`. Fix: Expire __Host-session on every response that ends the caller's own session: signOut, revokeAll, revoke when the target is the current session, deleteUser, and the EHA-009 'current row missing' path. (effort M). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.
