// spec/behaviors/05-persistence-stratum.md, BEH-EA-033 through BEH-EA-036.
//
// Exercises `Models.ts`/`Repositories.ts` against a real, in-memory SQLite
// database (`node:sqlite` via `@effect/sql-sqlite-node`) — the same
// `SqlModel.makeRepository`/`SqlSchema` machinery a Postgres- or
// MySQL-backed deployment would use, so a passing test here is evidence
// against the real encode/decode/SQL round-trip, not just against an
// in-memory stand-in.
import { Encryption, KeyProvider } from "@awthaq/ports";
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Model } from "effect/unstable/schema";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { CoreMigrations, Models, Repositories } from "../src/index.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// Shipping-gap map (.scratch/shipping-gaps), ticket 15: the real
// framework `Migrator`, run against `CoreMigrations.coreMigrations` —
// proves the migration set itself is correct, not just the repositories
// built on top of a hand-maintained-in-the-test-file schema.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

// Shipping-gap map (.scratch/shipping-gaps), ticket 18:
// `Repositories.AccountsRepositoryLive` now requires `Encryption` — a
// fixed test key, isolated from the real `process.env`.
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

const AccountsRepositoryLive = Repositories.AccountsRepositoryLive.pipe(
  Layer.provide(EncryptionLive),
);

const RepositoriesLive = Layer.mergeAll(
  Repositories.UsersRepositoryLive,
  AccountsRepositoryLive,
  Repositories.SessionsRepositoryLive,
  Repositories.VerificationRepositoryLive,
  Repositories.VerificationReservationsRepositoryLive,
).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

