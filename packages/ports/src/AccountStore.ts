// @awthaq/ports — AccountStore
//
// Plan 02 (ADR-EA-041): the store port under `Accounts`. `Accounts` (core) owns every domain rule:
// the uniqueness error, the issuer convention, the last-account policy, the credential-hash brand,
// the id and the clock. This port owns only persistence, and every primitive is atomic by contract,
// on every adapter (`StoreContract.accounts`).
//
// Two things the port makes true that the two layers it replaces did not:
// - An identity read (`get`, `getByKey`, `listByUser`) never touches a provider token: no decryption,
//   no lazy re-encryption write. The sign-in hot path reads identities; tokens are read only by
//   `readProviderTokens`, the one strict path (BEH-EA-125).
// - `deleteUnlessLast` is atomic against a concurrent unlink of a sibling (BEH-EA-045), including on
//   Postgres' default isolation.
//
// The tokens and the credential hash cross the seam as plaintext (`Redacted`): an adapter that
// stores them encrypted (SQL, `Encryption`) encrypts and decrypts them itself.
//
// The `Ref` adapter here is single-process and test-grade (TRBS-005). Production composes the SQL
// adapter (`@awthaq/sql` `AccountStoreSql`) through `Persistence.sql()`.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { AccountId, UserId } from "./Ids.ts";
import type { StoreUnavailable } from "./Store.ts";
import * as Tenant from "./Tenant.ts";

/** The identity of a linked account: everything an ordinary read may carry, never a secret. */
export interface AccountIdentity {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly providerId: string;
  readonly subject: string;
  /** `""` is "no issuer" (BEH-EA-043: the third component of the unique key; the domain maps it to `None`). */
  readonly issuer: string;
  /** Stamped by the adapter from the ambient tenant (BEH-EA-231). */
  readonly tenantId: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/** BE-002/BAM-008: a federated provider's exchanged tokens, plaintext at this seam. */
export interface ProviderTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken: Option.Option<Redacted.Redacted<string>>;
  readonly idToken: Option.Option<Redacted.Redacted<string>>;
  readonly accessTokenExpiresAt: Option.Option<DateTime.Utc>;
  readonly refreshTokenExpiresAt: Option.Option<DateTime.Utc>;
  readonly scope: Option.Option<string>;
  readonly tokenType: Option.Option<string>;
}

