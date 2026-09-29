// spec/behaviors/06-domain-users-accounts.md, BEH-EA-043 through BEH-EA-045, BEH-EA-047.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`).
//
// BE-002 (.issues/high): `layerSql` is migrated via `@awthaq/sql`'s own
// real `CoreMigrations.coreMigrations` (`Migrator.make`) rather than a
// hand-rolled inline `CREATE TABLE` — the same BAM-002/BE-001 conversion
// applied to every other core/plugin table's own test suite, and the
// reason this file's own fixture needed touching at all for a finding
// that otherwise only added columns: a hand-rolled fixture has no way to
// pick up a new migration.
import { Encryption, KeyProvider } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Accounts from "../src/Accounts.ts";
import * as Users from "../src/Users.ts";

const MemoryLayer = Accounts.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// Shipping-gap map (.scratch/shipping-gaps), ticket 18:
// `Repositories.AccountsRepositoryLive` now requires `Encryption` to
// encrypt/decrypt `accessToken`/`refreshToken` transparently — a fixed
// test key, isolated from the real `process.env` via `ConfigProvider.fromEnv`.
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const SqlTestLayer = Accounts.layerSql.pipe(
  Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive))),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const userId = Users.UserId("22222222-2222-2222-2222-222222222222");

const suite = (name: string, layer: Layer.Layer<Accounts.Accounts, unknown, never>): void => {
  describe(name, () => {
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
          credentialHash: Redacted.make("phc-encoded-hash"),
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
          credentialHash: Redacted.make("old-hash"),
        });
        yield* accounts.updateCredentialHash(account.id, Redacted.make("new-hash"));
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
          .updateCredentialHash(unknown, Redacted.make("x"))
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
            accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
            refreshTokenExpiresAt: Option.none(),
            scope: Option.some("email"),
            tokenType: Option.some("Bearer"),
          },
        });
        yield* accounts.updateProviderTokens(account.id, {
          accessToken: Redacted.make("access-new"),
          refreshToken: Option.none(),
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
            credentialHash: Redacted.make("hash-1"),
            tokens: {
              accessToken: Redacted.make("access-stays"),
              refreshToken: Option.some(Redacted.make("refresh-stays")),
              accessTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-03-01T00:00:00.000Z")),
              refreshTokenExpiresAt: Option.some(DateTime.makeUnsafe("2026-04-01T00:00:00.000Z")),
              scope: Option.some("stays-scope"),
              tokenType: Option.some("stays-type"),
            },
          });
          yield* accounts.updateCredentialHash(account.id, Redacted.make("hash-2"));
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
            credentialHash: Redacted.make("hash-stays"),
          });
          yield* accounts.updateProviderTokens(account.id, {
            accessToken: Redacted.make("access-1"),
            refreshToken: Option.none(),
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

suite("Accounts (layerMemory)", MemoryLayer);
suite("Accounts (layerSql)", SqlTestLayer);

// SMS-002: only the SQL layer holds ciphertext, so an undecryptable token is
// a `layerSql`-only scenario.
describe("Accounts (layerSql) undecryptable provider tokens (SMS-002)", () => {
  const tokens = {
    accessToken: Redacted.make("access"),
    refreshToken: Option.none<Redacted.Redacted<string>>(),
    accessTokenExpiresAt: Option.none<DateTime.Utc>(),
    refreshTokenExpiresAt: Option.none<DateTime.Utc>(),
    scope: Option.none<string>(),
    tokenType: Option.none<string>(),
  };

  it.effect("findProviderTokens fails ProviderTokensUnreadable for an undecryptable row", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* accounts.link({
        userId,
        providerId: "google",
        subject: "sub-unreadable",
        tokens,
      });
      yield* sql`UPDATE accounts SET "accessToken" = 'garbage' WHERE id = ${account.id}`;
      const failure = yield* accounts.findProviderTokens(account.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderTokensUnreadable");
      // Identity reads and a fresh token write are unaffected by the bad column.
      yield* accounts.findById(account.id);
      yield* accounts.updateProviderTokens(account.id, tokens);
      const healed = yield* accounts.findProviderTokens(account.id);
      assert.strictEqual(Redacted.value(Option.getOrThrow(healed).accessToken), "access");
    }).pipe(Effect.provide(SqlTestLayer)),
  );
});
