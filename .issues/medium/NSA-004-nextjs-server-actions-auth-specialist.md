---
ID: "NSA-004"
Title: "Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge"
Level: medium
Category: "correctness"
Status: resolved
Package: "server"
Source: "packages/server/src/Session.ts:86"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-004 — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge

`MEDIUM` · `correctness` · `server` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

The design spec for this package promises withNextCookies bridges 'a fresh session after sign-in, a cleared one after sign-out' (.scratch/next-package/spec.md:26-29), but the signOut handler only revokes server-side and emits no clearing Set-Cookie, so withNextCookies can never harvest one. In the Next recipe the dead __Host-session cookie then lingers in the browser until a later sign-in overwrites it; the next render correctly resolves undefined (secure), but proxy.ts's optimistic check keeps admitting the dead cookie into the app shell before the real boundary bounces it. The README ships a sign-in server action and no sign-out story at all.

## Evidence

Source: `packages/server/src/Session.ts:86`

```
        yield* sessions
          .revoke(Sessions.SessionId(principal.sessionId))
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
```

## Recommended fix

Have signOut's handler emit a securitySetCookie clearing __Host-session (Max-Age=0), and add a sign-out server action recipe to the README that calls withNextCookies plus revalidatePath.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `session-cookie-expiry`. Duplicate of `CSS-002` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:84`. Full dossier: `.plan/slices/06-server-api.md`. Status → resolved.
