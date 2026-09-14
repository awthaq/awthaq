# 03 — Request-scoped memoization so `Sessions.verify` runs at most once per request

**What to build:** an endpoint wiring both qadi Path A
(`Api.Authentication`) and Path B (`SubjectExtractorLive`/
`RequirePermission`) together no longer risks a false logout.

Found and documented (not fixed — flagged as out of scope) during
`.scratch/upstream-hardening/map.md`'s own ticket 01 (session token
rotation): `@awthaq/qadi`'s `SubjectExtractorLive` calls
`Authentication.resolvePrincipal` — and so `Sessions.verify` — directly
against the raw request, independent of and potentially before
`Api.Authentication`'s own middleware runs on the same request
(`spec/behaviors/20-qadi-bridge-path-b.md`, BEH-EA-153). Since ticket 01
made `verify` rotate the session secret on its throttled touch write, a
second `verify` call within the same request — against the same
pre-rotation credential the first call already rotated away from — now
fails with `SessionNotFound` instead of the harmless no-op it was before
rotation existed. This would fire once per session per `touchEvery`
window, on any endpoint combining both bridges.

Not currently triggered by any endpoint in this repository (confirmed:
`AdminApi.ts`, the only place carrying `Api.Authentication` middleware
alongside qadi wiring, uses no `RequirePermission`/Path B on the same
route) — this is a real risk for future composition, not a currently
failing test.

The fix needs request-scoped memoization of `verify`'s result, keyed on
the raw presented token, so a second call within the same request reuses
the first's outcome (including whether it rotated) rather than hitting
`Sessions` again. No such request-scoped caching mechanism exists
anywhere in this codebase yet — this is new infrastructure, sized
accordingly; consider Effect's own request/cache primitives
(`Effect.cachedFunction`, or a `FiberRef`/request-context-scoped cache)
rather than inventing a bespoke one.

**Blocked by:** None — can start immediately

**Status:** done

- [x] A documented design decision for where the memoization lives (a new
      middleware-adjacent service both `AuthenticationLive` and
      `SubjectExtractorLive` can share, vs. some other seam) and how its
      scope is bounded to exactly one request
- [x] `resolveSession`/`resolvePrincipal` (`@awthaq/server`'s
      `Authentication.ts`) and `SubjectExtractorLive`
      (`@awthaq/qadi`'s `SubjectExtractor.ts`) both go through it
- [x] A real test proves an endpoint combining `Api.Authentication` and
      `RequirePermission`/`SubjectExtractorLive` on one route survives a
      `touchEvery`-crossing request without a false `SessionNotFound`
- [x] The now-resolved risk note on `Sessions.verify`'s own doc comment
      (`packages/core/src/Sessions.ts`) is updated to reflect the fix
- [x] `pnpm check` is green

## Resolution

Investigated against the real `effect` v4 source (`../effect`) before
picking a mechanism, since the obvious answer (a `FiberRef`) doesn't
exist in v4 — everything moved to `Context.Reference`, whose own
`defaultValue()` is memoized once, globally (`Context.ts`'s
`getDefaultValue`), not per-fiber. Using it safely would need a new
middleware, applied globally ahead of both `Api.Authentication` and
`RequirePermission`, to explicitly re-provide a fresh cache every
request — real new wiring in every place the Api is served, with an
ordering requirement that's exactly the problem this ticket exists to
route around.

Landed instead on keying a module-level `WeakMap` off the ambient
`HttpServerRequest`'s own object identity (`packages/server/src/Authentication.ts`).
Confirmed via `effect`'s own `HttpRouter.ts`/`HttpApiBuilder.ts` that it's
provided once per request, upstream of all endpoint middleware, and
stays the same object for the request's whole lifetime (`@qadi/http`'s
own `RequirePermission.ts` mutates it in place). Both bridges already
have — or can trivially be given — ambient access to it, so no new
middleware or wiring changes were needed anywhere `Api.Authentication`/
`SubjectExtractorLive` are already composed; the fix is entirely inside
`resolveSession` plus one `Effect.provideService` call in
`SubjectExtractorLive.extract` (which already receives the request as a
plain parameter). Cache value is a `Ref<HashMap<string, Effect<...>>>`,
matching this codebase's own idioms (`Sessions.ts`'s own `layerMemory`
uses the identical `Ref<HashMap<...>>` shape) rather than a raw mutable
`Map`. `Effect.cached` memoizes the `Exit` (verified against
`effect/internal/effect.ts`'s own implementation), so both a successful
and a failed resolution are reused, not just the happy path.

Verified the regression test actually catches the bug it claims to,
not just superficially passing: `@awthaq/server`'s package `exports`
resolve to its compiled `lib/*.js` (rebuilt only by `tsc -b`, not by
editing `src/` alone) — temporarily broke the memoization in source,
force-rebuilt with `pnpm --filter @awthaq/server typecheck`, and
confirmed the new test in `packages/qadi/test/SubjectExtractor.test.ts`
fails exactly as expected (`SessionNotFound` → false `anonymous`) before
restoring the real fix and rebuilding clean.

Also updated `resolvePrincipal`'s pre-existing return-type annotation
only as far as the Requirements channel needed to change — then, per
explicit correction, removed both that annotation and the one briefly
added to `resolveSession` entirely rather than hand-maintaining them,
letting inference do the work (house rule: never annotate a new/changed
Effect const's return type).

Full `pnpm check` (typecheck, package:smoke, lint, knip, format,
circular, coverage, BDD, spec:verify:strict) is green; the new ticket-03
regression test lives in `packages/qadi/test/SubjectExtractor.test.ts`.
