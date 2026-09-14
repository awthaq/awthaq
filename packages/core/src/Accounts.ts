// @awthaq/core — Accounts
//
// spec/behaviors/06-domain-users-accounts.md, BEH-EA-043 through BEH-EA-045,
// BEH-EA-047. Two `Layer`s over the same `AccountsShape`: `layerMemory` (a
// `Ref`) and `layerSql` (`@awthaq/sql`'s `Model.Class`/repository,
// BEH-EA-033–036) — neither changes this service's public interface, the
// same deferral `Migrations.ts` documents for the persistence stratum
// generally.

import { Models as SqlModels, Repositories as SqlRepositories } from "@awthaq/sql";
import * as Brand from "effect/Brand";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { UserId } from "./Users.ts";

export type AccountId = string & Brand.Brand<"AccountId">;
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

export interface AccountsShape {
  /**
   * BEH-EA-043: `(providerId, subject)` is a schema-level-equivalent unique
   * constraint here. `credentialHash` is BEH-EA-044's password-credential
   * case (`providerId = "password"`) — an already-hashed secret
   * (`@awthaq/password`'s own `PasswordHasher` port produced it; this
   * service never hashes anything itself), stored alongside the row and
   * deliberately kept out of `AccountRecord` so an ordinary "list my linked
   * accounts" read never carries a hash it doesn't need.
   */
  readonly link: (input: {
    readonly userId: UserId;
    readonly providerId: string;
    readonly subject: string;
    /** BEH-EA-125: omitted for a non-federated provider (`password`); see `AccountRecord.issuer`. */
    readonly issuer?: string;
    readonly credentialHash?: Redacted.Redacted<string>;
  }) => Effect.Effect<AccountRecord, AccountAlreadyLinked | PlatformError.PlatformError>;
  readonly findByProviderSubject: (
    providerId: string,
    subject: string,
    issuer?: string,
  ) => Effect.Effect<Option.Option<AccountRecord>>;
  readonly listByUser: (userId: UserId) => Effect.Effect<ReadonlyArray<AccountRecord>>;
  /** BEH-EA-044: reads back a credential hash `link` stored, if any. */
  readonly findCredentialHash: (
    id: AccountId,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, AccountNotFound>;
  /** BEH-EA-116: rehash-on-login writes a fresh hash for the same row. */
  readonly updateCredentialHash: (
    id: AccountId,
    hash: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AccountNotFound>;
  /** BEH-EA-045: refused when `id` is the user's only remaining Account. */
  readonly unlink: (id: AccountId) => Effect.Effect<void, AccountNotFound | LastAccountRefusal>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 09/10: whole-user
   * deletion's own cascade — deliberately bypasses `unlink`'s last-account
   * refusal, which exists to stop a user locking themselves out of an
   * *otherwise-still-existing* account, not to block deleting the account
   * entirely along with the user it belongs to.
   */
  readonly deleteAllByUser: (userId: UserId) => Effect.Effect<void>;
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()("awthaq/core/Accounts") {}

interface State {
  readonly byId: HashMap.HashMap<AccountId, AccountRecord>;
  readonly byProviderSubject: HashMap.HashMap<string, AccountId>;
  /** Kept out of `AccountRecord` itself — see `AccountsShape.link`'s own comment. */
  readonly credentialHashes: HashMap.HashMap<AccountId, Redacted.Redacted<string>>;
}

/**
 * BEH-EA-125: `issuer` folds into the key itself, normalized to `""` when
 * absent (rather than left out of the string) — a plain `providerId:subject`
 * key would silently reunify two OIDC accounts that only differ by issuer.
 */
const providerSubjectKey = (providerId: string, subject: string, issuer?: string): string =>
  `${providerId}:${subject}:${issuer ?? ""}`;

const emptyState: State = {
  byId: HashMap.empty(),
  byProviderSubject: HashMap.empty(),
  credentialHashes: HashMap.empty(),
};

export const layerMemory: Layer.Layer<Accounts, never, Crypto.Crypto> = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const crypto = yield* Crypto.Crypto;

    const link: AccountsShape["link"] = Effect.fnUntraced(function* (input) {
      const key = providerSubjectKey(input.providerId, input.subject, input.issuer);
      const id = AccountId(yield* crypto.randomUUIDv7);
      const now = yield* DateTime.now;
      const record: AccountRecord = {
        id,
        userId: input.userId,
        providerId: input.providerId,
        subject: input.subject,
        issuer: input.issuer === undefined ? Option.none() : Option.some(input.issuer),
        createdAt: now,
        updatedAt: now,
      };
      const outcome = yield* Ref.modify(
        state,
        (s): readonly [Result.Result<AccountRecord, AccountAlreadyLinked>, State] => {
          if (HashMap.has(s.byProviderSubject, key)) {
            return [
              Result.fail(
                new AccountAlreadyLinked({
                  message: `awthaq: account already linked: ${key}`,
                  providerId: input.providerId,
                  subject: input.subject,
                }),
              ),
              s,
            ] as const;
          }
          return [
            Result.succeed(record),
            {
              byId: HashMap.set(s.byId, id, record),
              byProviderSubject: HashMap.set(s.byProviderSubject, key, id),
              credentialHashes:
                input.credentialHash === undefined
                  ? s.credentialHashes
                  : HashMap.set(s.credentialHashes, id, input.credentialHash),
            },
          ] as const;
        },
      );
      return yield* Effect.fromResult(outcome);
    });

    const findByProviderSubject: AccountsShape["findByProviderSubject"] = (
      providerId,
      subject,
      issuer,
    ) =>
      Ref.get(state).pipe(
        Effect.map((s) => {
          const id = HashMap.get(
            s.byProviderSubject,
            providerSubjectKey(providerId, subject, issuer),
          );
          return Option.flatMap(id, (accountId) => HashMap.get(s.byId, accountId));
        }),
      );

    const listByUser: AccountsShape["listByUser"] = (userId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s.byId)).filter((row) => row.userId === userId),
        ),
      );

    const unlink: AccountsShape["unlink"] = (id) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<void, AccountNotFound | LastAccountRefusal>, State] => {
          const existing = HashMap.get(s.byId, id);
          if (Option.isNone(existing)) {
            return [
              Result.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
              s,
            ] as const;
          }
          const siblingCount = Array.from(HashMap.values(s.byId)).filter(
            (row) => row.userId === existing.value.userId,
          ).length;
          if (siblingCount <= 1) {
            return [
              Result.fail(
                new LastAccountRefusal({
                  message: `awthaq: refusing to unlink the last account for user ${existing.value.userId}`,
                  userId: existing.value.userId,
                }),
              ),
              s,
            ] as const;
          }
          const key = providerSubjectKey(
            existing.value.providerId,
            existing.value.subject,
            Option.getOrUndefined(existing.value.issuer),
          );
          const ok: Result.Result<void, AccountNotFound | LastAccountRefusal> =
            Result.succeed(undefined);
          return [
            ok,
            {
              byId: HashMap.remove(s.byId, id),
              byProviderSubject: HashMap.remove(s.byProviderSubject, key),
              credentialHashes: HashMap.remove(s.credentialHashes, id),
            },
          ] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const findCredentialHash: AccountsShape["findCredentialHash"] = (id) =>
      Ref.get(state).pipe(
        Effect.flatMap((s) =>
          HashMap.has(s.byId, id)
            ? Effect.succeed(HashMap.get(s.credentialHashes, id))
            : Effect.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
        ),
      );

    const updateCredentialHash: AccountsShape["updateCredentialHash"] = (id, hash) =>
      Ref.modify(state, (s): readonly [Result.Result<void, AccountNotFound>, State] => {
        if (!HashMap.has(s.byId, id)) {
          return [
            Result.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
            s,
          ] as const;
        }
        return [
          Result.succeed(undefined),
          { ...s, credentialHashes: HashMap.set(s.credentialHashes, id, hash) },
        ] as const;
      }).pipe(Effect.flatMap(Effect.fromResult));

    const deleteAllByUser: AccountsShape["deleteAllByUser"] = (userId) =>
      Ref.update(state, (s) => {
        const toRemove = Array.from(HashMap.values(s.byId)).filter((row) => row.userId === userId);
        let byId = s.byId;
        let byProviderSubject = s.byProviderSubject;
        let credentialHashes = s.credentialHashes;
        for (const row of toRemove) {
          byId = HashMap.remove(byId, row.id);
          byProviderSubject = HashMap.remove(
            byProviderSubject,
            providerSubjectKey(row.providerId, row.subject, Option.getOrUndefined(row.issuer)),
          );
          credentialHashes = HashMap.remove(credentialHashes, row.id);
        }
        return { byId, byProviderSubject, credentialHashes };
      });

    return {
      link,
      findByProviderSubject,
      listByUser,
      findCredentialHash,
      updateCredentialHash,
      unlink,
      deleteAllByUser,
    };
  }),
);