/** What `insertIfAbsent` writes. The domain mints the id and reads the clock once. */
export interface NewAccount {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly providerId: string;
  readonly subject: string;
  readonly issuer: string;
  readonly credentialHash: Option.Option<Redacted.Redacted<string>>;
  readonly tokens: Option.Option<ProviderTokens>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export type TokensRead =
  | { readonly _tag: "Tokens"; readonly tokens: Option.Option<ProviderTokens> }
  /** SMS-002: the stored tokens cannot be decrypted (a retired key, a corrupt ciphertext). Only an adapter that encrypts can answer this. */
  | {
      readonly _tag: "Undecryptable";
      readonly field: "accessToken" | "refreshToken" | "idToken";
      readonly reason: "DecryptionFailed" | "UnknownKeyId";
    };

export type DeleteOutcome =
  | { readonly _tag: "Deleted" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "LastAccount"; readonly userId: UserId };

export interface AccountStoreShape {
  /**
   * ATOMIC on `(providerId, subject, issuer)` (BEH-EA-043): `Some` with the stored identity, or
   * `None` when the key is taken. Never fails with a unique violation and never aborts an enclosing
   * Postgres transaction. Stamps the ambient tenant. Encrypts the tokens where the adapter does.
   */
  readonly insertIfAbsent: (
    row: NewAccount,
  ) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>;
  /** An identity read: no decryption of any token, no write on the read path. */
  readonly getByKey: (
    providerId: string,
    subject: string,
    issuer: string,
  ) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>;
  /** An identity read (see `getByKey`). */
  readonly get: (id: AccountId) => Effect.Effect<Option.Option<AccountIdentity>, StoreUnavailable>;
  /** An identity read (see `getByKey`), ordered by `(createdAt, id)` (BEH-EA-036). */
  readonly listByUser: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<AccountIdentity>, StoreUnavailable>;
  /** BEH-EA-044: the stored credential hash. Outer `None` = no such account; inner `None` = the account has none. Reads no token. */
  readonly readCredentialHash: (
    id: AccountId,
  ) => Effect.Effect<Option.Option<Option.Option<Redacted.Redacted<string>>>, StoreUnavailable>;
  /** The strict token read (BE-002). `None` = no such account. A lazy re-encryption write is allowed here. */
  readonly readProviderTokens: (
    id: AccountId,
  ) => Effect.Effect<Option.Option<TokensRead>, StoreUnavailable>;
  /** BEH-EA-116: replaces the credential hash and sets `updatedAt = at`. `false` = no such account. Never reads a token. */
  readonly writeCredentialHash: (
    id: AccountId,
    hash: Redacted.Redacted<string>,
    at: DateTime.Utc,
  ) => Effect.Effect<boolean, StoreUnavailable>;
  /** SMS-002: replaces the whole token group (never reading the old one, so an undecryptable row heals) and sets `updatedAt = at`. `false` = no such account. */
  readonly writeProviderTokens: (
    id: AccountId,
    tokens: ProviderTokens,
    at: DateTime.Utc,
  ) => Effect.Effect<boolean, StoreUnavailable>;
  /**
   * ATOMIC against a concurrent delete of a sibling (BEH-EA-045): deletes `id` unless it is its
   * user's last account and `allowZero` is false (`LastAccount`). Two concurrent calls for two
   * different accounts of a user with two accounts leave exactly one. SQL: one transaction that
   * locks the user's account rows first (Postgres `FOR UPDATE`; SQLite and libSQL's drivers already
   * open the transaction as a write transaction).
   */
  readonly deleteUnlessLast: (
    id: AccountId,
    allowZero: boolean,
  ) => Effect.Effect<DeleteOutcome, StoreUnavailable>;
  /** Whole-user deletion's cascade: bypasses the last-account rule. Resolves to how many went. */
  readonly deleteByUser: (userId: UserId) => Effect.Effect<number, StoreUnavailable>;
}

export class AccountStore extends Context.Service<AccountStore, AccountStoreShape>()(
  "awthaq/ports/AccountStore",
) {}

// ---- the pure contract helpers every adapter and the domain share ---------------------------

/** `(createdAt, id)` ascending, the order `listByUser` answers in. */
export const byCreation = (a: AccountIdentity, b: AccountIdentity): number =>
  DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---- the Ref adapter ------------------------------------------------------------------------

interface StoredAccount {
  readonly identity: AccountIdentity;
  /** Kept out of `AccountIdentity` itself, like the SQL columns an identity read never selects. */
  readonly credentialHash: Option.Option<Redacted.Redacted<string>>;
  readonly tokens: Option.Option<ProviderTokens>;
}

interface State {
  readonly byId: HashMap.HashMap<AccountId, StoredAccount>;
  readonly byKey: HashMap.HashMap<string, AccountId>;
}

/**
 * BEH-EA-125: `issuer` folds into the key itself (`""` when absent), never left out of the string:
 * a plain `providerId:subject` key would silently reunify two OIDC accounts that differ by issuer.
 * The parts are length-prefixed, so no value of one part can run into the next.
 */
const keyOf = (providerId: string, subject: string, issuer: string): string =>
  `${providerId.length}:${providerId}${subject.length}:${subject}${issuer}`;

const emptyState: State = { byId: HashMap.empty(), byKey: HashMap.empty() };

/** Single-process, test-grade (TRBS-005). Each primitive is one `Ref.modify`, so every one is atomic. */
export const layerMemory = Layer.effect(
  AccountStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);

