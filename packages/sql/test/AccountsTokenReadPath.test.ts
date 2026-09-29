// SMS-002 (+ KRS-002 lazy re-encryption): the typed, rotation-safe read path
// for encrypted provider tokens in `AccountsRepositoryLive`.
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";

const M = Models.makeModels("sqlite");

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));
const BaseLive = Repositories.UsersRepositoryLive.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const k1 = { kid: "k1", key: key(1) };
const k2 = { kid: "k2", key: key(2) };

// An `AccountsRepository` over an encryption keyset whose current key is
// `current`, all sharing whatever `SqlClient` the surrounding effect has.
// `Layer.fresh`: layers are memoized by identity within one fiber, and
// `AccountsRepositoryLive`/`Encryption.layer`/`KeyProvider.layerEnv` are the same objects every time — without it the
// first keyset built in a test would silently win over the others.
const repoLayer = (keyset: ReadonlyArray<{ kid: string; key: string }>, current: string) =>
  Layer.fresh(Repositories.AccountsRepositoryLive).pipe(
    Layer.provide(
      Layer.fresh(Encryption.layer).pipe(
        Layer.provide(
          Layer.fresh(KeyProvider.layerEnv).pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    AWTHAQ_ENCRYPTION_KEYS: JSON.stringify(keyset),
                    AWTHAQ_ENCRYPTION_KEY_ID: current,
                  },
                }),
              ),
            ),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  );

const RepoK1 = repoLayer([k1], "k1");
const RepoRotated = repoLayer([k1, k2], "k2");
const RepoK2Only = repoLayer([k2], "k2");

// The repository under test plus the shared in-memory database, in one provide.
const over = (repo: typeof RepoK1) => repo.pipe(Layer.provideMerge(BaseLive));

const seedAccount = (subject: string) =>
  Effect.gen(function* () {
    const users = yield* Repositories.UsersRepository;
    const accounts = yield* Repositories.AccountsRepository;
    const user = yield* users.insert(
      yield* M.User.insert.makeEffect({ email: `${subject}@example.com`, name: subject }),
    );
    return yield* accounts.insert(
      yield* M.Account.insert.makeEffect({
        userId: user.id,
        providerId: "github",
        subject,
        issuer: "",
        passwordHash: null,
        accessToken: `access-${subject}`,
        refreshToken: `refresh-${subject}`,
      }),
    );
  });

const rawColumns = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly accessToken: string | null;
      readonly refreshToken: string | null;
    }>`SELECT "accessToken", "refreshToken" FROM accounts WHERE id = ${id}`;
    const row = rows[0];
    assert.isDefined(row);
    return row;
  });

