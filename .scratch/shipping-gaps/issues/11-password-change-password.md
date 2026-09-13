# 11 — Change-password capability + endpoint

**What to build:** An authenticated user can change their own password
(given their current password), without going through the unauthenticated
forgot-password flow.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

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
