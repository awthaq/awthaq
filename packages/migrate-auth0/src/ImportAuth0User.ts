// @awthaq/migrate-auth0 — ImportAuth0User
//
// AOMS-001's own recommended fix, the second half of the recipe:
// "Auth0 export -> users.create + accounts.link({credentialHash}) +
// verifyEmail". One Auth0 database-connection export record in, one
// awthaq `User`+`Account` pair out — `credentialHash` is the exported
// bcrypt string, stored byte-for-byte (Auth0's own hashes are already
// fully self-describing; nothing needs reshaping at import time). The
// account's `subject` is the newly-created `user.id`, matching
// `Password.ts`'s own `signUp` convention for the `password` provider
// (never the email — `AccountRecord.subject`'s uniqueness key is scoped
// per-provider, and email is already `User.email`'s own job).

import { Accounts, Errors, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface Auth0ExportUser {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  /** Auth0's exported `$2a$`/`$2b$`/`$2y$` bcrypt hash, verbatim. */
  readonly passwordHash: string;
}

export interface ImportedAuth0User {
  readonly user: Users.UserRecord;
  readonly account: Accounts.AccountRecord;
}

/**
 * Not idempotent — re-running a bulk import against a partially-imported
 * batch surfaces `EmailAlreadyExists`/`AccountAlreadyLinked` rather than
 * silently double-importing; a caller driving a bulk migration script
 * decides for itself whether to treat those as "already migrated, skip"
 * or a real failure.
 */
export const importUser = (
  input: Auth0ExportUser,
): Effect.Effect<
  ImportedAuth0User,
  Users.EmailAlreadyExists | Accounts.AccountAlreadyLinked | Errors.StoreUnavailable,
  Users.Users | Accounts.Accounts
> =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const created = yield* users.create({ email: input.email, name: input.name });
    const user = input.emailVerified
      ? yield* users.verifyEmail(created.id).pipe(Effect.orDie)
      : created;
    const account = yield* accounts
      .link({
        userId: user.id,
        providerId: Accounts.PASSWORD_PROVIDER_ID,
        subject: user.id,
        // TTE-005: the trust boundary for an imported hash — minted explicitly.
        credentialHash: Redacted.make(PasswordHasher.PhcHash(input.passwordHash)),
      });
    return { user, account };
  });
