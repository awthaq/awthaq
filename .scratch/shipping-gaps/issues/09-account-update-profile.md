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

**Status:** done

## Result

`packages/api/src/Account.ts`: new `AccountGroup` (`account`, top-level
routes `/user` PATCH/DELETE, `Authentication` middleware), folded into
`AuthCoreApi` alongside `SessionGroup`. `packages/server/src/Account.ts`:
`AccountHandlers`, mirroring `Session.ts`'s own `currentUserPrincipal`/
`HttpApiBuilder.group` shape; `updateProfile` wires onto the existing
`Users.updateProfile` unchanged, `{ name }`-only.

**Ripple, not in the original ticket text:** `AuthCoreApi` is shared —
adding `AccountGroup` to it meant every consumer composing the full
`AuthCoreApi` (not just this package's own test) now needs an
`Account.AccountHandlers` provided too, or the composed contract is
missing a handler. One other consumer existed:
`packages/jwt/test/AuthHttp.test.ts`'s `CrossPluginAppLayer` — updated to
provide it (plus `Users.layerMemory`/`Accounts.layerMemory`).

Wire-level tests added to `packages/server/test/AuthHttp.test.ts`:
authenticated update reflects in a subsequent read, unauthenticated is
401. `pnpm --filter @effect-auth/server test` (24 tests) and
`pnpm --filter @effect-auth/jwt test` (39 tests) both green;
`pnpm test` — 564 tests, all green; `pnpm typecheck`/`pnpm lint`/
`pnpm format:check` clean workspace-wide.

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
