# @awthaq/migrate-auth0

Imports Auth0 database-connection users — including their bcrypt password
hashes — without forcing a mass password reset. Closes the gap
[`AOMS-001`](../../.issues/high/AOMS-001-auth0-okta-migration-specialist.md)
identified: `@awthaq/ports`' shipped `PasswordHasher` layers
(`layerArgon2id`, `layerScrypt`) only ever verified their own PHC-shaped
format, so an imported Auth0 hash — `$2a$`/`$2b$`/`$2y$` bcrypt — failed
every sign-in forever.

This package ships two pieces:

- `BcryptVerifier` — a `PasswordHasher.LegacyPasswordVerifierShape` that
  recognizes and verifies bcrypt hashes. Install its `layer` alongside your
  deployment's primary hasher and `PasswordHasher.verify` transparently
  dispatches a bcrypt-shaped hash to it instead of failing outright.
  `hasher.hash()` still only ever produces argon2id/scrypt output — bcrypt
  is a _recognized, retiring_ format here, never a re-adopted target.
- `ImportAuth0User` — one Auth0 export record in, one awthaq `User` +
  `Account` pair out, with the exported bcrypt hash stored byte-for-byte.

## Email verification of imported users

`@awthaq/password` refuses to sign in an account whose email is unverified
(`requireVerifiedEmail`, on by default). Carry each user's verified state across
with `emailVerified: exported.email_verified` (as below) — or call
`Users.verifyEmail` for the users your source system had verified. If part of
your population was never verified upstream and you do not want to lock it out,
set `Password.config({ requireVerifiedEmail: false })` and restrict unverified
users downstream instead. (The same applies to Firebase and Supabase/GoTrue
imports.)

## Other bcrypt sources: Supabase (GoTrue)

`BcryptVerifier` recognizes any `$2a$`/`$2b$`/`$2y$` bcrypt hash, not only
Auth0's, so it is also the verifier for **Supabase Auth (GoTrue)**. GoTrue keeps
each password user's hash in `auth.users.encrypted_password` (`$2a$10$...`).
Import it byte-for-byte as `passwordHash`, map `email_confirmed_at IS NOT NULL`
to `emailVerified`, and install `BcryptVerifier.layer` alongside your primary
hasher exactly as in step 3 below. A migrated Supabase user then signs in with
the old password and is rehashed to argon2id on that first login. The `$2a$`
path is covered by `test/BcryptVerifier.test.ts`.

Concretely: export `auth.users` (`email`, `encrypted_password`,
`email_confirmed_at`), then per row call `ImportAuth0User.importUser({ email,
name, emailVerified: email_confirmed_at !== null, passwordHash:
encrypted_password })` (it is `Users.createOrGet` + `Accounts.link({ credentialHash })`

- `verifyEmail`, in one transaction). Sign-in stays uniform for unknown emails: they still cost a
  real dummy-hash verify (BEH-EA-114).

## The recipe

**1. Export** your Auth0 database connection's users (Auth0's bulk user
export job, or the Management API's user-export endpoint) — you need each
user's `email`, `name`/`nickname`, `email_verified`, and
`password_hash` (bcrypt).

**2. Import**, once per exported user:

```ts
import { ImportAuth0User } from "@awthaq/migrate-auth0";
import * as Effect from "effect/Effect";

const program = ImportAuth0User.importUser({
  email: exported.email,
  name: exported.nickname ?? exported.email,
  emailVerified: exported.email_verified,
  passwordHash: exported.password_hash, // the raw "$2b$10$..." string
});
```

`importUser` is idempotent and transactional (AOMS-008): it builds on
`@awthaq/core`'s `UserImport.importUser`, so re-running an export converges — an
already-imported user comes back with `created: false`, and only the verified
flag and any missing credential are added — and the user row, its verified flag
and its credential commit together, so a failed row leaves no user without its
credential (it needs a `SqlTransaction` in the environment; provide
`SqlTransaction.layerSql` in production, `layerNoop` in memory). The one real
failure is `ImportConflict`: the password credential is already linked to a
_different_ user. `importUsers(exports, { concurrency })` runs a whole export,
one transaction per user, and reports every row's outcome in order — a
conflicting row does not abort the rest, so fix it and re-run the batch.

A source user with no email (a Firebase phone or anonymous user, a Supabase
phone-only user) goes through `UserImport.importUser` directly with a `Phone` or
`Anonymous` identity — there is no synthetic-email workaround (see
`Users.UserIdentity`).

**3. Install `BcryptVerifier.layer`** alongside your primary hasher at
composition time:

```ts
import { BcryptVerifier } from "@awthaq/migrate-auth0";
import { PasswordHasher } from "@awthaq/ports";
import * as Layer from "effect/Layer";

const HasherLive = PasswordHasher.layerArgon2id.pipe(Layer.provideMerge(BcryptVerifier.layer));
```

**4. Nothing else.** The first time a migrated user signs in, `@awthaq/password`'s
existing `rehashOnLogin` path (`Password.ts`'s `signIn`, gated on
`hasher.needsRehash`) transparently rewrites their credential to argon2id —
`needsRehash` already returns `true` for any hash it doesn't recognize as
its own format, which now correctly includes every bcrypt hash
`BcryptVerifier` matches. No explicit decommission step is needed: as the
population of not-yet-rehashed accounts shrinks toward zero, drop
`BcryptVerifier.layer` from the composed `Layer` whenever you're
comfortable — a deployment that never installs it sees zero behavior
change, since `PasswordHasher.LegacyPasswordVerifiers` defaults to `[]`.

## MFA enrolments are not importable

Auth0's bulk user export contains no MFA enrolments, and its Management API never returns a TOTP secret or a recovery code once enrolled, so neither can be migrated. An imported user who had Auth0 MFA arrives with a password and **no second factor**: `@awthaq/two-factor` sees them as not enrolled and does not divert their sign-in. Plan for it: tell affected users to enrol again (`POST /two-factor/enable`, then `/confirm`) after their first sign-in, and if a policy requires a second factor, enforce that with your own `BeforeSessionIssue` policy rather than assuming the imported account carries one. See [`@awthaq/two-factor`](../two-factor/README.md).

## Scope

Session migration (bridging a live Auth0 session token) is a separate,
unimplemented concern from this package — unlike a session, an imported
password hash has no expiry to race against; it verifies correctly for as
long as the account exists, so there is no dual-read window to manage
here, and none of this package's design depends on one existing.
