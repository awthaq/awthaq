// @awthaq/core — UserImport
//
// AOMS-008 (SAM-008): the one import primitive every IdP migration
// (`@awthaq/migrate-auth0`, a Firebase/Supabase/Auth.js export script) builds
// on, so each does not re-derive the create + verify + link recipe — and its
// two hazards — by hand:
//
// - idempotent: a re-run of the same export converges (`Users.createOrGet`,
//   then each credential is linked only if it is not already), so a crashed
//   batch is simply run again;
// - transactional: the user row, its verified flag and its credential accounts
//   commit together (`SqlTransaction`), so no user without its credential
//   survives a failed row.
//
// It is an explicit, import-only entry point and is deliberately not exposed
// over HTTP. It is also the documented exception to BEH-EA-042's "no operation
// accepts a verified flag as input": `verified` says the *source* IdP already
// proved the address, and skipping it locks every such user out of a
// `requireVerifiedEmail` sign-in. It goes through `verifyEmail`/`verifyPhone`
// (monotone, never lowers), so it can never un-verify an existing user.

import type { Api } from "@awthaq/api";
import { SqlTransaction } from "@awthaq/ports";
import type { PasswordHasher } from "@awthaq/ports";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Accounts from "./Accounts.ts";
import { storeUnavailable } from "./Errors.ts";
import * as Users from "./Users.ts";

/** One credential account to attach to the imported user. */
export interface ImportCredential {
  readonly providerId: string;
  /** Omitted means the user's own id — `Password.ts`'s convention for the `password` provider, whose account is keyed by the user, never the email. */
  readonly subject?: string;
  /** BEH-EA-125: omitted for a non-federated provider (`password`). */
  readonly issuer?: string;
  /** The source system's hash, stored verbatim (TTE-005: the caller mints the `PhcHash` explicitly). */
  readonly credentialHash?: Redacted.Redacted<PasswordHasher.PhcHash>;
  /**
   * BAM-008: a federated provider's tokens carried over from the source (better-auth's `account` row),
   * encrypted at rest by the accounts repository. Omitted for a password credential and for a source
   * that exports none.
   */
  readonly tokens?: Accounts.ProviderTokenSet;
}

export interface ImportUserInput {
  readonly identity: Users.IdentityInput;
  readonly name: string;
  /** Whether the source IdP had already verified the identity (see the header). */
  readonly verified?: boolean;
  readonly metadata?: string;
  readonly image?: string;
  readonly credentials?: ReadonlyArray<ImportCredential>;
}

export interface ImportedUser {
  readonly user: Users.UserRecord;
  /** `false` on a re-run: the user already existed and was left as it was. */
  readonly created: boolean;
  /** Every credential account the user holds for this input, whether linked now or on an earlier run. */
  readonly accounts: ReadonlyArray<Accounts.AccountRecord>;
}

/**
 * A credential this import names is already linked to a *different* user — the
 * export and the target disagree, which no retry resolves. The whole row rolls
 * back (nothing of it is imported).
 */
export class ImportConflict extends Data.TaggedError("ImportConflict")<{
  readonly message: string;
  readonly providerId: string;
  readonly subject: string;
  readonly ownerUserId: Users.UserId;
}> {}

/** What importing one row can fail with besides a defect: a credential owned by someone else, or an outage. */
export type ImportFailure = ImportConflict | Api.StoreUnavailable;

// The user was just read or created in this same transaction, so a not-found or an identity that
// no longer fits is not a state the row can resolve; only an outage stays typed (`StoreUnavailable`).
const rowInvariant = { UserNotFound: Effect.die, IdentityMismatch: Effect.die };

/**
 * Imports one user, idempotently and atomically. An existing user keeps its
 * name/metadata (a re-run is not an update); the verified flag and the
 * credentials are the only things a re-run may add.
 */
export const importUser = (input: ImportUserInput) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const accounts = yield* Accounts.Accounts;
    const sqlTransaction = yield* SqlTransaction.SqlTransaction;

    const importRow = Effect.gen(function* () {
      const { user: found, created } = yield* users.createOrGet({
        identity: input.identity,
        name: input.name,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.image === undefined ? {} : { image: input.image }),
      });

      const user =
        input.verified === true && found.identity._tag === "Email"
          ? yield* users.verifyEmail(found.id).pipe(Effect.catchTags(rowInvariant))
          : input.verified === true && found.identity._tag === "Phone"
            ? yield* users.verifyPhone(found.id).pipe(Effect.catchTags(rowInvariant))
            : found;

      const linked = yield* Effect.forEach(input.credentials ?? [], (credential) =>
        Effect.gen(function* () {
          const subject = credential.subject ?? user.id;
          const existing = yield* accounts.findByProviderSubject(
            credential.providerId,
            subject,
            credential.issuer,
          );
          if (Option.isSome(existing)) {
            return existing.value.userId === user.id
              ? existing.value
              : yield* Effect.fail(
                  new ImportConflict({
                    message: `awthaq: ${credential.providerId} credential ${subject} already belongs to another user`,
                    providerId: credential.providerId,
                    subject,
                    ownerUserId: existing.value.userId,
                  }),
                );
          }
          return yield* accounts
            .link({
              userId: user.id,
              providerId: credential.providerId,
              subject,
              ...(credential.issuer === undefined ? {} : { issuer: credential.issuer }),
              ...(credential.credentialHash === undefined
                ? {}
                : { credentialHash: credential.credentialHash }),
              ...(credential.tokens === undefined ? {} : { tokens: credential.tokens }),
            })
            // Checked absent just above, so a violation here is a concurrent import of the
            // same credential — not a state this row can resolve.
            .pipe(Effect.catchTag("AccountAlreadyLinked", Effect.die));
        }),
      );

      return { user, created, accounts: linked } satisfies ImportedUser;
    });

    return yield* sqlTransaction
      .withTransaction(importRow)
      .pipe(Effect.catchTag("SqlError", storeUnavailable("UserImport.importUser")));
  });

/**
 * Imports many users with bounded concurrency, one transaction per row, and
 * reports each row's outcome in input order instead of aborting the batch on
 * the first conflict — the shape a migration script needs (re-run the failures
 * after fixing the export). `concurrency` defaults to 1 (sequential: predictable
 * against a live database; raise it deliberately).
 */
export const importUsers = (
  inputs: ReadonlyArray<ImportUserInput>,
  options?: { readonly concurrency?: number },
) =>
  Effect.forEach(inputs, (input) => importUser(input).pipe(Effect.result), {
    concurrency: options?.concurrency ?? 1,
  }).pipe(
    Effect.map((results) => ({
      results,
      imported: results.filter(Result.isSuccess).length,
      failed: results.filter(Result.isFailure).length,
    })),
  );
