# 01 — Account-lifecycle HTTP wiring gaps

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

The origin report claimed local ships only 6 HTTP endpoints with no
sign-up/sign-in/reset surface at all. That's already false: `Session`
(5 endpoints), `Subject` (1), and `Password` (4: sign-up, sign-in,
request-reset, confirm-reset — `packages/password/src/PasswordApi.ts`
L88-124, implemented in `Password.ts` L173-213) are all wired today. The
one confirmed real gap: `PasswordShape.signUp` dispatches a
`"verify-email"` mail template (`Password.ts` L292, `VERIFY_PREFIX`
constant L101) but nothing consumes that verification token — no HTTP
endpoint, no service call.

First audit, then decide: (a) what is the *current*, accurate wire-level
gap across account lifecycle — re-check `changePassword`, `updateUser`,
`deleteUser` (report claimed all three are entirely absent locally; is
that still true, and does anything in `packages/core` already provide the
non-HTTP half of any of them the way `Password`'s reset flow already did
before this map existed?), and whatever `Organization`/`Admin`/`Passkey`/
`Jwt` added to the wire surface since the report's snapshot (unaudited).
(b) For whatever's genuinely still missing, decide the endpoint
shape(s): route path and HTTP method (mirror `PasswordApi`'s
`/password/*` convention, e.g. a `/password/verify-email` POST consuming
a token, or a top-level `/verify-email`?), request/response schema, and
which existing `Data.TaggedError`s from `packages/core` map onto which
`Schema.TaggedError` wire errors (matching the existing per-service
tagged-error pattern, not upstream's single `PublicAuthError` taxonomy).

## Answer

**Audit.** `Users.updateProfile` already exists as a real, callable Effect
(`packages/core/src/Users.ts:62,157,266`) — deliberately narrow, `{ name }`
only — and `Users.delete` already exists (`Users.ts:67`, cascade-to-
`Accounts`/`Sessions` explicitly left to the caller per `Users.ts:79`).
Neither is wired to HTTP. No `changePassword`/`updatePassword` exists
anywhere (`packages/*/src` grep is empty) — a real gap at both the
core-capability *and* HTTP layers, not just wiring. Email-verification-
token-consume is fully real (`Verification.ts` `consume`, `Users.ts`
`verifyEmail`) — also purely a wiring gap. Endpoints added since the
origin report's snapshot: Organization (~30, `OrganizationApi.ts`), Admin
(4: impersonate/stopImpersonating/forceStop/list), Passkey (6: register/
authenticate options+verify, credential list/rename/remove), Jwt (2:
jwks, mint) — none overlap account-lifecycle scope.

**Decided scope (full account-lifecycle).** Build all four: verify-email
(pure wiring onto the existing `Verification.consume`/`Users.verifyEmail`
pair), update-user/profile (pure wiring onto the existing
`Users.updateProfile`), delete-user (pure wiring onto the existing
`Users.delete` — the cascade behavior at `Users.ts:79` needs its own
explicit call at implementation time, not re-opened here), and
change-password (**new** — no core capability exists yet; needs a new
`Password`-plugin function that verifies the caller's current password
before rotating the hash, distinct from the existing unauthenticated
forgot-password `requestReset`/`confirmReset` pair).

**Route convention.** Top-level (`POST /verify-email`,
`POST /change-password`, `PATCH /user`, `DELETE /user`), not nested under
`/password/*` — update-user/delete-user apply regardless of which auth
method a given user signed up with, so they don't belong under the
password plugin's own namespace.
