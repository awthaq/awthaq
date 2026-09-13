# 03 — `resolvePrincipal` places a session's `actingAs` onto `UserPrincipal`

**What to build:** `Authentication`'s `resolvePrincipal` reads the
`actingAs` field off the session row it already fetches (ticket 02) and
sets it on the `UserPrincipal` it builds — the same row-to-principal
mapping that already happens for `userId`/`sessionId`. This closes the loop
BEH-EA-142 (`spec/behaviors/18-roles-subject-resolver.md`) was written
anticipating: once this ticket lands, the chain `Session.actingAs` →
`UserPrincipal.actingAs` → `AuthSubject.attributes.actingAs` is unbroken
end to end, with no plugin other than `Admin` ever needing to touch any of
the three.

**Blocked by:** Ticket 02.

**Status:** done

- [x] `resolvePrincipal` sets `UserPrincipal.actingAs` from the session
      row's own `actingAs` whenever it is present, and omits it (not `undefined`
      — respecting `exactOptionalPropertyTypes`) whenever it is absent
- [x] `packages/server/test/Authentication.test.ts` gains a case: a session
      issued with `actingAs` resolves to a `UserPrincipal` carrying the
      identical `actingAs` value
- [x] An ordinary session (no `actingAs`) still resolves to a
      `UserPrincipal` with no `actingAs` field at all — existing tests keep
      passing unmodified
- [x] `packages/qadi/test/SubjectResolver.test.ts`'s own `actingAs`
      assertions (BEH-EA-142) still pass unmodified — this ticket changes
      what produces the `Principal`, never how `SubjectResolver` reads it
      (BEH-EA-211)

## Result

Done. `Authentication.ts`'s `PrincipalResolverLive.resolve` (the actual
implementation behind the `resolvePrincipal` function this ticket names)
now spreads in `actingAs: new Api.PrincipalRef({...})` only when
`Option.isSome(session.actingAs)`, so the field is omitted entirely rather
than set to `undefined`. Two new `Authentication.test.ts` cases (a new
`whoIsActingAs` test endpoint/handler added to the file's own `TestApi`)
prove both directions. `packages/qadi/test/SubjectResolver.test.ts` was
not touched and still passes unmodified — confirmed by running it
directly.
