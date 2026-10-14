// spec/behaviors/06-domain-users-accounts.md, BEH-EA-043 through BEH-EA-045, BEH-EA-047.
//
// Plan 02 (ADR-EA-041): `Accounts` is one implementation over `AccountStore`, so its domain suite
// runs once, over the `Ref` adapter. What a store must do on every backend (the atomic insert, the
// token-free identity reads, the last-account delete under concurrency) is
// `StoreContract.accounts`, run on the `Ref`, SQLite, WAL-file and (`pnpm test:pg`) Postgres
// adapters; the SQL adapter's own token encryption and failure mapping are
// `packages/sql/test/AccountStoreSql.test.ts`.
import { AccountStore, PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Accounts from "../src/Accounts.ts";
import { StoreUnavailable } from "../src/Errors.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Accounts.layer.pipe(
  Layer.provide(AccountStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const userId = Users.UserId("22222222-2222-2222-2222-222222222222");

const suite = (name: string, layer: Layer.Layer<Accounts.Accounts, unknown, never>): void => {
  describe(name, () => {
    it.effect("EOTS-004: error messages never contain the subject, account id or user id", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        yield* accounts.link({ userId, providerId: "google", subject: "subject-in-idp" });
        const duplicate = yield* accounts
          .link({ userId, providerId: "google", subject: "subject-in-idp" })
          .pipe(Effect.flip);
        assert.notInclude(duplicate.message, "subject-in-idp");
        const missing = yield* accounts
          .unlink(Accounts.AccountId("88888888-8888-8888-8888-888888888888"))
          .pipe(Effect.flip);
        assert.strictEqual(missing._tag, "AccountNotFound");
        assert.notInclude(missing.message, "88888888");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-043: (providerId, subject) is unique", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        yield* accounts.link({ userId, providerId: "google", subject: "sub-1" });
        const duplicate = yield* accounts
          .link({ userId, providerId: "google", subject: "sub-1" })
          .pipe(Effect.flip);
        assert.strictEqual(duplicate._tag, "AccountAlreadyLinked");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-044: a password credential is providerId=password, subject=userId", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        yield* accounts.link({
          userId,
          providerId: Accounts.PASSWORD_PROVIDER_ID,
          subject: userId,
        });
        const found = yield* accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId);
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BE-002: findById reads back the same record link produced, by id alone", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const linked = yield* accounts.link({
          userId,
          providerId: "google",
          subject: "sub-find-by-id",
        });
        const found = yield* accounts.findById(linked.id);
        assert.deepStrictEqual(found, linked);
        const unknown = Accounts.AccountId("00000000-0000-0000-0000-000000000000");
        const failure = yield* accounts.findById(unknown).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AccountNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-045: unlinking the last remaining account is refused", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const only = yield* accounts.link({ userId, providerId: "google", subject: "sub-2" });
        const refusal = yield* accounts.unlink(only.id).pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "LastAccountRefusal");
      }).pipe(Effect.provide(layer)),
    );

    // BEH-EA-045: the last-account check and the delete are one atomic step. On Postgres' default
    // READ COMMITTED two concurrent unlinks of a user's two DIFFERENT accounts would each count
    // two siblings and both commit; the row lock makes the second wait and recount.
    it.effect("BEH-EA-045: concurrent unlinks of a user's two accounts leave at least one", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const first = yield* accounts.link({ userId, providerId: "google", subject: "race-a" });
        const second = yield* accounts.link({ userId, providerId: "github", subject: "race-b" });
        yield* Effect.all(
          [accounts.unlink(first.id), accounts.unlink(second.id)].map(Effect.exit),
          {
            concurrency: 2,
          },
        );
        assert.isAtLeast((yield* accounts.listByUser(userId)).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    // PV-221: BEH-EA-045's "unless the deployment's policy explicitly allows it".
    it.effect("PV-221: a deployment that allows zero accounts may unlink the last one", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const only = yield* accounts.link({ userId, providerId: "google", subject: "sub-zero" });
        yield* accounts.unlink(only.id);
        assert.strictEqual((yield* accounts.listByUser(userId)).length, 0);
      }).pipe(
        Effect.provide(layer.pipe(Layer.provide(Accounts.config({ allowZeroAccounts: true })))),
      ),
    );

    it.effect("PV-221: the policy can also be applied to one call, like a tenant override", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const only = yield* accounts.link({ userId, providerId: "google", subject: "sub-zero-2" });
        const refusal = yield* accounts.unlink(only.id).pipe(Effect.flip);
        assert.strictEqual(refusal._tag, "LastAccountRefusal");
        yield* accounts
          .unlink(only.id)
          .pipe(Effect.provideService(Accounts.AccountsPolicy, { allowZeroAccounts: true }));
        assert.strictEqual((yield* accounts.listByUser(userId)).length, 0);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-045/047: unlinking succeeds when another account remains", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const first = yield* accounts.link({ userId, providerId: "google", subject: "sub-3" });
        yield* accounts.link({ userId, providerId: "github", subject: "sub-4" });
        yield* accounts.unlink(first.id);
        const remaining = yield* accounts.listByUser(userId);
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0]?.providerId, "github");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-044: link stores a credential hash, kept out of AccountRecord", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({
          userId,
          providerId: Accounts.PASSWORD_PROVIDER_ID,
          subject: userId,
          credentialHash: Redacted.make(PasswordHasher.PhcHash("phc-encoded-hash")),
        });
        assert.isFalse("credentialHash" in account);
        const stored = yield* accounts.findCredentialHash(account.id);
        assert.isTrue(Option.isSome(stored));
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored)), "phc-encoded-hash");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-044: a linked account with no credential hash has none stored", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({ userId, providerId: "google", subject: "sub-5" });
        const stored = yield* accounts.findCredentialHash(account.id);
        assert.isTrue(Option.isNone(stored));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-116: updateCredentialHash replaces the stored hash in place", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({
          userId,
          providerId: Accounts.PASSWORD_PROVIDER_ID,
          subject: userId,
          credentialHash: Redacted.make(PasswordHasher.PhcHash("old-hash")),
        });
        yield* accounts.updateCredentialHash(
          account.id,
          Redacted.make(PasswordHasher.PhcHash("new-hash")),
        );
        const stored = yield* accounts.findCredentialHash(account.id);
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored)), "new-hash");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-125: the same subject under two different issuers is never collapsed", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const first = yield* accounts.link({
          userId,
          providerId: "okta",
          subject: "u-1",
          issuer: "https://okta.example.com/oauth2/default",
        });
        const second = yield* accounts.link({
          userId,
          providerId: "okta",
          subject: "u-1",
          issuer: "https://okta-eu.example.com/oauth2/default",
        });
        assert.notStrictEqual(first.id, second.id);
        const foundFirst = yield* accounts.findByProviderSubject(
          "okta",
          "u-1",
          "https://okta.example.com/oauth2/default",
        );
        const foundSecond = yield* accounts.findByProviderSubject(
          "okta",
          "u-1",
          "https://okta-eu.example.com/oauth2/default",
        );
        assert.strictEqual(Option.getOrThrow(foundFirst).id, first.id);
        assert.strictEqual(Option.getOrThrow(foundSecond).id, second.id);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BEH-EA-125: a second link under the same (providerId, subject, issuer) is rejected",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          yield* accounts.link({
            userId,
            providerId: "okta",
            subject: "u-2",
            issuer: "https://okta.example.com/oauth2/default",
          });
          const duplicate = yield* accounts
            .link({
              userId,
              providerId: "okta",
              subject: "u-2",
              issuer: "https://okta.example.com/oauth2/default",
            })
            .pipe(Effect.flip);
          assert.strictEqual(duplicate._tag, "AccountAlreadyLinked");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("findCredentialHash/updateCredentialHash fail for an unknown account", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const unknown = Accounts.AccountId("00000000-0000-0000-0000-000000000000");
        const findFailure = yield* accounts.findCredentialHash(unknown).pipe(Effect.flip);
        assert.strictEqual(findFailure._tag, "AccountNotFound");
        const updateFailure = yield* accounts
          .updateCredentialHash(unknown, Redacted.make(PasswordHasher.PhcHash("x")))
          .pipe(Effect.flip);
        assert.strictEqual(updateFailure._tag, "AccountNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BE-002: link with tokens stores a full ProviderTokenSet, never in AccountRecord",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          const account = yield* accounts.link({
            userId,
            providerId: "google",
            subject: "sub-tokens-1",
            tokens: {
              accessToken: Redacted.make("access-1"),
              refreshToken: Option.some(Redacted.make("refresh-1")),
              idToken: Option.none(),
              accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
              refreshTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-02-01T00:00:00.000Z")),
              scope: Option.some("email profile"),
              tokenType: Option.some("Bearer"),
            },
          });
          assert.isFalse("accessToken" in account);
          assert.isFalse("refreshToken" in account);
          const stored = yield* accounts.findProviderTokens(account.id);
          assert.isTrue(Option.isSome(stored));
          const tokens = Option.getOrThrow(stored);
          assert.strictEqual(Redacted.value(tokens.accessToken), "access-1");
          assert.strictEqual(Redacted.value(Option.getOrThrow(tokens.refreshToken)), "refresh-1");
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(tokens.accessTokenExpiresAt)),
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
          );
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(tokens.refreshTokenExpiresAt)),
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-02-01T00:00:00.000Z")),
          );
          assert.strictEqual(Option.getOrThrow(tokens.scope), "email profile");
          assert.strictEqual(Option.getOrThrow(tokens.tokenType), "Bearer");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BAM-008: link persists the id_token and findProviderTokens returns it", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({
          userId,
          providerId: "google",
          subject: "sub-id-token-1",
          tokens: {
            accessToken: Redacted.make("access-id"),
            refreshToken: Option.none(),
            idToken: Option.some(Redacted.make("header.payload.signature")),
            accessTokenExpiresAt: Option.none(),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          },
        });
        const tokens = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(tokens.idToken)),
          "header.payload.signature",
        );
        assert.isFalse("idToken" in account);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BAM-008: updateCredentialHash and updateProviderTokens treat the id_token correctly",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          const account = yield* accounts.link({
            userId,
            providerId: "google",
            subject: "sub-id-token-2",
            credentialHash: Redacted.make(PasswordHasher.PhcHash("hash-1")),
            tokens: {
              accessToken: Redacted.make("access-id-2"),
              refreshToken: Option.none(),
              idToken: Option.some(Redacted.make("kept.id.token")),
              accessTokenExpiresAt: Option.none(),
              refreshTokenExpiresAt: Option.none(),
              scope: Option.none(),
              tokenType: Option.none(),
            },
          });
          // Rewriting the credential hash must not null the id_token.
          yield* accounts.updateCredentialHash(
            account.id,
            Redacted.make(PasswordHasher.PhcHash("hash-2")),
          );
          const afterHash = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
          assert.strictEqual(Redacted.value(Option.getOrThrow(afterHash.idToken)), "kept.id.token");
          // A whole-set token update replaces it (here with none).
          yield* accounts.updateProviderTokens(account.id, {
            accessToken: Redacted.make("access-id-3"),
            refreshToken: Option.none(),
            idToken: Option.none(),
            accessTokenExpiresAt: Option.none(),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          });
          const replaced = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
          assert.isTrue(Option.isNone(replaced.idToken));
        }).pipe(Effect.provide(layer)),
    );

    it.effect("BE-002: a linked account with no tokens given has none stored", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({
          userId,
          providerId: "google",
          subject: "sub-tokens-2",
        });
        const stored = yield* accounts.findProviderTokens(account.id);
        assert.isTrue(Option.isNone(stored));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BE-002: updateProviderTokens replaces the stored token set in place", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const account = yield* accounts.link({
          userId,
          providerId: "google",
          subject: "sub-tokens-3",
          tokens: {
            accessToken: Redacted.make("access-old"),
            refreshToken: Option.some(Redacted.make("refresh-old")),
            idToken: Option.none(),
            accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.some("email"),
            tokenType: Option.some("Bearer"),
          },
        });
        yield* accounts.updateProviderTokens(account.id, {
          accessToken: Redacted.make("access-new"),
          refreshToken: Option.none(),
          idToken: Option.none(),
          accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-06-01T00:00:00.000Z")),
          refreshTokenExpiresAt: Option.none(),
          scope: Option.none(),
          tokenType: Option.none(),
        });
        const stored = yield* accounts.findProviderTokens(account.id);
        const tokens = Option.getOrThrow(stored);
        assert.strictEqual(Redacted.value(tokens.accessToken), "access-new");
        assert.isTrue(Option.isNone(tokens.refreshToken));
        assert.strictEqual(
          DateTime.toEpochMillis(Option.getOrThrow(tokens.accessTokenExpiresAt)),
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-01T00:00:00.000Z")),
        );
        assert.isTrue(Option.isNone(tokens.scope));
        assert.isTrue(Option.isNone(tokens.tokenType));
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BE-002: updateCredentialHash on a token-carrying account leaves the tokens untouched",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          // A row can carry both — an OAuth-first-then-relinked-password
          // account is unusual but not excluded by this schema; the point
          // is only that writing one update-eligible field group must not
          // silently null out the other.
          const account = yield* accounts.link({
            userId,
            providerId: "google",
            subject: "sub-tokens-4",
            credentialHash: Redacted.make(PasswordHasher.PhcHash("hash-1")),
            tokens: {
              accessToken: Redacted.make("access-stays"),
              refreshToken: Option.some(Redacted.make("refresh-stays")),
              idToken: Option.none(),
              accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-03-01T00:00:00.000Z")),
              refreshTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-04-01T00:00:00.000Z")),
              scope: Option.some("stays-scope"),
              tokenType: Option.some("stays-type"),
            },
          });
          yield* accounts.updateCredentialHash(
            account.id,
            Redacted.make(PasswordHasher.PhcHash("hash-2")),
          );
          const stored = yield* accounts.findProviderTokens(account.id);
          const tokens = Option.getOrThrow(stored);
          assert.strictEqual(Redacted.value(tokens.accessToken), "access-stays");
          assert.strictEqual(
            Redacted.value(Option.getOrThrow(tokens.refreshToken)),
            "refresh-stays",
          );
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(tokens.accessTokenExpiresAt)),
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-01T00:00:00.000Z")),
          );
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(tokens.refreshTokenExpiresAt)),
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-04-01T00:00:00.000Z")),
          );
          assert.strictEqual(Option.getOrThrow(tokens.scope), "stays-scope");
          assert.strictEqual(Option.getOrThrow(tokens.tokenType), "stays-type");
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "BE-002: updateProviderTokens on a credential-carrying account leaves the hash untouched",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Accounts.Accounts;
          const account = yield* accounts.link({
            userId,
            providerId: Accounts.PASSWORD_PROVIDER_ID,
            subject: userId,
            credentialHash: Redacted.make(PasswordHasher.PhcHash("hash-stays")),
          });
          yield* accounts.updateProviderTokens(account.id, {
            accessToken: Redacted.make("access-1"),
            refreshToken: Option.none(),
            idToken: Option.none(),
            accessTokenExpiresAt: Option.none(),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          });
          const stored = yield* accounts.findCredentialHash(account.id);
          assert.strictEqual(Redacted.value(Option.getOrThrow(stored)), "hash-stays");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("findProviderTokens/updateProviderTokens fail for an unknown account", () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const unknown = Accounts.AccountId("00000000-0000-0000-0000-000000000000");
        const findFailure = yield* accounts.findProviderTokens(unknown).pipe(Effect.flip);
        assert.strictEqual(findFailure._tag, "AccountNotFound");
        const updateFailure = yield* accounts
          .updateProviderTokens(unknown, {
            accessToken: Redacted.make("x"),
            refreshToken: Option.none(),
            idToken: Option.none(),
            accessTokenExpiresAt: Option.none(),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.none(),
            tokenType: Option.none(),
          })
          .pipe(Effect.flip);
        assert.strictEqual(updateFailure._tag, "AccountNotFound");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Accounts", MemoryLayer);

const tokens: Accounts.ProviderTokenSet = {
  accessToken: Redacted.make("access"),
  refreshToken: Option.none(),
  idToken: Option.none(),
  accessTokenExpiresAt: Option.none<DateTime.Utc>(),
  refreshTokenExpiresAt: Option.none<DateTime.Utc>(),
  scope: Option.none(),
  tokenType: Option.none(),
};

describe("Accounts over a store that cannot read its tokens (SMS-002)", () => {
  // The memory adapter never holds ciphertext, so the unreadable answer is a store double's. What
  // makes a real row unreadable (a retired key, a corrupt envelope) is `AccountStoreSql.test.ts`.
  const UnreadableStore = Layer.mock(AccountStore.AccountStore, {
    readProviderTokens: () =>
      Effect.succeed(
        Option.some<AccountStore.TokensRead>({
          _tag: "Undecryptable",
          field: "accessToken",
          reason: "UnknownKeyId",
        }),
      ),
  });

  it.effect(
    "findProviderTokens fails ProviderTokensUnreadable naming the field and the reason",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const failure = yield* accounts
          .findProviderTokens(Accounts.AccountId("33333333-3333-3333-3333-333333333333"))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ProviderTokensUnreadable");
        if (failure._tag === "ProviderTokensUnreadable") {
          assert.strictEqual(failure.field, "accessToken");
          assert.strictEqual(failure.reason, "UnknownKeyId");
        }
      }).pipe(
        Effect.provide(
          Accounts.layer.pipe(Layer.provide(UnreadableStore), Layer.provide(NodeCrypto.layer)),
        ),
      ),
  );
});

