# 09 — Scaffold Account HTTP group + wire update-profile

**What to build:** A new core-owned `Account` HTTP group exists
(mirroring `Session`/`Subject`'s own root-level, core-owned placement,
implemented in `packages/api`/`packages/server`, no plugin machinery
needed), and an authenticated user can update their own profile (name)
over HTTP via it.

**Blocked by:** None — can start immediately (ticket 08 shipped
`verify-email` inside the `Password` plugin instead of this group — see
ticket 08's own `## Result` — so this ticket is now the `Account` group's
actual first tenant, not a follower of it)

**Status:** ready-for-agent

- [ ] New `Account` `HttpApiGroup` exists in `packages/api`, composed
      into `AuthCoreApi` alongside `SessionGroup`/`SubjectGroup`, with
      handlers in `packages/server` mirroring `Session.ts`'s own
      `HttpApiBuilder.group` shape
- [ ] `PATCH /user` (or equivalent) on the `Account` group wires onto the
      existing `Users.updateProfile` capability — no change to that
      capability's own `{ name }`-only input shape
- [ ] Requires authentication, via the same `AuthenticationLive`/
      `OptionalAuthenticationLive` path every other authenticated
      endpoint already uses
- [ ] Wire-level contract test: an authenticated caller updates their
      name and a subsequent read reflects it; an unauthenticated caller
      is rejected
- [ ] No duplication of `Users.updateProfile`'s own existing domain-level
      test coverage — this ticket only adds the wire layer