const tamper = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE accounts SET "accessToken" = 'not-an-envelope' WHERE id = ${id}`;
  });

const kidOf = (envelope: string | null | undefined) =>
  envelope == null
    ? undefined
    : JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")).kid;

describe("AccountsRepository token read path (SMS-002)", () => {
  it.effect(
    "a tampered accessToken fails findTokensById with AccountTokenUndecryptable, not a defect",
    () =>
      Effect.gen(function* () {
        const account = yield* seedAccount("tampered").pipe(Effect.provide(RepoK1));
        yield* tamper(account.id);
        const accounts = yield* Repositories.AccountsRepository;
        const failure = yield* accounts.findTokensById(account.id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AccountTokenUndecryptable");
        if (failure._tag === "AccountTokenUndecryptable") {
          assert.strictEqual(failure.field, "accessToken");
          assert.strictEqual(failure.reason, "DecryptionFailed");
        }
      }).pipe(Effect.provide(over(RepoK1))),
  );

  it.effect("findById degrades only the unreadable column to null", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("degraded").pipe(Effect.provide(RepoK1));
      yield* tamper(account.id);
      const accounts = yield* Repositories.AccountsRepository;
      const row = yield* accounts.findById(account.id);
      assert.strictEqual(row.accessToken, null);
      assert.strictEqual(row.refreshToken, "refresh-degraded");
    }).pipe(Effect.provide(over(RepoK1))),
  );

  it.effect(
    "listByUser returns every row when one row's token is undecryptable, nulling only that column",
    () =>
      Effect.gen(function* () {
        const bad = yield* seedAccount("list-bad").pipe(Effect.provide(RepoK1));
        const users = yield* Repositories.UsersRepository;
        const accounts = yield* Repositories.AccountsRepository;
        // A second, healthy account for the same user.
        yield* accounts.insert(
          yield* M.Account.insert.makeEffect({
            userId: bad.userId,
            providerId: "google",
            subject: "list-good",
            issuer: "",
            passwordHash: null,
            accessToken: "access-good",
            refreshToken: null,
          }),
        );
        yield* tamper(bad.id);
        const listed = yield* accounts.listByUser(bad.userId);
        assert.strictEqual(listed.length, 2);
        const byProvider = new Map(listed.map((row) => [row.providerId, row]));
        assert.strictEqual(byProvider.get("github")?.accessToken, null);
        assert.strictEqual(byProvider.get("google")?.accessToken, "access-good");
        assert.isDefined(users);
      }).pipe(Effect.provide(over(RepoK1))),
  );

  it.effect(
    "findByProviderSubject still resolves the identity row when its token ciphertext is unreadable",
    () =>
      Effect.gen(function* () {
        const account = yield* seedAccount("identity").pipe(Effect.provide(RepoK1));
        yield* tamper(account.id);
        const accounts = yield* Repositories.AccountsRepository;
        const found = yield* accounts.findByProviderSubject("github", "identity", "");
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(over(RepoK1))),
  );

  it.effect("updateProviderTokens overwrites an undecryptable token without reading it", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("heal").pipe(Effect.provide(RepoK1));
      yield* tamper(account.id);
      const accounts = yield* Repositories.AccountsRepository;
      yield* accounts.updateProviderTokens(
        account.id,
        { providerId: account.providerId, userId: account.userId },
        {
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          scope: "read",
          tokenType: "Bearer",
        },
      );
      const healed = yield* accounts.findTokensById(account.id);
      assert.strictEqual(healed.accessToken, "fresh-access");
      assert.strictEqual(healed.refreshToken, "fresh-refresh");
      assert.strictEqual(healed.scope, "read");
    }).pipe(Effect.provide(over(RepoK1))),
  );

  // RRS-006: the AAD for a token write is (providerId, userId); reading it must
  // not decrypt, log, or lazily re-encrypt the token columns about to be replaced.
  it.effect("findAad returns the encryption AAD without touching the token columns", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("aad").pipe(Effect.provide(RepoK1));
      const before = yield* rawColumns(account.id);
      yield* tamper(account.id);
      const tampered = yield* rawColumns(account.id);
      const accounts = yield* Repositories.AccountsRepository;
      const aad = yield* accounts.findAad(account.id);
      assert.deepStrictEqual(aad, { providerId: "github", userId: account.userId });
      // Even on a row whose ciphertext is unreadable (where `findById` would decrypt and log).
      assert.deepStrictEqual(yield* rawColumns(account.id), tampered);
      assert.notStrictEqual(before.accessToken, tampered.accessToken);
      const missing = yield* accounts
        .findAad(Schema.decodeUnknownSync(Models.AccountId)("nope"))
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "NoSuchElementError");
    }).pipe(Effect.provide(over(RepoRotated))),
  );

  it.effect("updatePasswordHash never touches the token columns", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("hash").pipe(Effect.provide(RepoK1));
      const before = yield* rawColumns(account.id);
      const accounts = yield* Repositories.AccountsRepository;
      const updated = yield* accounts.updatePasswordHash(account.id, "new-hash");
      assert.strictEqual(updated.passwordHash, "new-hash");
      assert.deepStrictEqual(yield* rawColumns(account.id), before);
    }).pipe(Effect.provide(over(RepoK1))),
  );

  it.effect(
    "a row written under a retired kid still decrypts while that kid stays in the keyset",
    () =>
      Effect.gen(function* () {
        const account = yield* seedAccount("retired").pipe(Effect.provide(RepoK1));
        const accounts = yield* Repositories.AccountsRepository;
        const row = yield* accounts.findTokensById(account.id);
        assert.strictEqual(row.accessToken, "access-retired");
        assert.strictEqual(row.refreshToken, "refresh-retired");
      }).pipe(Effect.provide(over(RepoRotated))),
  );

  it.effect("findById rewrites a stale-kid ciphertext under the current key", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("lazy").pipe(Effect.provide(RepoK1));
      const before = yield* rawColumns(account.id);
      assert.strictEqual(kidOf(before.accessToken), "k1");
      const accounts = yield* Repositories.AccountsRepository;
      const row = yield* accounts.findById(account.id);
      assert.strictEqual(row.accessToken, "access-lazy");
      const after = yield* rawColumns(account.id);
      assert.strictEqual(kidOf(after.accessToken), "k2");
      assert.strictEqual(kidOf(after.refreshToken), "k2");
    }).pipe(Effect.provide(over(RepoRotated))),
  );

  it.effect("once migrated, the retired key can be dropped and the row still reads", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("dropped").pipe(Effect.provide(RepoK1));
      yield* Effect.gen(function* () {
        const accounts = yield* Repositories.AccountsRepository;
        yield* accounts.findById(account.id);
      }).pipe(Effect.provide(RepoRotated));
      const accounts = yield* Repositories.AccountsRepository;
      const row = yield* accounts.findTokensById(account.id);
      assert.strictEqual(row.accessToken, "access-dropped");
    }).pipe(Effect.provide(over(RepoK2Only))),
  );

  it.effect("reencryptOnRead: false leaves a stale-kid ciphertext untouched", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("no-reencrypt").pipe(Effect.provide(RepoK1));
      const accounts = yield* Repositories.AccountsRepository;
      const row = yield* accounts.findById(account.id);
      assert.strictEqual(row.accessToken, "access-no-reencrypt");
      assert.strictEqual(kidOf((yield* rawColumns(account.id)).accessToken), "k1");
    }).pipe(
      Effect.provideService(Repositories.AccountsRepositoryConfig, { reencryptOnRead: false }),
      Effect.provide(over(RepoRotated)),
    ),
  );

  it.effect("a token under a key missing from the keyset reports reason UnknownKeyId", () =>
    Effect.gen(function* () {
      const account = yield* seedAccount("unknown-kid").pipe(Effect.provide(RepoK1));
      const accounts = yield* Repositories.AccountsRepository;
      const failure = yield* accounts.findTokensById(account.id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AccountTokenUndecryptable");
      if (failure._tag === "AccountTokenUndecryptable") {
        assert.strictEqual(failure.reason, "UnknownKeyId");
      }
    }).pipe(Effect.provide(over(RepoK2Only))),
  );
});