const toAccountRecord = (row: SqlModels.Account): AccountRecord => ({
  id: AccountId(row.id),
  userId: UserId(row.userId),
  providerId: row.providerId,
  subject: row.subject,
  issuer: row.issuer === "" ? Option.none() : Option.some(row.issuer),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * BEH-EA-043's `(providerId, subject)` uniqueness is a real `UNIQUE`
 * constraint here (declared alongside the `accounts` table), surfacing as
 * `SqlError`'s `UniqueViolation` reason on a duplicate `link` — the same
 * shape `Users.layerSql`'s `EmailAlreadyExists` detection uses.
 * BEH-EA-045's last-credential refusal reads the sibling count and deletes
 * inside one `sql.withTransaction`, so a concurrent second `unlink` racing
 * against the first cannot both observe "not the last one" and both
 * succeed (BEH-EA-035: the domain service holds this transaction
 * boundary, not the repository).
 */
export const layerSql: Layer.Layer<
  Accounts,
  never,
  SqlRepositories.AccountsRepository | SqlClient.SqlClient
> = Layer.effect(
  Accounts,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.AccountsRepository;
    const sql = yield* SqlClient.SqlClient;

    const link: AccountsShape["link"] = Effect.fnUntraced(function* (input) {
      const insert = yield* SqlModels.Account.insert
        .makeEffect({
          userId: input.userId,
          providerId: input.providerId,
          subject: input.subject,
          issuer: input.issuer ?? "",
          passwordHash:
            input.credentialHash === undefined ? null : Redacted.value(input.credentialHash),
          accessToken: null,
          refreshToken: null,
        })
        .pipe(Effect.orDie);
      const row = yield* repo.insert(insert).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(
                new AccountAlreadyLinked({
                  message: `awthaq: account already linked: ${input.providerId}:${input.subject}`,
                  providerId: input.providerId,
                  subject: input.subject,
                }),
              )
            : Effect.die(error),
        ),
        Effect.catchTag("SchemaError", Effect.die),
      );
      return toAccountRecord(row);
    });

    const findByProviderSubject: AccountsShape["findByProviderSubject"] = (
      providerId,
      subject,
      issuer,
    ) =>
      repo
        .findByProviderSubject(providerId, subject, issuer ?? "")
        .pipe(Effect.map(Option.map(toAccountRecord)), Effect.orDie);

    const listByUser: AccountsShape["listByUser"] = (userId) =>
      repo.listByUser(userId).pipe(
        Effect.map((rows) => rows.map(toAccountRecord)),
        Effect.orDie,
      );

    const performUnlink = Effect.fnUntraced(function* (id: AccountId) {
      const account = yield* repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      );
      const siblings = yield* repo.listByUser(account.userId).pipe(Effect.orDie);
      if (siblings.length <= 1) {
        return yield* Effect.fail(
          new LastAccountRefusal({
            message: `awthaq: refusing to unlink the last account for user ${account.userId}`,
            userId: UserId(account.userId),
          }),
        );
      }
      yield* repo.delete(id).pipe(Effect.orDie);
    });

    const unlink: AccountsShape["unlink"] = (id) =>
      sql.withTransaction(performUnlink(id)).pipe(Effect.catchTag("SqlError", Effect.die));

    const deleteAllByUser: AccountsShape["deleteAllByUser"] = (userId) =>
      repo.deleteAllByUser(userId).pipe(Effect.orDie);

    const findCredentialHash: AccountsShape["findCredentialHash"] = (id) =>
      repo.findById(id).pipe(
        Effect.catchTags({
          NoSuchElementError: () =>
            Effect.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
        Effect.map((row) => Option.fromNullOr(row.passwordHash).pipe(Option.map(Redacted.make))),
      );

    // `passwordHash`/`accessToken`/`refreshToken` are all `Model.Sensitive`,
    // included together in the generic `update` (only the non-sensitive
    // identity fields are `FieldExcept`-excluded) — so writing a fresh
    // `passwordHash` still has to read the row first and pass the other two
    // straight through, the same pattern `Users.layerSql.updateProfile` uses
    // for `email`.
    const updateCredentialHash: AccountsShape["updateCredentialHash"] = Effect.fnUntraced(
      function* (id, hash) {
        const existing = yield* repo.findById(id).pipe(
          Effect.catchTags({
            NoSuchElementError: () =>
              Effect.fail(new AccountNotFound({ message: `awthaq: no such account: ${id}`, id })),
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
        );
        const update = yield* SqlModels.Account.update
          .makeEffect({
            id,
            passwordHash: Redacted.value(hash),
            accessToken: existing.accessToken,
            refreshToken: existing.refreshToken,
          })
          .pipe(Effect.orDie);
        yield* repo.update(update).pipe(Effect.orDie);
      },
    );

    return {
      link,
      findByProviderSubject,
      listByUser,
      findCredentialHash,
      updateCredentialHash,
      unlink,
      deleteAllByUser,
    };
  }),
);
