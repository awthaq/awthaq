// @awthaq/core — UserImport
//
// spec/behaviors/26-cli.md BEH-EA-207 (BAM-001, FAMS-010; decision 07 §6). What a foreign-IdP
// importer (`@awthaq/migrate-better-auth`, `@awthaq/migrate-firebase`, ...) *produces*, and the one
// writer that turns it into rows through the domain services — never raw INSERTs, so an imported
// account holds the same invariants a runtime-created one does (email uniqueness, the
// `(providerId, subject, issuer)` anchor, an imported hash stored verbatim for the legacy verifier
// to check and `rehashOnLogin` to retire).
//
// `ImportedUser` is deliberately the same shape as `Users.create` + `verifyEmail` + one
// `Accounts.link` per account: a source package's job is the *mapping* from its own rows (pure,
// decoded through Schemas, reporting what it could not map); this module's job is the write.
// `@awthaq/migrate-auth0`'s `importUser` is the same recipe hard-wired to one source.

import type { PasswordHasher } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Accounts from "./Accounts.ts";
import * as Users from "./Users.ts";

/** One linked account of an imported user. */
export interface ImportedAccount {
  readonly providerId: string;
  /**
   * The provider-side subject. `undefined` means "the new user's own id", which is how a password
   * credential is keyed (`Password.signUp`'s convention, BEH-EA-044): it cannot be known before the
   * user row exists.
   */
  readonly subject: string | undefined;
  /** BEH-EA-125: the third part of the anchor; absent for a plain OAuth2 provider and for `password`. */
  readonly issuer?: string | undefined;
  /** An imported hash, stored verbatim (`PasswordHasher.PhcHash` is the trust boundary, minted by the source package). */
  readonly credentialHash?: PasswordHasher.PhcHash | undefined;
  /** BAM-008: provider tokens carried over, encrypted at rest by the accounts repository. */
  readonly tokens?: Accounts.ProviderTokenSet | undefined;
}

export interface ImportedUser {
  readonly email: string;
  readonly name: string;
  /** The source vouched for the address: applied through `Users.verifyEmail`, the sanctioned one-way transition. */
  readonly emailVerified: boolean;
  readonly metadata?: string | undefined;
  readonly accounts: ReadonlyArray<ImportedAccount>;
}

export interface WrittenUser {
  readonly user: Users.UserRecord;
  readonly accounts: ReadonlyArray<Accounts.AccountRecord>;
}

/**
 * Writes one imported user through `Users` and `Accounts`. Not idempotent: an existing address fails
 * `EmailAlreadyExists` and an already-linked anchor `AccountAlreadyLinked`, so a caller driving a
 * bulk import (the CLI's `import`, with its checkpoint ledger) decides what "already there" means —
 * and runs it inside a transaction so a failure leaves nothing half-written.
 */
export const write = (input: ImportedUser) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const created = yield* users
      .create({
        email: input.email,
        name: input.name,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      })
      .pipe(Effect.catchTag("PlatformError", Effect.die));
    const user = input.emailVerified
      ? yield* users.verifyEmail(created.id).pipe(Effect.orDie)
      : created;
    const linked = yield* Effect.forEach(input.accounts, (account) =>
      accounts
        .link({
          userId: user.id,
          providerId: account.providerId,
          subject: account.subject ?? user.id,
          ...(account.issuer === undefined ? {} : { issuer: account.issuer }),
          ...(account.credentialHash === undefined
            ? {}
            : { credentialHash: Redacted.make(account.credentialHash) }),
          ...(account.tokens === undefined ? {} : { tokens: account.tokens }),
        })
        .pipe(Effect.catchTag("PlatformError", Effect.die)),
    );
    const written: WrittenUser = { user, accounts: linked };
    return written;
  });
