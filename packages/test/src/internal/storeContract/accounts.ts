// @awthaq/test — the accounts suite of StoreContract (plan 37)
import assert from "node:assert/strict";
import { AccountStore, Ids, Sealed, SqlTransaction, Tenant } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CONCURRENCY } from "../contract.ts";
import { at, makeUserId } from "./fixtures.ts";
import { suite } from "./suite.ts";

const makeAccountId = Schema.decodeUnknownSync(Ids.AccountId);

const newAccount = (
  id: string,
  userId: string,
  options: {
    readonly providerId?: string;
    readonly subject?: string;
    readonly issuer?: string;
    readonly minutes?: number;
    readonly credentialHash?: string;
    readonly tokens?: AccountStore.ProviderTokens;
  } = {},
): AccountStore.NewAccount => ({
  id: makeAccountId(id),
  userId: makeUserId(userId),
  providerId: options.providerId ?? "github",
  subject: options.subject ?? `subject-${id}`,
  issuer: options.issuer ?? "",
  credentialHash: Option.map(Option.fromNullishOr(options.credentialHash), Redacted.make),
  tokens: Option.fromNullishOr(options.tokens),
  createdAt: at(options.minutes ?? 0),
  updatedAt: at(options.minutes ?? 0),
});

const sampleTokens: AccountStore.ProviderTokens = {
  accessToken: Redacted.make("access-1"),
  refreshToken: Option.some(Redacted.make("refresh-1")),
  idToken: Option.some(Redacted.make("id-1")),
  accessTokenExpiresAt: Option.some(at(60)),
  refreshTokenExpiresAt: Option.some(at(600)),
  scope: Option.some("openid email"),
  tokenType: Option.some("Bearer"),
};

/** The stored token set opened to plaintext tokens (plan 17: `readProviderTokens` hands them over sealed). */
const openTokens = (sealed: AccountStore.SealedProviderTokens) =>
  Effect.all({
    accessToken: sealed.accessToken.open,
    refreshToken: Sealed.openOption(sealed.refreshToken),
    idToken: Sealed.openOption(sealed.idToken),
  }).pipe(Effect.map((opened) => ({ ...sealed, ...opened })));

const accountIds = (rows: ReadonlyArray<AccountStore.AccountIdentity>) => rows.map((row) => row.id);

/** The `AccountStore` contract (plan 02, ADR-EA-041; BEH-EA-043 to 045, BEH-EA-125, BE-002, SMS-002). */
export const accounts = suite<
  AccountStore.AccountStore,
  AccountStore.AccountStoreShape,
  SqlTransaction.SqlTransaction
