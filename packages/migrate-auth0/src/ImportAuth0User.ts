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
//
// AOMS-008: this is now a thin mapping onto `@awthaq/core`'s
// `UserImport.importUser`, which makes it idempotent and transactional.

import { Accounts, UserImport, Users } from "@awthaq/core";
import { PasswordHasher, SqlTransaction } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface Auth0ExportUser {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  /** Auth0's exported `$2a$`/`$2b$`/`$2y$` bcrypt hash, verbatim. */
  readonly passwordHash: string;
  /** Auth0's `user_metadata`/`app_metadata`, JSON-encoded by the caller and stored opaquely (AOMS-002). */
  readonly metadata?: string;
}

export interface ImportedAuth0User {
  readonly user: Users.UserRecord;
  readonly account: Accounts.AccountRecord;
  /** AOMS-008: `false` when an earlier run already imported this user (a re-run only fills in what was missing). */
  readonly created: boolean;
}

/** AOMS-008: what an import needs — naming it here also keeps `SqlTransaction` in scope for declaration emit. */
export type ImportRequirements = Users.Users | Accounts.Accounts | SqlTransaction.SqlTransaction;

const toImportInput = (input: Auth0ExportUser): UserImport.ImportUserInput => ({
  identity: { _tag: "Email", email: input.email },
  name: input.name,
  verified: input.emailVerified,
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  credentials: [
    {
      providerId: Accounts.PASSWORD_PROVIDER_ID,
      // TTE-005: the trust boundary for an imported hash — minted explicitly.
      credentialHash: Redacted.make(PasswordHasher.PhcHash(input.passwordHash)),
    },
  ],
});

const toImported = (imported: UserImport.ImportedUser) => {
  const account = imported.accounts[0];
  // `toImportInput` always names one credential, so a missing account is unreachable.
  return account === undefined
    ? Effect.die(new Error("awthaq: an Auth0 import produced no password account"))
    : Effect.succeed<ImportedAuth0User>({
        user: imported.user,
        account,
        created: imported.created,
      });
};

/**
 * Idempotent (AOMS-008): re-running an export converges — an already-imported
 * user is returned with `created: false`, and the row is one transaction, so a
 * failure leaves no user without its credential. `ImportConflict` is the one
 * real failure: the password credential is already linked to a *different* user.
 */
export const importUser = (input: Auth0ExportUser) =>
  UserImport.importUser(toImportInput(input)).pipe(Effect.flatMap(toImported));

/**
 * AOMS-008: a whole export, one transaction per user, per-row outcomes in input
 * order (a conflicting row does not abort the rest — fix it and re-run the
 * batch). `concurrency` defaults to 1; raise it deliberately against a live
 * database. Each success is `UserImport.ImportedUser`: the password account is
 * `accounts[0]`.
 */
export const importUsers = (
  inputs: ReadonlyArray<Auth0ExportUser>,
  options?: { readonly concurrency?: number },
) => UserImport.importUsers(inputs.map(toImportInput), options);