    const insertIfAbsent: AccountStoreShape["insertIfAbsent"] = (row) =>
      Effect.flatMap(Tenant.resolve(Option.none()), (tenantId) => {
        const identity: AccountIdentity = {
          id: row.id,
          userId: row.userId,
          providerId: row.providerId,
          subject: row.subject,
          issuer: row.issuer,
          tenantId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        const key = keyOf(row.providerId, row.subject, row.issuer);
        return Ref.modify(state, (s) =>
          HashMap.has(s.byKey, key)
            ? [Option.none<AccountIdentity>(), s]
            : [
                Option.some(identity),
                {
                  byId: HashMap.set(s.byId, row.id, {
                    identity,
                    credentialHash: row.credentialHash,
                    tokens: row.tokens,
                  }),
                  byKey: HashMap.set(s.byKey, key, row.id),
                },
              ],
        );
      });

    const get: AccountStoreShape["get"] = (id) =>
      Effect.map(Ref.get(state), (s) =>
        Option.map(HashMap.get(s.byId, id), (stored) => stored.identity),
      );

    const getByKey: AccountStoreShape["getByKey"] = (providerId, subject, issuer) =>
      Effect.map(Ref.get(state), (s) =>
        Option.flatMap(HashMap.get(s.byKey, keyOf(providerId, subject, issuer)), (id) =>
          Option.map(HashMap.get(s.byId, id), (stored) => stored.identity),
        ),
      );

    const listByUser: AccountStoreShape["listByUser"] = (userId) =>
      Effect.map(Ref.get(state), (s) =>
        Array.from(HashMap.values(s.byId), (stored) => stored.identity)
          .filter((identity) => identity.userId === userId)
          .sort(byCreation),
      );

    const readCredentialHash: AccountStoreShape["readCredentialHash"] = (id) =>
      Effect.map(Ref.get(state), (s) =>
        Option.map(HashMap.get(s.byId, id), (stored) => stored.credentialHash),
      );

    const readProviderTokens: AccountStoreShape["readProviderTokens"] = (id) =>
      Effect.map(Ref.get(state), (s) =>
        Option.map(HashMap.get(s.byId, id), (stored): TokensRead => ({
          _tag: "Tokens",
          tokens: stored.tokens,
        })),
      );

    const update =
      (id: AccountId, change: (stored: StoredAccount) => StoredAccount) =>
      (s: State): readonly [boolean, State] => {
        const stored = HashMap.get(s.byId, id);
        return Option.isNone(stored)
          ? [false, s]
          : [true, { ...s, byId: HashMap.set(s.byId, id, change(stored.value)) }];
      };

    const writeCredentialHash: AccountStoreShape["writeCredentialHash"] = (id, hash, at) =>
      Ref.modify(
        state,
        update(id, (stored) => ({
          ...stored,
          credentialHash: Option.some(hash),
          identity: { ...stored.identity, updatedAt: at },
        })),
      );

    const writeProviderTokens: AccountStoreShape["writeProviderTokens"] = (id, tokens, at) =>
      Ref.modify(
        state,
        update(id, (stored) => ({
          ...stored,
          tokens: Option.some(tokens),
          identity: { ...stored.identity, updatedAt: at },
        })),
      );

    const removeFrom = (s: State, stored: StoredAccount): State => ({
      byId: HashMap.remove(s.byId, stored.identity.id),
      byKey: HashMap.remove(
        s.byKey,
        keyOf(stored.identity.providerId, stored.identity.subject, stored.identity.issuer),
      ),
    });

    const deleteUnlessLast: AccountStoreShape["deleteUnlessLast"] = (id, allowZero) =>
      Ref.modify(state, (s): readonly [DeleteOutcome, State] => {
        const stored = HashMap.get(s.byId, id);
        if (Option.isNone(stored)) return [{ _tag: "NotFound" }, s];
        const siblings = Array.from(HashMap.values(s.byId)).filter(
          (other) => other.identity.userId === stored.value.identity.userId,
        ).length;
        if (siblings <= 1 && !allowZero) {
          return [{ _tag: "LastAccount", userId: stored.value.identity.userId }, s];
        }
        return [{ _tag: "Deleted" }, removeFrom(s, stored.value)];
      });

    const deleteByUser: AccountStoreShape["deleteByUser"] = (userId) =>
      Ref.modify(state, (s) => {
        const doomed = Array.from(HashMap.values(s.byId)).filter(
          (stored) => stored.identity.userId === userId,
        );
        return [doomed.length, doomed.reduce(removeFrom, s)];
      });

    return AccountStore.of({
      insertIfAbsent,
      getByKey,
      get,
      listByUser,
      readCredentialHash,
      readProviderTokens,
      writeCredentialHash,
      writeProviderTokens,
      deleteUnlessLast,
      deleteByUser,
    });
  }),
);
