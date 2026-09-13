# 24 — Admin step-definitions

**What to build:** `Admin`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** done

## Result

Unlike Password/OAuth/Passkey, `Admin` had real `spec/behaviors/`
coverage (`27-admin-impersonation.md`, BEH-EA-209 through BEH-EA-220) but
never got its own `.feature` file at spec-authoring time — this ticket's
own premise ("wire Admin's feature files") assumed one existed. Authored
`features/features/09-admin-and-impersonation/27-admin-impersonation.feature`
from that spec file directly (25 scenarios, REQ-EA-382 through REQ-EA-406 —
continuing past Passkey's own REQ-EA-381, assigned here for the first
time), then wired it in full: all 25 execute for real, none pruned.

`features/step-definitions/AdminWorld.ts` builds the real `Admin.Admin`
service over a real `HttpRouter.toWebHandler` app (real in-memory
`Sessions`/`Users`/`AuthEvents`/`ImpersonationRecords`) — the same
wire-level seam `packages/admin/test/AuthHttp.test.ts` already establishes.
Four scenarios (BEH-EA-209/210/211/218) need to inspect state no HTTP
response ever carries — a session row's own `actingAs`/`idleExpiresAt`, or
a resolved `UserPrincipal`'s `actingAs` — so this World also exposes
direct domain-level access to `Sessions`/`Authentication.resolvePrincipal`
over the same shared `MemoMap` the HTTP handler itself resolves against,
plus a captured `AuthEvents` stream for the three audit-event scenarios.

Two real, reproduced bugs caught and root-caused via failing assertions,
not inspection — both in this World's own new code, not in `@effect-auth/admin`
itself:

1. **A session-clock mismatch, the identical bug class `PasskeyWorld.ts`
   found in ticket 25** (see that ticket's own Result): an early draft's
   `signIn` bootstrapped a session via a bare `yield*` inside the calling
   step's own ambient Effect, inheriting `@effect-cucumber/vitest`'s
   `TestClock` (frozen at epoch 0) — while `HttpRouter.toWebHandler`'s own
   per-request execution always runs on the real global runtime. Every
   session looked decades expired to real HTTP validation. Fixed the same
   way: routing `signIn` through `Effect.runPromise`, matching
   `AuthHttp.test.ts`'s own working `issueSessionCookieHeader`.
2. **A real PubSub subscription race**, this one genuinely new: the event
   -capture layer forked its `AuthEvents.stream` subscriber via a bare
   `Effect.forkScoped(...)` — merely *scheduling* the fork, not running it
   to its first suspension point. Against a live `PubSub.bounded` (not a
   replay log), the very first `impersonate` call could publish before the
   subscription had actually registered, silently dropping the event for
   good — reproduced directly (`publishedEvents()` returned `[]` after a
   real, successful impersonate call). `packages/core/test/AuthEvents.test.ts`
   already documents this exact race and its fix in its own comment: fixed
   by passing `{ startImmediately: true }` to `forkScoped`, which runs the
   fork synchronously up to the real PubSub subscribe before returning.
   (`PasswordWorld.ts`'s own `eventsLayer`, ticket 20, has the identical
   unguarded `Effect.forkScoped` and likely shares this same latent race —
   left alone here as out of this ticket's own scope, since its existing
   scenarios evidently don't hit it in practice, but worth a note for
   whoever next touches that file.)

Also caught two ordinary step/pattern mismatches while wiring (an
`Option`-wrapped-vs-plain-optional assumption on `Api.UserPrincipal.actingAs`
vs. `Sessions.SessionView.actingAs`, and a cucumber-expression `/`-escaping
miss) — both fixed, not pruned.

`pnpm test:bdd` — 104 passed, 34 skipped (was 79/34 after ticket 25 — 25
new scenarios, 0 new skips). `pnpm test` — 586 passed, 2 skipped,
unaffected. `pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean
workspace-wide.

- [x] Step-definitions written for `Admin`'s feature files, calling into
      the existing `Admin` wire-level seam
      (`packages/admin/test/AuthHttp.test.ts`)
- [x] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented — n/a here: all 25
      authored scenarios are real, currently-implemented behavior
- [x] The existing `test:bdd` step executes these scenarios and passes
