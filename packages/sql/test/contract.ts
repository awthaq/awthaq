// spec/behaviors/05-persistence-stratum.md, BEH-EA-033 through BEH-EA-036.
//
// ESR-009: the dialect-neutral contract cases — every repository behavior
// that must hold identically on every dialect — as one function that each
// database-specific suite (`Repositories.test.ts` on `:memory:` SQLite,
// `Repositories.file.test.ts` on a WAL file, `Repositories.postgres.test.ts`
// on a real server) calls with its own migrated `SqlClient` layer, so a new
// case lands on every dialect at once.
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Model from "effect/unstable/schema/Model";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";

// Shipping-gap map (.scratch/shipping-gaps), ticket 18:
// `Repositories.AccountsRepositoryLive` requires `Encryption` — a
// fixed test key, isolated from the real `process.env`.
export const EncryptionLive = Encryption.layer.pipe(
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

/**
 * Every repository over `SqlLive`, after the real framework `Migrator` has run
 * `CoreMigrations.coreMigrations` (shipping-gap map, ticket 15) — proves the
 * migration set itself is correct, not just the repositories built on it.
 * `prepare` runs first (e.g. the Postgres suite resets its schema).
 */
export const repositoriesLayer = <E>(
  SqlLive: Layer.Layer<SqlClient.SqlClient, E>,
  prepare: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.void,
) => {
  const Migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* prepare;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
    }),
  ).pipe(Layer.provide(SqlLive));

  return Layer.mergeAll(
    Repositories.UsersRepositoryLive,
    Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive)),
    Repositories.SessionsRepositoryLive,
    Repositories.VerificationRepositoryLive,
    Repositories.VerificationReservationsRepositoryLive,
    Repositories.AuditLogRepositoryLive,
    Repositories.RelayCursorRepositoryLive,
  ).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));
};

