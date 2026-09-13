# 11 — Change-password capability + endpoint

**What to build:** An authenticated user can change their own password
(given their current password), without going through the unauthenticated
forgot-password flow.

**Blocked by:** None — can start immediately

**Status:** done

## Result

`PasswordApi.ChangePasswordPayload`, `WrongPassword` (401, distinct from
`Api.Unauthenticated`), and a `changePassword` endpoint on `PasswordGroup`
— the first endpoint in this plugin's contract carrying per-endpoint
`Authentication` middleware (`HttpApiEndpoint.middleware`, not the whole
group, since every other `Password` endpoint is intentionally
unauthenticated). `Password.ts` gained a `changePassword` capability:
uniform-cost verification against a dummy hash when no password account
exists (mirroring `signIn`'s own posture, even though this endpoint is
authenticated and has no enumeration concern — timing consistency stays
the default), then the same `checkPolicy`/hash/`updateCredentialHash`
path `confirmReset` already uses.

**Ripple, not in the original ticket text:** declaring middleware on one
endpoint in a plugin's `HttpApiGroup` means *building `Password.layer`
at all* now requires that middleware satisfied — not just the HTTP
wire-test, but `Password.test.ts`'s own domain-level tests too, even
though they never touch HTTP. Fixed by adding
`Authentication.AuthenticationLive` (+ `PrincipalResolverLive`) to every
layer composition in both test files that builds `Password.Password.layer`
(4 call sites in `Password.test.ts`, 1 in `AuthHttp.test.ts`).

Tests: 2 new wire-level (`AuthHttp.test.ts`: full change round-trip +
wrong-current-password + unauthenticated-401; login with old password
fails, new succeeds) and 2 new domain-level (`Password.test.ts`:
wrong-current-password + weak-new-password). `pnpm --filter
@effect-auth/password test` — 26 tests, green. `pnpm test` — 568 tests,
all green; `pnpm typecheck`/`pnpm lint`/`pnpm format:check` clean
workspace-wide.

- [ ] New `Password`-plugin capability (alongside the existing
      `signUp`/`signIn`/`requestReset`/`confirmReset`) verifies the
      caller's current password via the existing `PasswordHasher` port
      before rotating the stored hash
- [ ] `POST /change-password` — a top-level route, not nested under
      `/password/*` — requires authentication
- [ ] An incorrect current password is rejected with a distinct, typed
      error from "not authenticated"
- [ ] Wire-level contract test (extending
      `packages/password/test`'s existing `AuthHttp.test.ts`): the
      correct current password rotates the hash and a subsequent sign-in
      with the new password succeeds; an incorrect current password is
      rejected and the old password still works
- [ ] Domain-level test against `PasswordShape` directly (in-memory),
      matching `Password.test.ts`'s existing shape
