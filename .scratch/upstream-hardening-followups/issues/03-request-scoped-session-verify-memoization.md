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

- [ ] A documented design decision for where the memoization lives (a new
      middleware-adjacent service both `AuthenticationLive` and
      `SubjectExtractorLive` can share, vs. some other seam) and how its
      scope is bounded to exactly one request
- [ ] `resolveSession`/`resolvePrincipal` (`@awthaq/server`'s
      `Authentication.ts`) and `SubjectExtractorLive`
      (`@awthaq/qadi`'s `SubjectExtractor.ts`) both go through it
- [ ] A real test proves an endpoint combining `Api.Authentication` and
      `RequirePermission`/`SubjectExtractorLive` on one route survives a
      `touchEvery`-crossing request without a false `SessionNotFound`
- [ ] The now-resolved risk note on `Sessions.verify`'s own doc comment
      (`packages/core/src/Sessions.ts`) is updated to reflect the fix
- [ ] `pnpm check` is green
