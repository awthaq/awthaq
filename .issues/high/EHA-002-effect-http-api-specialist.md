---
ID: "EHA-002"
Title: "Five Effect.catchTag handlers return bare error objects, breaking the declared error channel"
Level: high
Category: "correctness"
Status: wontfix
Package: "server"
Source: "packages/server/src/Session.ts:108"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-002 — Five Effect.catchTag handlers return bare error objects, breaking the declared error channel

`HIGH` · `correctness` · `server` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **wontfix**

## Summary

Effect.catchTag's handler must return an Effect (effect@4.0.0-rc.116 Effect.ts:4594: f: (e) => Effect<A1, E1, R1>), but five sites return the constructed error directly, so the intended typed failure never enters the error channel: the endpoint would defect (HTTP 500) instead of answering the declared 404/429. Sites: packages/server/src/Session.ts:108 (revoke -> SessionNotFound 404, reachable on a concurrent revoke between the ownership check at :103 and the revoke at :107), packages/password/src/Password.ts:466 and packages/oauth/src/OAuth.ts:516 (port RateLimited -> Api.RateLimited 429, hit every time a limiter trips), and packages/oauth/src/OAuth.ts:638 and :691 (-> OAuthCallbackFailed / AccountExists). The correct bare-error idiom already exists in the repo as Effect.mapError (packages/server/src/Authentication.ts:175), and the same file's signOut handler uses the correct () => Effect.void — the inconsistency confirms these are mistakes, not a convention. Each site is also a type error against catchTag's declared signature.

## Evidence

Source: `packages/server/src/Session.ts:108`

```
.pipe(Effect.catchTag("SessionNotFound", () => new SessionContract.SessionNotFound()));
```

## Recommended fix

Replace each bare `new X(...)` with `Effect.fail(new X(...))` (or switch the pipe to Effect.mapError(() => new X(...)), which does take a bare error) at all five sites; the rate-limit mappings in Password.ts/OAuth.ts are the most urgent since throttling is an expected operational event.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CSS-002` — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar](medium/CSS-002-cookie-security-specialist.md) `_(cookie-security-specialist, medium)_`
- [`EHA-009` — Session 'current' handler defects to a 500 on a concurrent-revoke race](low/EHA-009-effect-http-api-specialist.md) `_(effect-http-api-specialist, low)_`
- [`GC-003` — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell](medium/GC-003-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-005` — Sessions.revoke shape forces a check-then-act composition in the shell](medium/GC-005-giulio-canti.md) `_(giulio-canti, medium)_`
- [`GC-008` — Untagged plain Error defect in the session handler breaks the catchable-error convention](low/GC-008-giulio-canti.md) `_(giulio-canti, low)_`
- [`IC-002` — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere](medium/IC-002-iain-collins.md) `_(iain-collins, medium)_`
- [`NSA-004` — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge](medium/NSA-004-nextjs-server-actions-auth-specialist.md) `_(nextjs-server-actions-auth-specialist, medium)_`
- [`TS-007` — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO](info/TS-007-tim-smart.md) `_(tim-smart, info)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** REFUTED — evidence quote matches `packages/server/src/Session.ts:108`, but the claim mischaracterizes Effect v4 semantics. `SessionContract.SessionNotFound` extends `Schema.TaggedError`, which returns a `Cause.YieldableError`-branded class (`effect/dist/Cause.d.ts:1221-1224`: `readonly [Effect.TypeId]: Effect.Variance<never, this, never>`) — instances structurally satisfy `Effect<never, Self, never>` and are valid `catchTag`/`catchTag` handler return values, not bare objects. All five cited sites (Session.ts:108, Password.ts:466, OAuth.ts:516/638/691) use the identical, idiomatic "errors are yieldable Effects" pattern documented in Effect's own `Schema.TaggedError` docs (`return yield* new NotFound(...)`); none type-check-fail or defect at runtime. Status → wontfix.