>(AccountStore.AccountStore, {
  operations: {
    insertIfAbsent: {
      atomic: [
        {
          name: "insertIfAbsent stores the identity and stamps the ambient tenant",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            const stored = yield* Tenant.withTenant("tenant-a")(
              store.insertIfAbsent(
                newAccount("a1", "u1", {
                  providerId: "google",
                  subject: "sub-1",
                  issuer: "https://iss",
                }),
              ),
            );
            assert.equal(Option.isSome(stored), true);
            const identity = Option.getOrThrow(stored);
            assert.equal(identity.id, "a1");
            assert.equal(identity.providerId, "google");
            assert.equal(identity.issuer, "https://iss");
            assert.deepEqual(identity.tenantId, Option.some("tenant-a"));
            assert.deepEqual(identity.createdAt, at(0));
          }),
        },
        {
          // Plan 27: `PasswordCredential`'s write re-reads after a lost link race inside its caller's
          // transaction, so a refused insert must not abort that transaction (Postgres would otherwise
          // fail every later statement in it).
          name: "insertIfAbsent that loses a race inside an enclosing transaction leaves it usable",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            const transaction = yield* SqlTransaction.SqlTransaction;
            // Any provider: the conflict is on (providerId, subject), the password one included.
            const key = { providerId: "gitlab", subject: "u1" };
            yield* store.insertIfAbsent(newAccount("a1", "u1", key));
            yield* transaction.withTransaction(
              Effect.gen(function* () {
                assert.equal(
                  Option.isNone(yield* store.insertIfAbsent(newAccount("a2", "u1", key))),
                  true,
                );
                // A statement after the refused insert still runs: the transaction was not aborted.
                assert.equal(Option.isSome(yield* store.getByKey("gitlab", "u1", "")), true);
                assert.equal(
                  Option.isSome(
                    yield* store.insertIfAbsent(
                      newAccount("a3", "u1", { providerId: "github", subject: "g" }),
                    ),
                  ),
                  true,
                );
              }),
            );
            assert.equal(Option.isSome(yield* store.getByKey("github", "g", "")), true);
          }),
        },
        {
          name: "insertIfAbsent is exclusive per (providerId, subject, issuer); a different issuer is a different account",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            const base = { providerId: "google", subject: "sub-1" };
            assert.equal(
              Option.isSome(yield* store.insertIfAbsent(newAccount("a1", "u1", base))),
              true,
            );
            // Taken: same key, whoever the user.
            assert.equal(
              Option.isNone(yield* store.insertIfAbsent(newAccount("a2", "u2", base))),
              true,
            );
            // Another issuer, another provider, another subject: all free.
            assert.equal(
              Option.isSome(
                yield* store.insertIfAbsent(
                  newAccount("a3", "u1", { ...base, issuer: "https://other" }),
                ),
              ),
              true,
            );
            assert.equal(
              Option.isSome(
                yield* store.insertIfAbsent(
                  newAccount("a4", "u1", { ...base, providerId: "github" }),
                ),
              ),
              true,
            );
            assert.equal(
              Option.isSome(
                yield* store.insertIfAbsent(newAccount("a5", "u1", { ...base, subject: "sub-2" })),
              ),
              true,
            );
            // The failed insert left nothing behind: the first row is still the holder.
            const holder = yield* store.getByKey("google", "sub-1", "");
            assert.equal(Option.getOrThrow(holder).id, "a1");
          }),
        },
      ],
      race: [
        {
          name: "insertIfAbsent under concurrency: exactly one of 8 racing inserts of one key is Some",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            const results = yield* Effect.all(
              Array.from({ length: CONCURRENCY }, (_, index) =>
                store.insertIfAbsent(
                  newAccount(`race-${index}`, "u1", {
                    providerId: "google",
                    subject: "same",
                  }),
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.equal(results.filter(Option.isSome).length, 1);
          }),
        },
      ],
    },
    getByKey: {
      read: [
        {
          name: "getByKey is global across tenants (the directory is not narrowed by the ambient tenant)",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* Tenant.withTenant("tenant-a")(
              store.insertIfAbsent(
                newAccount("a1", "u1", { providerId: "github", subject: "global" }),
              ),
            );
            // DRS-005: the same provider subject resolves from another tenant's request, and with none.
            const fromB = yield* Tenant.withTenant("tenant-b")(
              store.getByKey("github", "global", ""),
            );
            assert.equal(Option.isSome(fromB), true);
            assert.equal(Option.isSome(yield* store.getByKey("github", "global", "")), true);
          }),
        },
        {
          name: "getByKey reads the identity by (providerId, subject, issuer); another issuer is a different key",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("z", "u2", { minutes: 0 }));
            assert.equal(
              Option.getOrThrow(yield* store.getByKey("github", "subject-z", "")).id,
              "z",
            );
            assert.equal(
              Option.isNone(yield* store.getByKey("github", "subject-z", "https://iss")),
              true,
            );
          }),
        },
      ],
    },
    listByUser: {
      read: [
        {
          name: "listByUser is global across tenants (the directory is not narrowed by the ambient tenant)",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* Tenant.withTenant("tenant-a")(
              store.insertIfAbsent(
                newAccount("a1", "u1", { providerId: "github", subject: "global" }),
              ),
            );
            const listedB = yield* Tenant.withTenant("tenant-b")(
              store.listByUser(makeUserId("u1")),
            );
            assert.deepEqual(accountIds(listedB), ["a1"]);
          }),
        },
        {
          name: "listByUser is the user's own, ordered by (createdAt, id)",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("b", "u1", { minutes: 5 }));
            yield* store.insertIfAbsent(newAccount("c", "u1", { minutes: 5 }));
            yield* store.insertIfAbsent(newAccount("a", "u1", { minutes: 9 }));
            yield* store.insertIfAbsent(newAccount("z", "u2", { minutes: 0 }));
            assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u1"))), [
              "b",
              "c",
              "a",
            ]);
            assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("nobody"))), []);
          }),
        },
      ],
    },
    get: {
      read: [
        {
          name: "get reads the identity by id, and is None for an absent id",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("a", "u1", { minutes: 9 }));
            assert.equal(Option.getOrThrow(yield* store.get(makeAccountId("a"))).userId, "u1");
            assert.equal(Option.isNone(yield* store.get(makeAccountId("missing"))), true);
          }),
        },
      ],
    },
    readCredentialHash: {
      read: [
        {
          name: "readCredentialHash distinguishes no account, an account with no hash, and the hash",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(
              newAccount("with", "u1", { credentialHash: "$argon2id$stored" }),
            );
            yield* store.insertIfAbsent(newAccount("without", "u1"));
            assert.equal(
              Option.isNone(yield* store.readCredentialHash(makeAccountId("missing"))),
              true,
            );
            const none = Option.getOrThrow(
              yield* store.readCredentialHash(makeAccountId("without")),
            );
            assert.equal(Option.isNone(none), true);
            const some = Option.getOrThrow(yield* store.readCredentialHash(makeAccountId("with")));
            assert.equal(Redacted.value(Option.getOrThrow(some)), "$argon2id$stored");
          }),
        },
      ],
    },
    readProviderTokens: {
      read: [
        {
          name: "readProviderTokens round-trips every field, is empty for an account with none, and is None for no account",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("with", "u1", { tokens: sampleTokens }));
            yield* store.insertIfAbsent(newAccount("without", "u1"));
            assert.equal(
              Option.isNone(yield* store.readProviderTokens(makeAccountId("missing"))),
              true,
            );
            const empty = Option.getOrThrow(
              yield* store.readProviderTokens(makeAccountId("without")),
            );
            assert.deepEqual(empty, Option.none());
            const read = Option.getOrThrow(yield* store.readProviderTokens(makeAccountId("with")));
            const tokens = yield* openTokens(Option.getOrThrow(read));
            assert.equal(Redacted.value(tokens.accessToken), "access-1");
            assert.equal(Redacted.value(Option.getOrThrow(tokens.refreshToken)), "refresh-1");
            assert.equal(Redacted.value(Option.getOrThrow(tokens.idToken)), "id-1");
            assert.deepEqual(tokens.accessTokenExpiresAt, Option.some(at(60)));
            assert.deepEqual(tokens.refreshTokenExpiresAt, Option.some(at(600)));
            assert.deepEqual(tokens.scope, Option.some("openid email"));
            assert.deepEqual(tokens.tokenType, Option.some("Bearer"));
          }),
        },
      ],
    },
    writeCredentialHash: {
      write: [
        {
          name: "writeCredentialHash replaces the value, bumps updatedAt and leaves the identity alone; an absent account is false",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("a", "u1", { credentialHash: "old" }));
            assert.equal(
              yield* store.writeCredentialHash(makeAccountId("a"), Redacted.make("new"), at(10)),
              true,
            );
            const hash = Option.getOrThrow(
              Option.getOrThrow(yield* store.readCredentialHash(makeAccountId("a"))),
            );
            assert.equal(Redacted.value(hash), "new");
            const identity = Option.getOrThrow(yield* store.get(makeAccountId("a")));
            assert.deepEqual(identity.updatedAt, at(10));
            assert.deepEqual(identity.createdAt, at(0));
            assert.equal(
              yield* store.writeCredentialHash(makeAccountId("missing"), Redacted.make("x"), at(1)),
              false,
            );
          }),
        },
      ],
    },
    writeProviderTokens: {
      write: [
        {
          name: "writeProviderTokens replaces the value, bumps updatedAt and leaves the identity alone; an absent account is false",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("a", "u1", { tokens: sampleTokens }));
            assert.equal(
              yield* store.writeProviderTokens(
                makeAccountId("a"),
                {
                  ...sampleTokens,
                  accessToken: Redacted.make("rotated"),
                  refreshToken: Option.none(),
                },
                at(20),
              ),
              true,
            );
            const read = Option.getOrThrow(yield* store.readProviderTokens(makeAccountId("a")));
            const tokens = yield* openTokens(Option.getOrThrow(read));
            assert.equal(Redacted.value(tokens.accessToken), "rotated");
            assert.equal(Option.isNone(tokens.refreshToken), true);
            const identity = Option.getOrThrow(yield* store.get(makeAccountId("a")));
            assert.deepEqual(identity.updatedAt, at(20));
            assert.deepEqual(identity.createdAt, at(0));
            assert.equal(
              yield* store.writeProviderTokens(makeAccountId("missing"), sampleTokens, at(1)),
              false,
            );
          }),
        },
      ],
    },
    deleteUnlessLast: {
      atomic: [
        {
          name: "deleteUnlessLast deletes a sibling, refuses the last account unless allowed, and says NotFound for none",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("a", "u1"));
            yield* store.insertIfAbsent(newAccount("b", "u1"));
            assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("a"), false), {
              _tag: "Deleted",
            });
            assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), false), {
              _tag: "LastAccount",
              userId: "u1",
            });
            assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u1"))), ["b"]);
            assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), true), {
              _tag: "Deleted",
            });
            assert.deepEqual(yield* store.deleteUnlessLast(makeAccountId("b"), true), {
              _tag: "NotFound",
            });
            // A deleted account frees its key.
            assert.equal(
              Option.isSome(
                yield* store.insertIfAbsent(newAccount("c", "u2", { subject: "subject-a" })),
              ),
              true,
            );
          }),
        },
      ],
      race: [
        {
          name: "deleteUnlessLast under concurrency: unlinking a user's two accounts together never leaves none (BEH-EA-045)",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            const users = Array.from({ length: CONCURRENCY }, (_, index) => `racer-${index}`);
            for (const user of users) {
              yield* store.insertIfAbsent(newAccount(`${user}-a`, user));
              yield* store.insertIfAbsent(newAccount(`${user}-b`, user));
            }
            yield* Effect.all(
              users.flatMap((user) => [
                store.deleteUnlessLast(makeAccountId(`${user}-a`), false),
                store.deleteUnlessLast(makeAccountId(`${user}-b`), false),
              ]),
              { concurrency: "unbounded" },
            );
            for (const user of users) {
              assert.equal((yield* store.listByUser(makeUserId(user))).length, 1, user);
            }
          }),
        },
      ],
    },
    deleteByUser: {
      write: [
        {
          name: "deleteByUser removes every account of the user, regardless of the last-account rule, and nobody else's",
          run: Effect.gen(function* () {
            const store = yield* AccountStore.AccountStore;
            yield* store.insertIfAbsent(newAccount("a", "u1"));
            yield* store.insertIfAbsent(newAccount("b", "u1"));
            yield* store.insertIfAbsent(newAccount("c", "u2"));
            assert.equal(yield* store.deleteByUser(makeUserId("u1")), 2);
            assert.equal(yield* store.deleteByUser(makeUserId("u1")), 0);
            assert.deepEqual(accountIds(yield* store.listByUser(makeUserId("u2"))), ["c"]);
          }),
        },
      ],
    },
  },
});