export const contractCases = (
  label: string,
  dialect: Models.Dialect,
  RepositoriesLive: ReturnType<typeof repositoriesLayer>,
  options: { readonly skip: boolean } = { skip: false },
) => {
  const M = Models.makeModels(dialect);

  describe.skipIf(options.skip)(label, () => {
    it.effect("BEH-EA-033: Users repository inserts with a generated UuidV7 id", () =>
      Effect.gen(function* () {
        const users = yield* Repositories.UsersRepository;
        const created = yield* users.insert(
          yield* M.User.insert.makeEffect({
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
          yield* M.User.insert.makeEffect({ email: "mixed@example.com", name: "Mixed" }),
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
            yield* M.User.insert.makeEffect({ email: "creds@example.com", name: "Creds" }),
          );
          const account = yield* accounts.insert(
            yield* M.Account.insert.makeEffect({
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
          const json = yield* Schema.encodeUnknownEffect(M.Account.json)(account);
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
            yield* M.User.insert.makeEffect({ email: "encrypted@example.com", name: "Enc" }),
          );
          const account = yield* accounts.insert(
            yield* M.Account.insert.makeEffect({
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
          }>`SELECT "accessToken", "refreshToken" FROM accounts WHERE id = ${account.id}`;
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
            yield* M.User.insert.makeEffect({ email: "rehash@example.com", name: "Rehash" }),
          );
          const account = yield* accounts.insert(
            yield* M.Account.insert.makeEffect({
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
            yield* M.Account.update.makeEffect({
              id: account.id,
              passwordHash: "new-hash",
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
            }),
            { providerId: account.providerId, userId: account.userId },
          );
          assert.strictEqual(updated.passwordHash, "new-hash");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // PPS-001: `update` now takes `aad` from the caller instead of an
    // internal `findById` re-derivation — a real, non-null accessToken/
    // refreshToken (unlike the null ones above, which can't distinguish a
    // correct AAD from a wrong one, since encrypting/decrypting `null` is a
    // no-op either way) proves the caller-supplied `providerId`/`userId`
    // genuinely round-trips through re-encryption correctly, not just that
    // the call compiles.
    it.effect(
      "AccountsRepository.update's caller-supplied aad correctly re-encrypts a real accessToken/refreshToken",
      () =>
        Effect.gen(function* () {
          const accounts = yield* Repositories.AccountsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "aad-update@example.com", name: "Aad" }),
          );
          const account = yield* accounts.insert(
            yield* M.Account.insert.makeEffect({
              userId: user.id,
              providerId: "github",
              subject: "gh-aad-update",
              issuer: "",
              passwordHash: null,
              accessToken: "plaintext-access-token",
              refreshToken: "plaintext-refresh-token",
            }),
          );
          const updated = yield* accounts.update(
            yield* M.Account.update.makeEffect({
              id: account.id,
              passwordHash: null,
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
            }),
            { providerId: account.providerId, userId: account.userId },
          );
          assert.strictEqual(updated.accessToken, "plaintext-access-token");
          assert.strictEqual(updated.refreshToken, "plaintext-refresh-token");

          // The re-encrypted write is independently re-readable too, not
          // just the write call's own in-memory return value.
          const reread = yield* accounts.findById(account.id);
          assert.strictEqual(reread.accessToken, "plaintext-access-token");
          assert.strictEqual(reread.refreshToken, "plaintext-refresh-token");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-043: findByProviderSubject identifies at most one Account row", () =>
      Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "oauth@example.com", name: "Oauth" }),
        );
        yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
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

    it.effect(
      "BEH-EA-050: Sessions repository persists only the secret's hash, never a secret",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "session@example.com", name: "S" }),
          );
          const now = yield* DateTime.now;
          const session = yield* sessions.insert(
            yield* M.Session.insert.makeEffect({
              userId: user.id,
              secretHash: "hashed-secret-value",
              ipAddress: null,
              userAgent: "test-agent",
              absoluteExpiresAt: now,
              idleExpiresAt: Model.Override(now),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
          assert.strictEqual(session.secretHash, "hashed-secret-value");
          const json = yield* Schema.encodeUnknownEffect(M.Session.json)(session);
          assert.notProperty(json, "secretHash");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-036: Sessions.listByUser pages by (createdAt, id), never an offset", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "many-sessions@example.com", name: "M" }),
        );
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        for (let i = 0; i < 5; i++) {
          yield* sessions.insert(
            yield* M.Session.insert.makeEffect({
              userId: user.id,
              secretHash: `hash-${i}`,
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: future,
              idleExpiresAt: Model.Override(future),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
        }

        const firstPage = yield* sessions.listByUser(user.id, now, undefined, 2);
        assert.strictEqual(firstPage.items.length, 2);
        assert.isTrue(Option.isSome(firstPage.nextCursor));

        const cursor = firstPage.nextCursor.pipe(
          Option.getOrThrowWith(() => new Error("expected a cursor")),
        );
        const secondPage = yield* sessions.listByUser(user.id, now, cursor, 2);
        assert.strictEqual(secondPage.items.length, 2);
        assert.isTrue(Option.isSome(secondPage.nextCursor));

        const thirdPage = yield* sessions.listByUser(
          user.id,
          now,
          secondPage.nextCursor.pipe(Option.getOrThrowWith(() => new Error("expected a cursor"))),
          2,
        );
        assert.strictEqual(thirdPage.items.length, 1);
        assert.isTrue(Option.isNone(thirdPage.nextCursor));

        const allIds = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
          (s) => s.id,
        );
        assert.strictEqual(new Set(allIds).size, 5);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-054: deleteAllForUserExcept revokes every session but the kept one", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const users = yield* Repositories.UsersRepository;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "revoke@example.com", name: "R" }),
        );
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const make = () =>
          sessions.insert(
            M.Session.insert.make({
              userId: user.id,
              secretHash: "h",
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: future,
              idleExpiresAt: Model.Override(future),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );
        const keep = yield* make();
        yield* make();
        yield* make();

        yield* sessions.deleteAllForUserExcept(user.id, keep.id);
        const remaining = yield* sessions.listByUser(user.id, now, undefined, 10);
        assert.strictEqual(remaining.items.length, 1);
        assert.strictEqual(remaining.items[0]?.id, keep.id);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "upstream-hardening ticket 02: deleteAllByUser revokes every session, no exceptions",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "revoke-all@example.com", name: "R" }),
          );
          const now = yield* DateTime.now;
          const future = DateTime.addDuration(now, Duration.days(1));
          const make = () =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: "h",
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: future,
                idleExpiresAt: Model.Override(future),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          yield* make();
          yield* make();

          yield* sessions.deleteAllByUser(user.id);
          const remaining = yield* sessions.listByUser(user.id, now, undefined, 10);
          assert.strictEqual(remaining.items.length, 0);
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "upstream-hardening ticket 01: touch's compare-and-swap lets only the first of two racing callers rotate",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "touch-race@example.com", name: "T" }),
          );
          const now = yield* DateTime.now;
          const session = yield* sessions.insert(
            M.Session.insert.make({
              userId: user.id,
              secretHash: "original-hash",
              ipAddress: null,
              userAgent: null,
              absoluteExpiresAt: now,
              idleExpiresAt: Model.Override(now),
              actingAsType: null,
              actingAsId: null,
              familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
              supersededBy: null,
              supersededAt: null,
              reusedAt: null,
            }),
          );

          // Two callers both read the row before either wrote — both present
          // the same `expectedSecretHash`, the value that was actually live
          // at the time they read it.
          const first = yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "original-hash",
            secretHash: "rotated-by-first",
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          assert.isTrue(Option.isSome(first), "the first caller should win the race");
          assert.strictEqual(Option.getOrThrow(first).secretHash, "rotated-by-first");

          // The second caller's own compare-and-swap is guarded against the
          // now-stale hash it read before the first caller's write landed —
          // it must not clobber the winner's row with its own rotation.
          const second = yield* sessions.touch({
            id: session.id,
            expectedSecretHash: "original-hash",
            secretHash: "rotated-by-second",
            lastActiveAt: now,
            idleExpiresAt: now,
          });
          assert.isTrue(Option.isNone(second), "the second, losing caller must not overwrite");

          const current = yield* sessions.findById(session.id);
          assert.strictEqual(current.secretHash, "rotated-by-first");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "BEH-EA-057/060: VerificationToken repository hashes at rest and is looked up by identifier",
      () =>
        Effect.gen(function* () {
          const verification = yield* Repositories.VerificationRepository;
          const now = yield* DateTime.now;
          const token = yield* verification.insert(
            yield* M.VerificationToken.insert.makeEffect({
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
            yield* M.VerificationToken.update.makeEffect({ id: token.id, consumedAt: now }),
          );
          assert.isNotNull(consumed.consumedAt);

          // PPS-003: the lookup is scoped to the *live* row, so a consumed
          // token (kept as history) is no longer "the token for this identifier".
          const afterConsume = yield* verification.findByIdentifier("verify-email:user-1");
          assert.isTrue(Option.isNone(afterConsume));
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // MLO-006: the atomic `UPDATE ... RETURNING` decides a concurrent race.
    it.effect(
      "BEH-EA-062: two concurrent tryConsume calls for one live token yield exactly one row",
      () =>
        Effect.gen(function* () {
          const verification = yield* Repositories.VerificationRepository;
          const now = yield* DateTime.now;
          yield* verification.upsertLive(
            yield* M.VerificationToken.insert.makeEffect({
              identifier: "verify-email:race",
              valueHash: "hash-race",
              expiresAt: DateTime.add(now, { minutes: 10 }),
              consumedAt: null,
            }),
          );
          const claim = verification.tryConsume({
            identifier: "verify-email:race",
            valueHash: "hash-race",
            now,
          });
          const results = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
          assert.strictEqual(results.filter(Option.isSome).length, 1);
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "BEH-EA-122: VerificationToken.payload round-trips JSON-encoded, defaulting to null",
      () =>
        Effect.gen(function* () {
          const verification = yield* Repositories.VerificationRepository;
          const now = yield* DateTime.now;
          const withPayload = yield* verification.insert(
            yield* M.VerificationToken.insert.makeEffect({
              identifier: "oauth.flow:1",
              valueHash: "hash-1",
              expiresAt: now,
              consumedAt: null,
              payload: { codeVerifier: "abc", nonce: "xyz" },
            }),
          );
          assert.deepStrictEqual(withPayload.payload, { codeVerifier: "abc", nonce: "xyz" });

          const withoutPayload = yield* verification.insert(
            yield* M.VerificationToken.insert.makeEffect({
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
            yield* M.VerificationToken.insert.makeEffect({
              identifier: "verify-email:user-3",
              valueHash: "hash-old",
              expiresAt: now,
              consumedAt: null,
            }),
          );
          yield* verification.update(
            yield* M.VerificationToken.update.makeEffect({
              id: consumedRow.id,
              consumedAt: now,
            }),
          );
          const staleLiveRow = yield* verification.insert(
            yield* M.VerificationToken.insert.makeEffect({
              identifier: "verify-email:user-3",
              valueHash: "hash-stale",
              expiresAt: now,
              consumedAt: null,
            }),
          );

          const fresh = yield* M.VerificationToken.insert.makeEffect({
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
              M.VerificationToken.insert
                .makeEffect({ identifier, valueHash: "hash-a", expiresAt: now, consumedAt: null })
                .pipe(Effect.flatMap(verification.upsertLive)),
              M.VerificationToken.insert
                .makeEffect({ identifier, valueHash: "hash-b", expiresAt: now, consumedAt: null })
                .pipe(Effect.flatMap(verification.upsertLive)),
            ],
            { concurrency: "unbounded" },
          );

          const rows =
            yield* sql`SELECT COUNT(*) AS count FROM verification_tokens WHERE identifier = ${identifier} AND "consumedAt" IS NULL`;
          assert.strictEqual(Number(rows[0]?.["count"]), 1);
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BEH-EA-058/062: tryConsume is the one atomic claim behind consumption", () =>
      Effect.gen(function* () {
        const verification = yield* Repositories.VerificationRepository;
        const now = yield* DateTime.now;
        yield* verification.insert(
          yield* M.VerificationToken.insert.makeEffect({
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

    // ESR-009: the RETURNING-decoded session writes of RRS-003/ticket 15 —
    // a timestamp/nullable-timestamp round trip through each dialect's codec.
    it.effect(
      "RRS-003: tombstone/markReused/reauthenticate decode their RETURNING rows; revokeFamily deletes only live rows",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "rotation@example.com", name: "R" }),
          );
          const now = yield* DateTime.now;
          const make = (hash: string) =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: hash,
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: now,
                idleExpiresAt: Model.Override(now),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)("family-1"),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          const old = yield* make("old");
          const fresh = yield* make("fresh");

          const tombstoned = yield* sessions.tombstone({
            id: old.id,
            supersededBy: fresh.id,
            supersededAt: now,
          });
          assert.strictEqual(tombstoned.supersededBy, fresh.id);
          assert.isNotNull(tombstoned.supersededAt);
          assert.strictEqual(tombstoned.reusedAt, null);

          yield* sessions.markReused(old.id, now);
          const reread = yield* sessions.findById(old.id);
          assert.isNotNull(reread.reusedAt);

          const later = DateTime.addDuration(now, Duration.minutes(5));
          const reauthenticated = yield* sessions.reauthenticate(fresh.id, later);
          assert.strictEqual(
            DateTime.toEpochMillis(reauthenticated.authenticatedAt),
            DateTime.toEpochMillis(later),
          );

          yield* sessions.revokeFamily(Schema.decodeUnknownSync(Models.SessionId)("family-1"));
          // The tombstoned row survives (its lineage is evidence); the live row is gone.
          const survivor = yield* sessions.findById(old.id);
          assert.strictEqual(survivor.id, old.id);
          const gone = yield* sessions.findById(fresh.id).pipe(Effect.flip);
          assert.strictEqual(gone._tag, "NoSuchElementError");
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("AuditLog.list filters by an occurredAt range and round-trips the payload", () =>
      Effect.gen(function* () {
        const auditLog = yield* Repositories.AuditLogRepository;
        const t0 = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
        const at = (minutes: number) => DateTime.addDuration(t0, Duration.minutes(minutes));
        for (const { id, minutes } of [
          { id: "a", minutes: 0 },
          { id: "b", minutes: 10 },
          { id: "c", minutes: 20 },
        ]) {
          yield* auditLog.insert({
            id,
            eventTag: "auth.test",
            actorUserId: null,
            occurredAt: at(minutes),
            correlationId: null,
            payload: { id },
          });
        }
        const inRange = yield* auditLog.list({
          eventTag: null,
          actorUserId: null,
          occurredAfter: at(5),
          occurredBefore: at(15),
        });
        assert.deepStrictEqual(
          inRange.map((row) => row.id),
          ["b"],
        );
        assert.deepStrictEqual(inRange[0]?.payload, { id: "b" });
        const all = yield* auditLog.list({
          eventTag: "auth.test",
          actorUserId: null,
          occurredAfter: null,
          occurredBefore: null,
        });
        assert.deepStrictEqual(
          all.map((row) => row.id),
          ["c", "b", "a"],
        );
      }).pipe(Effect.provide(RepositoriesLive)),
    );
    // ALF-010: retention deletes are one bounded statement each.
    it.effect(
      "AuditLog.deleteOccurredBefore removes only rows older than the cutoff for the given tags",
      () =>
        Effect.gen(function* () {
          const auditLog = yield* Repositories.AuditLogRepository;
          const t0 = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
          const at = (days: number) => DateTime.addDuration(t0, Duration.days(days));
          const rows = [
            { id: "a", eventTag: "auth.one", days: 0 },
            { id: "b", eventTag: "auth.two", days: 0 },
            { id: "c", eventTag: "auth.one", days: 10 },
            { id: "d", eventTag: "auth.three", days: 0 },
          ];
          for (const { id, eventTag, days } of rows) {
            yield* auditLog.insert({
              id,
              eventTag,
              actorUserId: null,
              occurredAt: at(days),
              correlationId: null,
              payload: { id },
            });
          }
          const remaining = auditLog
            .list({ eventTag: null, actorUserId: null, occurredAfter: null, occurredBefore: null })
            .pipe(Effect.map((all) => all.map((row) => row.id).sort()));

          // only the listed tag, only before the cutoff: `a` goes; `c` is newer, `b`/`d` other tags
          assert.strictEqual(
            yield* auditLog.deleteOccurredBefore({
              cutoff: at(5),
              eventTags: ["auth.one"],
              exceptTags: [],
              limit: 100,
            }),
            1,
          );
          assert.deepStrictEqual(yield* remaining, ["b", "c", "d"]);

          // every tag but `auth.three`, bounded by `limit`: `b` goes, `d` is excepted
          assert.strictEqual(
            yield* auditLog.deleteOccurredBefore({
              cutoff: at(5),
              eventTags: null,
              exceptTags: ["auth.three"],
              limit: 1,
            }),
            1,
          );
          assert.deepStrictEqual(yield* remaining, ["c", "d"]);
          assert.strictEqual(
            yield* auditLog.deleteOccurredBefore({
              cutoff: at(5),
              eventTags: null,
              exceptTags: ["auth.three"],
              limit: 100,
            }),
            0,
          );
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "CSG-003: deleteExpiredBefore removes expired sessions, tokens and reservations, bounded by limit, and reports the count",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const verification = yield* Repositories.VerificationRepository;
          const reservations = yield* Repositories.VerificationReservationsRepository;
          const users = yield* Repositories.UsersRepository;
          const user = yield* users.insert(
            yield* M.User.insert.makeEffect({ email: "retention@example.com", name: "R" }),
          );
          const t0 = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
          const at = (days: number) => DateTime.addDuration(t0, Duration.days(days));
          const cutoff = at(10);

          const session = (hash: string, absolute: DateTime.Utc) =>
            sessions.insert(
              M.Session.insert.make({
                userId: user.id,
                secretHash: hash,
                ipAddress: null,
                userAgent: null,
                absoluteExpiresAt: absolute,
                idleExpiresAt: Model.Override(absolute),
                actingAsType: null,
                actingAsId: null,
                familyId: Schema.decodeUnknownSync(Models.SessionId)(`family-${hash}`),
                supersededBy: null,
                supersededAt: null,
                reusedAt: null,
              }),
            );
          const old1 = yield* session("old1", at(1));
          yield* session("old2", at(2));
          const live = yield* session("live", at(30));
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 1), 1);
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 100), 1);
          assert.strictEqual(yield* sessions.deleteExpiredBefore(cutoff, 100), 0);
          assert.strictEqual((yield* sessions.findById(live.id)).id, live.id);
          assert.strictEqual(
            (yield* sessions.findById(old1.id).pipe(Effect.flip))._tag,
            "NoSuchElementError",
          );

          const token = (
            identifier: string,
            expiresAt: DateTime.Utc,
            consumedAt: DateTime.Utc | null,
          ) =>
            verification.insert(
              M.VerificationToken.insert.make({
                identifier,
                valueHash: `hash-${identifier}`,
                expiresAt,
                consumedAt,
              }),
            );
          yield* token("expired", at(1), null);
          yield* token("consumed-long-ago", at(30), at(2));
          yield* token("consumed-recently", at(30), at(20));
          yield* token("live", at(30), null);
          assert.strictEqual(yield* verification.deleteExpiredBefore(cutoff, 100), 2);
          assert.strictEqual(yield* verification.deleteExpiredBefore(cutoff, 100), 0);

          assert.isTrue(
            yield* reservations.claim({ identifier: "r-old", expiresAt: at(1), now: t0 }),
          );
          assert.isTrue(
            yield* reservations.claim({ identifier: "r-live", expiresAt: at(30), now: t0 }),
          );
          assert.strictEqual(yield* reservations.deleteExpiredBefore(cutoff, 100), 1);
          assert.strictEqual(yield* reservations.deleteExpiredBefore(cutoff, 100), 0);
        }).pipe(Effect.provide(RepositoriesLive)),
    );

    // CWM-004: the event relay's persisted position.
    it.effect("RelayCursor: get is empty until set, set upserts, and names are independent", () =>
      Effect.gen(function* () {
        const cursors = yield* Repositories.RelayCursorRepository;
        const t0 = DateTime.makeUnsafe("2026-04-01T00:00:00.000Z");
        assert.isTrue(Option.isNone(yield* cursors.get("billing")));
        yield* cursors.set("billing", "event-1", t0);
        yield* cursors.set("siem", "event-9", t0);
        yield* cursors.set("billing", "event-2", DateTime.addDuration(t0, Duration.minutes(1)));
        assert.deepStrictEqual(yield* cursors.get("billing"), Option.some("event-2"));
        assert.deepStrictEqual(yield* cursors.get("siem"), Option.some("event-9"));
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("BAM-008: idToken round-trips through the repository and is ciphertext at rest", () =>
      Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        const users = yield* Repositories.UsersRepository;
        const sql = yield* SqlClient.SqlClient;
        const user = yield* users.insert(
          yield* M.User.insert.makeEffect({ email: "idtoken@example.com", name: "Id" }),
        );
        const account = yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
            userId: user.id,
            providerId: "google",
            subject: "gh-id-token",
            issuer: "",
            passwordHash: null,
            accessToken: "access",
            refreshToken: null,
            idToken: "plaintext.id.token",
          }),
        );
        assert.strictEqual(account.idToken, "plaintext.id.token");
        assert.strictEqual((yield* accounts.findById(account.id)).idToken, "plaintext.id.token");
        const rows = yield* sql<{
          readonly idToken: string;
        }>`SELECT "idToken" FROM accounts WHERE id = ${account.id}`;
        assert.isDefined(rows[0]);
        assert.notInclude(rows[0]?.idToken, "plaintext.id.token");
        // Never in the JSON variant.
        const json = yield* Schema.encodeUnknownEffect(M.Account.json)(account);
        assert.notProperty(json, "idToken");
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    // SMS-002/ESR-010/GC-005/ESR-002: the session device-list page query and owned delete.
    const makeUser = (email: string) =>
      Effect.gen(function* () {
        const users = yield* Repositories.UsersRepository;
        return yield* users.insert(yield* M.User.insert.makeEffect({ email, name: "S" }));
      });

    const insertLiveSession = (
      userId: Models.UserId,
      options: {
        readonly absoluteExpiresAt: DateTime.Utc;
        readonly idleExpiresAt: DateTime.Utc;
        readonly supersededAt?: DateTime.Utc;
      },
    ) =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        return yield* sessions.insert(
          M.Session.insert.make({
            userId,
            secretHash: "h",
            ipAddress: null,
            userAgent: null,
            absoluteExpiresAt: options.absoluteExpiresAt,
            idleExpiresAt: Model.Override(options.idleExpiresAt),
            actingAsType: null,
            actingAsId: null,
            familyId: Schema.decodeUnknownSync(Models.SessionId)("fixture-family"),
            supersededBy: null,
            supersededAt: options.supersededAt ?? null,
            reusedAt: null,
          }),
        );
      });

    it.effect("SMS-002: listByUser omits absolute-expired, idle-expired and tombstoned rows", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("live-only@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const past = DateTime.subtractDuration(now, Duration.minutes(1));
        const live = yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
        });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: past, idleExpiresAt: future });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: past });
        yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
          supersededAt: past,
        });
        const page = yield* sessions.listByUser(user.id, now);
        assert.deepStrictEqual(
          page.items.map((row) => row.id),
          [live.id],
        );
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("ESR-010: listByUser clamps limit 0 to 1 and still returns a nextCursor", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("clamp-zero@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        const page = yield* sessions.listByUser(user.id, now, undefined, 0);
        assert.strictEqual(page.items.length, 1);
        assert.isTrue(Option.isSome(page.nextCursor));
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("ESR-010: a negative limit does not raise a SqlError", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("clamp-negative@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        yield* insertLiveSession(user.id, { absoluteExpiresAt: future, idleExpiresAt: future });
        const page = yield* sessions.listByUser(user.id, now, undefined, -5);
        assert.strictEqual(page.items.length, 1);
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect(
      "ESR-010: listByUser caps the page at MAX_PAGE_SIZE",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Repositories.SessionsRepository;
          const user = yield* makeUser("clamp-huge@example.com");
          const now = yield* DateTime.now;
          const future = DateTime.addDuration(now, Duration.days(1));
          for (let i = 0; i < Repositories.MAX_PAGE_SIZE + 5; i++) {
            yield* insertLiveSession(user.id, {
              absoluteExpiresAt: future,
              idleExpiresAt: future,
            });
          }
          const page = yield* sessions.listByUser(user.id, now, undefined, 100_000);
          assert.strictEqual(page.items.length, Repositories.MAX_PAGE_SIZE);
          assert.isTrue(Option.isSome(page.nextCursor));
        }).pipe(Effect.provide(RepositoriesLive)),
      30_000,
    );

    it.effect("GC-005: deleteOwned deletes only the owner's row, in one statement", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const owner = yield* makeUser("owner@example.com");
        const other = yield* makeUser("not-owner@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const row = yield* insertLiveSession(owner.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
        });
        assert.isFalse(yield* sessions.deleteOwned(row.id, other.id));
        assert.strictEqual((yield* sessions.findById(row.id)).id, row.id);
        assert.isTrue(yield* sessions.deleteOwned(row.id, owner.id));
        assert.isFalse(yield* sessions.deleteOwned(row.id, owner.id));
      }).pipe(Effect.provide(RepositoriesLive)),
    );

    it.effect("ESR-002: tombstone applies only to a still-live row", () =>
      Effect.gen(function* () {
        const sessions = yield* Repositories.SessionsRepository;
        const user = yield* makeUser("tombstone-once@example.com");
        const now = yield* DateTime.now;
        const future = DateTime.addDuration(now, Duration.days(1));
        const row = yield* insertLiveSession(user.id, {
          absoluteExpiresAt: future,
          idleExpiresAt: future,
        });
        const successor = Schema.decodeUnknownSync(Models.SessionId)("successor-1");
        yield* sessions.tombstone({ id: row.id, supersededBy: successor, supersededAt: now });
        const again = yield* sessions
          .tombstone({ id: row.id, supersededBy: successor, supersededAt: now })
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "NoSuchElementError");
      }).pipe(Effect.provide(RepositoriesLive)),
    );
  });
};