describe("Repositories", () => {
  it.effect("BEH-EA-033: Users repository inserts with a generated UuidV7 id", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const created = yield* users.insert(
        yield* Models.User.insert.makeEffect({
          email: "person@example.com",
          name: "Person",
        }),
      );
      assert.isString(created.id);
      assert.strictEqual(created.emailVerified, false);

      const found = yield* users.findById(created.id);
      assert.strictEqual(found.email, "person@example.com");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-041: findByEmail matches case-insensitively", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "mixed@example.com", name: "Mixed" }),
      );
      const found = yield* users.findByEmail("MIXED@EXAMPLE.COM");
      assert.isTrue(Option.isSome(found));
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "BEH-EA-034: passwordHash/accessToken/refreshToken never appear in the JSON variant",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* Models.User.insert.makeEffect({ email: "creds@example.com", name: "Creds" }),
        );
        const account = yield* accounts.insert(
          yield* Models.Account.insert.makeEffect({
            userId: user.id,
            providerId: "password",
            subject: user.id,
            issuer: "",
            passwordHash: "super-secret-hash",
            accessToken: null,
            refreshToken: null,
          }),
        );
        assert.strictEqual(account.passwordHash, "super-secret-hash");
        const json = yield* Schema.encodeUnknownEffect(Models.Account.json)(account);
        assert.notProperty(json, "passwordHash");
        assert.notProperty(json, "accessToken");
        assert.notProperty(json, "refreshToken");
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "Ticket 18: accessToken/refreshToken round-trip through the repository, but the raw persisted bytes are not the plaintext",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        const users = yield* Repositories.UsersRepository;
        const sql = yield* SqlClient.SqlClient;
        const user = yield* users.insert(
          yield* Models.User.insert.makeEffect({ email: "encrypted@example.com", name: "Enc" }),
        );
        const account = yield* accounts.insert(
          yield* Models.Account.insert.makeEffect({
            userId: user.id,
            providerId: "github",
            subject: "gh-encrypted",
            issuer: "",
            passwordHash: null,
            accessToken: "plaintext-access-token",
            refreshToken: "plaintext-refresh-token",
          }),
        );
        // Transparent to this repository's own interface: `insert` handed
        // back the original plaintext, decrypted.
        assert.strictEqual(account.accessToken, "plaintext-access-token");
        assert.strictEqual(account.refreshToken, "plaintext-refresh-token");

        // `findById` decrypts too, not just `insert`'s own return value.
        const reread = yield* accounts.findById(account.id);
        assert.strictEqual(reread.accessToken, "plaintext-access-token");
        assert.strictEqual(reread.refreshToken, "plaintext-refresh-token");

        // But the actual bytes on disk are demonstrably not the plaintext —
        // a raw query bypassing this repository's own decrypt step.
        const rows = yield* sql<{
          readonly accessToken: string;
          readonly refreshToken: string;
        }>`SELECT accessToken, refreshToken FROM accounts WHERE id = ${account.id}`;
        const row = rows[0];
        assert.isDefined(row);
        assert.notInclude(row?.accessToken, "plaintext-access-token");
        assert.notInclude(row?.refreshToken, "plaintext-refresh-token");
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "AccountsRepository.update replaces passwordHash (accessToken/refreshToken must be passed through unchanged, being Model.Sensitive rather than FieldExcept-excluded)",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* Models.User.insert.makeEffect({ email: "rehash@example.com", name: "Rehash" }),
        );
        const account = yield* accounts.insert(
          yield* Models.Account.insert.makeEffect({
            userId: user.id,
            providerId: "password",
            subject: user.id,
            issuer: "",
            passwordHash: "old-hash",
            accessToken: null,
            refreshToken: null,
          }),
        );
        const updated = yield* accounts.update(
          yield* Models.Account.update.makeEffect({
            id: account.id,
            passwordHash: "new-hash",
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
          }),
        );
        assert.strictEqual(updated.passwordHash, "new-hash");
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-043: findByProviderSubject identifies at most one Account row", () =>
    Effect.gen(function* () {
      const accounts = yield* Repositories.AccountsRepository;
      const users = yield* Repositories.UsersRepository;
      const user = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "oauth@example.com", name: "Oauth" }),
      );
      yield* accounts.insert(
        yield* Models.Account.insert.makeEffect({
          userId: user.id,
          providerId: "github",
          subject: "gh-123",
          issuer: "",
          passwordHash: null,
          accessToken: "token",
          refreshToken: null,
        }),
      );
      const found = yield* accounts.findByProviderSubject("github", "gh-123", "");
      assert.isTrue(Option.isSome(found));
      const missing = yield* accounts.findByProviderSubject("github", "no-such-subject", "");
      assert.isTrue(Option.isNone(missing));
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-050: Sessions repository persists only the secret's hash, never a secret", () =>
    Effect.gen(function* () {
      const sessions = yield* Repositories.SessionsRepository;
      const users = yield* Repositories.UsersRepository;
      const user = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "session@example.com", name: "S" }),
      );
      const now = yield* DateTime.now;
      const session = yield* sessions.insert(
        yield* Models.Session.insert.makeEffect({
          userId: user.id,
          secretHash: "hashed-secret-value",
          ipAddress: null,
          userAgent: "test-agent",
          absoluteExpiresAt: now,
          idleExpiresAt: Model.Override(now),
          actingAsType: null,
          actingAsId: null,
        }),
      );
      assert.strictEqual(session.secretHash, "hashed-secret-value");
      const json = yield* Schema.encodeUnknownEffect(Models.Session.json)(session);
      assert.notProperty(json, "secretHash");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-036: Sessions.listByUser pages by (createdAt, id), never an offset", () =>
    Effect.gen(function* () {
      const sessions = yield* Repositories.SessionsRepository;
      const users = yield* Repositories.UsersRepository;
      const user = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "many-sessions@example.com", name: "M" }),
      );
      const now = yield* DateTime.now;
      for (let i = 0; i < 5; i++) {
        yield* sessions.insert(
          yield* Models.Session.insert.makeEffect({
            userId: user.id,
            secretHash: `hash-${i}`,
            ipAddress: null,
            userAgent: null,
            absoluteExpiresAt: now,
            idleExpiresAt: Model.Override(now),
            actingAsType: null,
            actingAsId: null,
          }),
        );
      }

      const firstPage = yield* sessions.listByUser(user.id, undefined, 2);
      assert.strictEqual(firstPage.items.length, 2);
      assert.isTrue(Option.isSome(firstPage.nextCursor));

      const cursor = firstPage.nextCursor.pipe(
        Option.getOrThrowWith(() => new Error("expected a cursor")),
      );
      const secondPage = yield* sessions.listByUser(user.id, cursor, 2);
      assert.strictEqual(secondPage.items.length, 2);
      assert.isTrue(Option.isSome(secondPage.nextCursor));

      const thirdPage = yield* sessions.listByUser(
        user.id,
        secondPage.nextCursor.pipe(Option.getOrThrowWith(() => new Error("expected a cursor"))),
        2,
      );
      assert.strictEqual(thirdPage.items.length, 1);
      assert.isTrue(Option.isNone(thirdPage.nextCursor));

      const allIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((s) => s.id);
      assert.strictEqual(new Set(allIds).size, 5);
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-054: deleteAllForUserExcept revokes every session but the kept one", () =>
    Effect.gen(function* () {
      const sessions = yield* Repositories.SessionsRepository;
      const users = yield* Repositories.UsersRepository;
      const user = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "revoke@example.com", name: "R" }),
      );
      const now = yield* DateTime.now;
      const make = () =>
        sessions.insert(
          Models.Session.insert.make({
            userId: user.id,
            secretHash: "h",
            ipAddress: null,
            userAgent: null,
            absoluteExpiresAt: now,
            idleExpiresAt: Model.Override(now),
            actingAsType: null,
            actingAsId: null,
          }),
        );
      const keep = yield* make();
      yield* make();
      yield* make();

      yield* sessions.deleteAllForUserExcept(user.id, keep.id);
      const remaining = yield* sessions.listByUser(user.id, undefined, 10);
      assert.strictEqual(remaining.items.length, 1);
      assert.strictEqual(remaining.items[0]?.id, keep.id);
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "BEH-EA-057/060: VerificationToken repository hashes at rest and is looked up by identifier",
    () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const now = yield* DateTime.now;
        const token = yield* verification.insert(
          yield* Models.VerificationToken.insert.makeEffect({
            identifier: "verify-email:user-1",
            valueHash: "hashed-token-value",
            expiresAt: now,
            consumedAt: null,
          }),
        );
        assert.strictEqual(token.valueHash, "hashed-token-value");
        const found = yield* verification.findByIdentifier("verify-email:user-1");
        assert.isTrue(Option.isSome(found));

        const consumed = yield* verification.update(
          yield* Models.VerificationToken.update.makeEffect({ id: token.id, consumedAt: now }),
        );
        assert.isNotNull(consumed.consumedAt);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "BEH-EA-122: VerificationToken.payload round-trips JSON-encoded, defaulting to null",
    () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const now = yield* DateTime.now;
        const withPayload = yield* verification.insert(
          yield* Models.VerificationToken.insert.makeEffect({
            identifier: "oauth.flow:1",
            valueHash: "hash-1",
            expiresAt: now,
            consumedAt: null,
            payload: { codeVerifier: "abc", nonce: "xyz" },
          }),
        );
        assert.deepStrictEqual(withPayload.payload, { codeVerifier: "abc", nonce: "xyz" });

        const withoutPayload = yield* verification.insert(
          yield* Models.VerificationToken.insert.makeEffect({
            identifier: "verify-email:user-2",
            valueHash: "hash-2",
            expiresAt: now,
            consumedAt: null,
          }),
        );
        assert.strictEqual(withoutPayload.payload, null);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "ADR-EA-016: upsertLive replaces the current live row in place, leaving consumed history untouched",
    () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const now = yield* DateTime.now;
        const consumedRow = yield* verification.insert(
          yield* Models.VerificationToken.insert.makeEffect({
            identifier: "verify-email:user-3",
            valueHash: "hash-old",
            expiresAt: now,
            consumedAt: null,
          }),
        );
        yield* verification.update(
          yield* Models.VerificationToken.update.makeEffect({
            id: consumedRow.id,
            consumedAt: now,
          }),
        );
        const staleLiveRow = yield* verification.insert(
          yield* Models.VerificationToken.insert.makeEffect({
            identifier: "verify-email:user-3",
            valueHash: "hash-stale",
            expiresAt: now,
            consumedAt: null,
          }),
        );

        const fresh = yield* Models.VerificationToken.insert.makeEffect({
          identifier: "verify-email:user-3",
          valueHash: "hash-fresh",
          expiresAt: now,
          consumedAt: null,
        });
        const replaced = yield* verification.upsertLive(fresh);

        assert.strictEqual(replaced.valueHash, "hash-fresh");
        const stillConsumed = yield* verification.findById(consumedRow.id);
        assert.strictEqual(stillConsumed.valueHash, "hash-old");
        const staleGone = yield* verification.findById(staleLiveRow.id).pipe(Effect.exit);
        assert.strictEqual(staleGone._tag, "Failure");
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "ADR-EA-016: two concurrent upsertLives for the same identifier never leave two live rows",
    () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const identifier = "verify-email:user-11";

        yield* Effect.all(
          [
            Models.VerificationToken.insert
              .makeEffect({ identifier, valueHash: "hash-a", expiresAt: now, consumedAt: null })
              .pipe(Effect.flatMap(verification.upsertLive)),
            Models.VerificationToken.insert
              .makeEffect({ identifier, valueHash: "hash-b", expiresAt: now, consumedAt: null })
              .pipe(Effect.flatMap(verification.upsertLive)),
          ],
          { concurrency: "unbounded" },
        );

        const rows =
          yield* sql`SELECT COUNT(*) AS count FROM verification_tokens WHERE identifier = ${identifier} AND consumedAt IS NULL`;
        assert.strictEqual(Number(rows[0]?.["count"]), 1);
      }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("BEH-EA-058/062: tryConsume is the one atomic claim behind consumption", () =>
    Effect.gen(function* () {
      const verification = yield* Repositories.VerificationRepository;
      const now = yield* DateTime.now;
      yield* verification.insert(
        yield* Models.VerificationToken.insert.makeEffect({
          identifier: "reset-password:user-4",
          valueHash: "correct-hash",
          expiresAt: DateTime.addDuration(now, Duration.minutes(10)),
          consumedAt: null,
        }),
      );

      const wrongHash = yield* verification.tryConsume({
        identifier: "reset-password:user-4",
        valueHash: "wrong-hash",
        now,
      });
      assert.isTrue(Option.isNone(wrongHash));

      const firstConsume = yield* verification.tryConsume({
        identifier: "reset-password:user-4",
        valueHash: "correct-hash",
        now,
      });
      assert.isTrue(Option.isSome(firstConsume));

      const replay = yield* verification.tryConsume({
        identifier: "reset-password:user-4",
        valueHash: "correct-hash",
        now,
      });
      assert.isTrue(Option.isNone(replay));
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect(
    "ADR-EA-016: VerificationReservationsRepository.claim is exclusive while unexpired",
    () =>
      Effect.gen(function* () {
        const reservations = yield* Repositories.VerificationReservationsRepository;
        const now = yield* DateTime.now;

        const first = yield* reservations.claim({
          identifier: "promote:user-5",
          expiresAt: DateTime.addDuration(now, Duration.minutes(1)),
          now,
        });
        assert.isTrue(first);

        const second = yield* reservations.claim({
          identifier: "promote:user-5",
          expiresAt: DateTime.addDuration(now, Duration.minutes(1)),
          now,
        });
        assert.isFalse(second);

        const later = DateTime.addDuration(now, Duration.minutes(2));
        const third = yield* reservations.claim({
          identifier: "promote:user-5",
          expiresAt: DateTime.addDuration(later, Duration.minutes(1)),
          now: later,
        });
        assert.isTrue(third);
      }).pipe(Effect.provide(RepositoriesLive)),
  );
});
