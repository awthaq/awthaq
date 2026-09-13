# 08 — Wire verify-email

**What to build:** Email verification is real end-to-end over HTTP: a
caller with a valid verification token can complete email verification.

**Blocked by:** None — can start immediately

**Status:** done

## Result

**Architectural discovery, not in the original ticket text:** the token
issued at sign-up (`VERIFY_PREFIX`, `encodeVerificationToken`/
`decodeVerificationToken`) already lives entirely inside
`packages/password/src/Password.ts`, private to that module — no other
package has ever needed it. Scaffolding a new core-owned `Account`
`HttpApiGroup` in `packages/api` (as this ticket originally proposed)
would have meant either exporting that plugin-private encoding scheme
out of `Password` into `core`, or duplicating it. Neither made sense for
one endpoint, so `verifyEmail` shipped as a new `Password`-plugin
capability instead — same package that already owns the token, same
`PasswordHandlers`/`PasswordShape` shape every other password capability
uses. The route itself is still top-level (`POST /verify-email`, not
nested under `/password/*`), matching this ticket's own routing decision
from `.scratch/shipping-gaps/issues/01-account-lifecycle-http-gaps.md`.
`update-profile` (09) and `delete-user` (10) are genuinely
plugin-independent core capabilities, so the `Account` group scaffold
those tickets actually need still gets built — just not here.

Implementation: `PasswordApi.VerifyEmailPayload` (`{ token }`), a new
`verifyEmail` endpoint on `PasswordGroup` (error: `TokenConsumed`, no
`success` schema — defaults to `204`, matching `signOut`'s convention).
`Password.ts` gained a `verifyEmail` capability mirroring `confirmReset`'s
own shape: decode the token, `Verification.consume`, then
`Users.verifyEmail` on the identifier's embedded user id. A missing user
at that point is treated as a defect (`Effect.die`), not a request error
— mirrors `confirmReset`'s own posture on the analogous "the account this
token names must still exist" case, since the token can only ever have
been minted for a real user in the first place.

Two new wire-level tests added to `packages/password/test/AuthHttp.test.ts`:
the real sign-up → mailed token → verify → replay-fails-410 round trip,
and a garbage-token-answers-410 case. `pnpm --filter @effect-auth/password
test` — 22 tests, all green. `pnpm typecheck`/`pnpm lint`/`pnpm format:check`
clean workspace-wide.


- [ ] New `Account` `HttpApiGroup` exists in `packages/api`, composed
      into `AuthCoreApi` alongside `SessionGroup`/`SubjectGroup`
- [ ] `POST /verify-email` consumes a token via the existing
      `Verification.consume`/`Users.verifyEmail` pair — no
      reimplementation of that logic
- [ ] Errors map onto this codebase's per-service `Data.TaggedError` →
      `Schema.TaggedError` convention (expired/unknown/already-consumed
      token cases distinguished the same way `Verification.consume`'s
      existing `TokenConsumed` already collapses them)
- [ ] Wire-level contract test (real HTTP router boot, extending the
      existing `Session`/`Subject` wire-test file) proves: a valid token
      verifies the user and returns success; an invalid, expired, or
      already-consumed token returns the correct error status
- [ ] Domain-level test against the `Account` group's handler layer
      directly (in-memory), matching every other plugin's own
      domain-level test shape