// A fresh token write overwrites whatever was there and does not read it (SMS-002).
describe("Accounts provider tokens", () => {
  it.effect("updateProviderTokens replaces the whole group and bumps updatedAt", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const account = yield* accounts.link({
        userId,
        providerId: "google",
        subject: "sub-tok",
        tokens,
      });
      yield* accounts.updateProviderTokens(account.id, {
        ...tokens,
        accessToken: Redacted.make("rotated"),
      });
      const read = yield* accounts.findProviderTokens(account.id);
      assert.strictEqual(Redacted.value(Option.getOrThrow(read).accessToken), "rotated");
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect. The store
// double names its own primitive, as an adapter does; the service relabels it to the operation the
// caller ran, so the wire label does not change.
describe("Accounts infrastructure failures (MA-004)", () => {
  const down = (primitive: string) => Effect.fail(new StoreUnavailable({ operation: primitive }));
  const DownStore = Layer.mock(AccountStore.AccountStore, {
    insertIfAbsent: () => down("AccountStore.insertIfAbsent"),
    getByKey: () => down("AccountStore.getByKey"),
    get: () => down("AccountStore.get"),
    listByUser: () => down("AccountStore.listByUser"),
    readCredentialHash: () => down("AccountStore.readCredentialHash"),
    readProviderTokens: () => down("AccountStore.readProviderTokens"),
    writeCredentialHash: () => down("AccountStore.writeCredentialHash"),
    writeProviderTokens: () => down("AccountStore.writeProviderTokens"),
    deleteUnlessLast: () => down("AccountStore.deleteUnlessLast"),
    deleteByUser: () => down("AccountStore.deleteByUser"),
  });
  const DownLayer = Accounts.layer.pipe(Layer.provide(DownStore), Layer.provide(NodeCrypto.layer));

  it.effect("a store outage surfaces as StoreUnavailable named for the service operation", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const id = Accounts.AccountId("44444444-4444-4444-4444-444444444444");
      const operationOf = <A>(effect: Effect.Effect<A, { readonly _tag: string }>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((failure) =>
            failure._tag === "StoreUnavailable" && "operation" in failure
              ? failure.operation
              : failure._tag,
          ),
        );
      assert.strictEqual(
        yield* operationOf(accounts.link({ userId, providerId: "google", subject: "s" })),
        "Accounts.link",
      );
      assert.strictEqual(yield* operationOf(accounts.listByUser(userId)), "Accounts.listByUser");
      assert.strictEqual(
        yield* operationOf(accounts.findByProviderSubject("google", "s")),
        "Accounts.findByProviderSubject",
      );
      assert.strictEqual(yield* operationOf(accounts.findById(id)), "Accounts.findById");
      assert.strictEqual(yield* operationOf(accounts.unlink(id)), "Accounts.unlink");
      assert.strictEqual(
        yield* operationOf(accounts.findCredentialHash(id)),
        "Accounts.findCredentialHash",
      );
      assert.strictEqual(
        yield* operationOf(accounts.findProviderTokens(id)),
        "Accounts.findProviderTokens",
      );
      assert.strictEqual(
        yield* operationOf(accounts.deleteAllByUser(userId)),
        "Accounts.deleteAllByUser",
      );
    }).pipe(Effect.provide(DownLayer)),
  );
});
