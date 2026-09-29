---
ID: "IC-002"
Title: "signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere"
Level: medium
Category: "dx"
Status: resolved
Package: "server"
Source: "packages/server/src/Session.ts:84"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-002 — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere

`MEDIUM` · `dx` · `server` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **resolved**

## Summary

The core signOut handler revokes the row in the store but writes no Set-Cookie, and a codebase-wide search finds no cookie-clearing site at all (no maxAge=0 / Max-Age=0 anywhere under packages/). The dead __Host-session cookie keeps riding every subsequent request, costing a failed database verification per request until the browser session ends. Auth.js clears the session cookie in its signOut handler, and the Next adapter's own design doc claims withNextCookies bridges 'a cleared one after sign-out' (.scratch/next-package/spec.md:26-27, 50-52) — a claim the server code makes structurally impossible, since sign-out through a bridged server action produces no Set-Cookie to bridge.

## Evidence

Source: `packages/server/src/Session.ts:84`

```
      signOut: Effect.fnUntraced(function* () {
        const principal = yield* currentUserPrincipal;
        yield* sessions
          .revoke(Sessions.SessionId(principal.sessionId))
```

## Recommended fix

Have the signOut handler append a clearing Set-Cookie (Sessions.SESSION_COOKIE_NAME with maxAge 0 and the same attributes), and add a withNextCookies test asserting a sign-out through the composed router empties the Next cookie jar entry.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-cookie-expiry`. Duplicate of `CSS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:84`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
