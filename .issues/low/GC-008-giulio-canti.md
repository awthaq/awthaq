---
ID: "GC-008"
Title: "Untagged plain Error defect in the session handler breaks the catchable-error convention"
Level: low
Category: "dx"
Status: resolved
Package: "server"
Source: "packages/server/src/Session.ts:67"
Auditor: "giulio-canti"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# GC-008 — Untagged plain Error defect in the session handler breaks the catchable-error convention

`LOW` · `dx` · `server` · reported by **Giulio Canti — Creator of fp-ts and io-ts** (`giulio-canti`)

Status: **resolved**

## Summary

Auth.ts:26-28 establishes the convention 'Errors — catchable by class instead of by string-matching a plain Error', and every domain module follows it with Data.TaggedError; this handler's wiring-defect die is the one plain `new Error(...)` in the request path, so tests or middleware that want to recognize this specific impossible state can only string-match. Cheap to fix and it keeps the defect channel as typed as the error channel.

## Evidence

Source: `packages/server/src/Session.ts:67`

```
          return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
```

## Recommended fix

Declare a small Data.TaggedError (e.g. SessionListInvariant) in server or core and die with it.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: functional design
- Full dossier: [`giulio-canti`](../../.reports/giulio-canti/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-002` — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel](high/EHA-002-effect-http-api-specialist.md) `_(effect-http-api-specialist, high)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `session-handler-hardening`. Evidence at HEAD ec065a7: `packages/server/src/Session.ts:60`. Fix: Replace plain-Error defects in @awthaq/server with one tagged defect class. The repo-wide sweep is out of scope for this slice. (effort S). Full dossier: `.plan/slices/06-server-api.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/server/src/internal/Defects.ts HandlerInvariantViolation (Data.TaggedError, invariant NonUserPrincipal|AuthenticatedUserMissing); used by CurrentUser.ts and Account.ts (updateProfile, deleteUser); the Session.ts:67 site disappeared with EHA-009 (its only remaining die was replaced by the typed 401). packages/server/src contains no new Error( any more. The ~70 other die(new Error(...)) sites across packages are NOT swept here (follow-up for the orchestrator). Test: 'a non-User principal reaching a required-auth group dies with HandlerInvariantViolation'.
