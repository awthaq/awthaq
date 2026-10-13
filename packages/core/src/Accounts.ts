// @awthaq/core — Accounts
//
// spec/behaviors/06-domain-users-accounts.md, BEH-EA-043 through BEH-EA-045,
// BEH-EA-047. Plan 02 (ADR-EA-041): written once, over `@awthaq/ports`' `AccountStore` (a `Ref`
// adapter there, a SQL adapter over `@awthaq/sql`'s repository, BEH-EA-033-036). The service owns
// the rules (the uniqueness error, the issuer convention, the last-account policy, the credential
// hash brand, the id and the clock); the store owns persistence and the atomicity of each primitive.

import { AccountStore, type Ids, PasswordHasher } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { relabel, storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import * as Tenant from "./Tenant.ts";
import { UserId } from "./Users.ts";

// MA-008: the brand is declared once, in `@awthaq/ports` (`Ids`); this keeps only a nominal constructor.
export type AccountId = Ids.AccountId;
export const AccountId = Brand.nominal<AccountId>();

/** BEH-EA-044: `providerId = "password"` is the reserved password-credential provider. */
export const PASSWORD_PROVIDER_ID = "password";

export interface AccountRecord {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly providerId: string;
  readonly subject: string;
  /**
   * BEH-EA-125/INV-EA-015 (`@awthaq/oauth`): the third component of
   * the real identity anchor — `(providerId, subject, issuer)`, never
   * `(providerId, subject)` alone. `password` and any other non-federated
   * provider have no issuer at all (`Option.none()`); two OIDC accounts
   * that happen to share a `subject` under different issuers must never
   * collapse into one row, which is exactly what folding issuer into the
   * uniqueness key (not just carrying it as inert metadata) prevents.
   */
  readonly issuer: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export class AccountAlreadyLinked extends Data.TaggedError("AccountAlreadyLinked")<{
  readonly message: string;
  readonly providerId: string;
  readonly subject: string;
}> {}

export class AccountNotFound extends Data.TaggedError("AccountNotFound")<{
  readonly message: string;
  readonly id: AccountId;
}> {}

/**
 * BEH-EA-045: refusing to remove a user's last credential is a request-level
 * precondition failure, not a system defect — its own tagged error, distinct
 * from `AccountNotFound`, so a caller can render it as "you have no other
 * way to sign in" rather than a generic error.
 */
export class LastAccountRefusal extends Data.TaggedError("LastAccountRefusal")<{
  readonly message: string;
  readonly userId: UserId;
}> {}

/**
 * PV-221/BEH-EA-045: whether a User may be left with zero Accounts. `false` (the default) refuses
 * unlinking the last one (`LastAccountRefusal`); a deployment that deliberately wants a User to
 * outlive its last credential (an account kept for its data, re-entered through recovery or an
 * admin) opts in with `Accounts.config({ allowZeroAccounts: true })`. Like every core config it
 * can also be applied to one call (`Effect.provideService`) or one tenant (`Tenant.configApplied`).
 */
export interface AccountsPolicyShape {
  readonly allowZeroAccounts: boolean;
}

export const AccountsPolicy = Context.Reference<AccountsPolicyShape>("awthaq/core/AccountsPolicy", {
  defaultValue: () => ({ allowZeroAccounts: false }),
});

export const config = (partial: Partial<AccountsPolicyShape>) =>
  Layer.succeed(AccountsPolicy, { allowZeroAccounts: false, ...partial });

/**
 * SMS-002: the stored provider tokens for an account cannot be decrypted —
 * their key was retired from the keyset or the ciphertext is corrupt. Not a
 * defect: the caller (e.g. `@awthaq/oauth`'s token access) should treat the
 * account as needing re-consent, and the next successful OAuth sign-in
 * overwrites the unreadable value.
 */
export class ProviderTokensUnreadable extends Data.TaggedError("ProviderTokensUnreadable")<{
  readonly id: AccountId;
  readonly field: "accessToken" | "refreshToken" | "idToken";
  readonly reason: "DecryptionFailed" | "UnknownKeyId";
}> {}

/**
 * BE-002 (.issues/high): a federated provider's exchanged token pair, kept
 * out of `AccountRecord` for the same reason `credentialHash` is — an
 * ordinary "list my linked accounts" read must never carry a live
 * credential. Includes `idToken` (BAM-008): the OIDC `id_token` the provider
 * returned, kept (encrypted at rest like the other two tokens) so a
 * better-auth account import has a destination for it and a future
 * RP-initiated logout can send it as `id_token_hint`. `None` for a plain
 * OAuth2 provider, or when a refresh response carried none and none was stored.
 * It is the store port's own type, so a service and its adapters speak one shape.
 */
export type ProviderTokenSet = AccountStore.ProviderTokens;

export interface AccountsShape {
  /**
   * BEH-EA-043: `(providerId, subject)` is a schema-level-equivalent unique
   * constraint here. `credentialHash` is BEH-EA-044's password-credential
   * case (`providerId = "password"`) — an already-hashed secret
   * (`@awthaq/password`'s own `PasswordHasher` port produced it; this
   * service never hashes anything itself), stored alongside the row and
   * deliberately kept out of `AccountRecord` so an ordinary "list my linked
   * accounts" read never carries a hash it doesn't need.
   *
   * BE-002: `tokens` is the equivalent capture for a federated provider's
   * initial exchange — omitted (not merely all-`None`) for `password` and
   * any provider `@awthaq/oauth` doesn't hand one for, so every existing
   * caller that never knew about provider tokens keeps compiling and
   * behaving unchanged.
   */
  readonly link: (input: {
    readonly userId: UserId;
    readonly providerId: string;
    readonly subject: string;
    /** BEH-EA-125: omitted for a non-federated provider (`password`); see `AccountRecord.issuer`. */
    readonly issuer?: string;
    readonly credentialHash?: Redacted.Redacted<PasswordHasher.PhcHash>;
    readonly tokens?: ProviderTokenSet;
  }) => Effect.Effect<AccountRecord, AccountAlreadyLinked | StoreUnavailable>;
  readonly findByProviderSubject: (
    providerId: string,
    subject: string,
    issuer?: string,
  ) => Effect.Effect<Option.Option<AccountRecord>, StoreUnavailable>;
  readonly listByUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<AccountRecord>, StoreUnavailable>;
  /**
   * BE-002: `OAuthTokenAccess.withAccessToken` (`@awthaq/oauth`) is the
   * first caller that needs an account's own `providerId` given only an
   * `AccountId` — a token refresh must call back to the *same* provider
   * the tokens came from, and nothing else on this shape exposes that
   * lookup direction (`findByProviderSubject` needs the provider/subject
   * to find the id, not the other way around).
   */
  readonly findById: (
    id: AccountId,
  ) => Effect.Effect<AccountRecord, AccountNotFound | StoreUnavailable>;
  /** BEH-EA-044: reads back a credential hash `link` stored, if any. */
  readonly findCredentialHash: (
    id: AccountId,
  ) => Effect.Effect<
    Option.Option<Redacted.Redacted<PasswordHasher.PhcHash>>,
    AccountNotFound | StoreUnavailable
  >;
  /** BEH-EA-116: rehash-on-login writes a fresh hash for the same row. */
  readonly updateCredentialHash: (
    id: AccountId,
    hash: Redacted.Redacted<PasswordHasher.PhcHash>,
  ) => Effect.Effect<void, AccountNotFound | StoreUnavailable>;
  /**
   * BE-002: reads back the token set `link`'s own `tokens` stored, if any
   * — `None` for a `password` account, a provider `@awthaq/oauth` never
   * captured tokens for, or a link predating this capability.
   */
  readonly findProviderTokens: (
    id: AccountId,
  ) => Effect.Effect<
    Option.Option<ProviderTokenSet>,
    AccountNotFound | ProviderTokensUnreadable | StoreUnavailable
  >;
  /**
   * BE-002: every successful OAuth sign-in against an already-linked
   * account writes a fresh token set here — the re-authentication branch
   * `@awthaq/oauth`'s callback handler otherwise silently discarded a
   * rotated access token on. Mirrors `updateCredentialHash`'s own
   * "same row, fresh secret" shape exactly.
   */
  readonly updateProviderTokens: (
    id: AccountId,
    tokens: ProviderTokenSet,
  ) => Effect.Effect<void, AccountNotFound | StoreUnavailable>;
  /** BEH-EA-045: refused when `id` is the user's only remaining Account. */
  readonly unlink: (
    id: AccountId,
  ) => Effect.Effect<void, AccountNotFound | LastAccountRefusal | StoreUnavailable>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 09/10: whole-user
   * deletion's own cascade — deliberately bypasses `unlink`'s last-account
   * refusal, which exists to stop a user locking themselves out of an
   * *otherwise-still-existing* account, not to block deleting the account
   * entirely along with the user it belongs to.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void, StoreUnavailable>;
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()("awthaq/core/Accounts") {}

/** BEH-EA-043: `""` is "no issuer" in the unique key; the record says `None`. */
const toRecord = (identity: AccountStore.AccountIdentity): AccountRecord => ({
  id: AccountId(identity.id),
  userId: UserId(identity.userId),
  providerId: identity.providerId,
  subject: identity.subject,
  issuer: identity.issuer === "" ? Option.none() : Option.some(identity.issuer),
  createdAt: identity.createdAt,
  updatedAt: identity.updatedAt,
});

/**
 * Written once over `AccountStore` (ADR-EA-041). Needs the store and `Crypto` (the id); the clock is
 * read once per operation and handed to the store, so a row never carries two instants.
 */
export const layer = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const store = yield* AccountStore.AccountStore;
    const crypto = yield* Crypto.Crypto;
    const policyNow = Tenant.configInForce(AccountsPolicy, yield* AccountsPolicy);

    const notFound = (id: AccountId) =>
      new AccountNotFound({ message: "awthaq: no such account", id });

    const link: AccountsShape["link"] = Effect.fnUntraced(
      function* (input) {
        const id = AccountId(yield* crypto.randomUUIDv7);
        const now = yield* DateTime.now;
        const stored = yield* store.insertIfAbsent({
          id,
          userId: input.userId,
          providerId: input.providerId,
          subject: input.subject,
          issuer: input.issuer ?? "",
          credentialHash: Option.fromNullishOr(input.credentialHash),
          tokens: Option.fromNullishOr(input.tokens),
          createdAt: now,
          updatedAt: now,
        });
        // BEH-EA-043: `(providerId, subject, issuer)` is unique; the store says the key is taken.
        if (Option.isNone(stored)) {
          return yield* new AccountAlreadyLinked({
            message: "awthaq: account already linked",
            providerId: input.providerId,
            subject: input.subject,
          });
        }
        return toRecord(stored.value);
      },
      Effect.catchTag("PlatformError", storeUnavailable("Accounts.link")),
      relabel("Accounts.link"),
    );

    const findByProviderSubject: AccountsShape["findByProviderSubject"] = (
      providerId,
      subject,
      issuer,
    ) =>
      store
        .getByKey(providerId, subject, issuer ?? "")
        .pipe(Effect.map(Option.map(toRecord)), relabel("Accounts.findByProviderSubject"));

    const listByUser: AccountsShape["listByUser"] = (userId) =>
      store.listByUser(userId).pipe(
        Effect.map((identities) => identities.map(toRecord)),
        relabel("Accounts.listByUser"),
      );

    const findById: AccountsShape["findById"] = (id) =>
      store.get(id).pipe(
        relabel("Accounts.findById"),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound(id)),
            onSome: (identity) => Effect.succeed(toRecord(identity)),
          }),
        ),
      );

    const unlink: AccountsShape["unlink"] = Effect.fnUntraced(function* (id) {
      const policy = yield* policyNow;
      const outcome = yield* store.deleteUnlessLast(id, policy.allowZeroAccounts);
      switch (outcome._tag) {
        case "Deleted":
          return;
        case "NotFound":
          return yield* notFound(id);
        case "LastAccount":
          return yield* new LastAccountRefusal({
            message: "awthaq: refusing to unlink the last account",
            userId: UserId(outcome.userId),
          });
      }
    }, relabel("Accounts.unlink"));

    const deleteAllByUser: AccountsShape["deleteAllByUser"] = (userId) =>
      store.deleteByUser(userId).pipe(Effect.asVoid, relabel("Accounts.deleteAllByUser"));

    const findCredentialHash: AccountsShape["findCredentialHash"] = (id) =>
      store.readCredentialHash(id).pipe(
        relabel("Accounts.findCredentialHash"),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(notFound(id)),
            // TTE-005: the trust boundary — a stored column is a `PhcHash` by construction, since
            // only `Accounts.link`/`updateCredentialHash` write it.
            onSome: (hash) =>
              Effect.succeed(
                Option.map(hash, (stored) =>
                  Redacted.make(PasswordHasher.PhcHash(Redacted.value(stored))),
                ),
              ),
          }),
        ),
      );

    // SMS-002: a targeted write of the hash. It neither reads nor rewrites the token columns, so an
    // undecryptable token can never make a password change fail (or be silently wiped).
    const updateCredentialHash: AccountsShape["updateCredentialHash"] = Effect.fnUntraced(
      function* (id, hash) {
        const now = yield* DateTime.now;
        const written = yield* store.writeCredentialHash(id, hash, now);
        if (!written) return yield* notFound(id);
      },
      relabel("Accounts.updateCredentialHash"),
    );

    const findProviderTokens: AccountsShape["findProviderTokens"] = Effect.fnUntraced(function* (
      id,
    ) {
      const read = yield* store.readProviderTokens(id);
      if (Option.isNone(read)) return yield* notFound(id);
      if (read.value._tag === "Undecryptable") {
        return yield* new ProviderTokensUnreadable({
          id,
          field: read.value.field,
          reason: read.value.reason,
        });
      }
      return read.value.tokens;
    }, relabel("Accounts.findProviderTokens"));

    // SMS-002/RRS-006: a targeted write of the whole token group; the store reads no old token.
    const updateProviderTokens: AccountsShape["updateProviderTokens"] = Effect.fnUntraced(
      function* (id, tokens) {
        const now = yield* DateTime.now;
        const written = yield* store.writeProviderTokens(id, tokens, now);
        if (!written) return yield* notFound(id);
      },
      relabel("Accounts.updateProviderTokens"),
    );

    return {
      link,
      findByProviderSubject,
      listByUser,
      findById,
      findCredentialHash,
      updateCredentialHash,
      findProviderTokens,
      updateProviderTokens,
      unlink,
      deleteAllByUser,
    };
  }),
);
