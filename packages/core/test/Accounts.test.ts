// spec/behaviors/06-domain-users-accounts.md, BEH-EA-043 through BEH-EA-045, BEH-EA-047.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`).
import { Encryption, KeyProvider } from "@awthaq/ports";
import { Repositories } from "@awthaq/sql";
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { SqlClient } from "effect/unstable/sql";
import { Accounts, Users } from "../src/index.ts";

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
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        providerId TEXT NOT NULL,
        subject TEXT NOT NULL,
        issuer TEXT NOT NULL DEFAULT '',
        passwordHash TEXT,
        accessToken TEXT,
        refreshToken TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `;
    // BEH-EA-043/125: the uniqueness `layerSql`'s `link` relies on is this
    // real constraint, not an in-process check — `issuer` is part of the
    // key itself (`''`, not SQL NULL, for a non-federated provider) so two
    // rows that only differ by issuer are never treated as a collision.
    yield* sql`CREATE UNIQUE INDEX accounts_provider_subject_issuer_unique ON accounts (providerId, subject, issuer)`;
  }),
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
  });
};

suite("Accounts (layerMemory)", MemoryLayer);
suite("Accounts (layerSql)", SqlTestLayer);
