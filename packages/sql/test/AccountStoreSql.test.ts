// Plan 02, phase 4: what only the SQL adapter of `AccountStore` can show. What every adapter must do
// is `StoreContract.accounts` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); this is the adapter's token encryption, the identity reads that never touch it,
// the typed unreadable-token answer, and the failure mapping.
import { AccountStore, Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as AccountStoreSql from "../src/AccountStoreSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const k1 = { kid: "k1", key: key(1) };
const k2 = { kid: "k2", key: key(2) };

/** An adapter over an encryption keyset whose current key is `current`, on whatever client is ambient. */
const storeLayer = (keyset: ReadonlyArray<{ kid: string; key: string }>, current: string) =>
  AccountStoreSql.layer.pipe(
    Layer.provide(
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
      ),
    ),
  );

const over = (store: ReturnType<typeof storeLayer>) =>
  store.pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

// One database for a whole test: the old-key store writes, the rotated one reads.
const sharedDatabase = Migrated.pipe(Layer.provideMerge(SqlLive));

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const accountId = Schema.decodeUnknownSync(Models.AccountId);
const userId = Schema.decodeUnknownSync(Models.UserId);

const tokens: AccountStore.ProviderTokens = {
  accessToken: Redacted.make("access-secret"),
  refreshToken: Option.some(Redacted.make("refresh-secret")),
  idToken: Option.some(Redacted.make("id-secret")),
  accessTokenExpiresAt: Option.none(),
  refreshTokenExpiresAt: Option.none(),
  scope: Option.some("read"),
  tokenType: Option.some("Bearer"),
};

const seed = (id: string, hash?: string) =>
  Effect.flatMap(AccountStore.AccountStore, (store) =>
    store.insertIfAbsent({
      id: accountId(id),
      userId: userId("user-1"),
      providerId: "github",
      subject: `subject-${id}`,
      issuer: "",
      credentialHash: Option.fromNullishOr(hash).pipe(Option.map(Redacted.make)),
      tokens: Option.some(tokens),
      createdAt: at(0),
      updatedAt: at(0),
    }),
  );

const rawTokens = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly accessToken: string | null;
      readonly refreshToken: string | null;
      readonly idToken: string | null;
    }>`SELECT "accessToken", "refreshToken", "idToken" FROM accounts WHERE id = ${id}`;
    const row = rows[0];
    assert.isDefined(row);
    return row;
  });

const kidOf = (envelope: string | null | undefined) =>
  envelope == null
    ? undefined
    : JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")).kid;

describe("AccountStoreSql tokens at rest (BE-002, SMS-002)", () => {
  it.effect("the tokens are ciphertext in the table and plaintext through the port", () =>
    Effect.gen(function* () {
      yield* seed("a1");
      const raw = yield* rawTokens("a1");
      for (const stored of [raw.accessToken, raw.refreshToken, raw.idToken]) {
        assert.isNotNull(stored);
        assert.notInclude(stored ?? "", "secret");
      }
      const store = yield* AccountStore.AccountStore;
      const read = Option.getOrThrow(yield* store.readProviderTokens(accountId("a1")));
      assert.strictEqual(read._tag, "Tokens");
      if (read._tag === "Tokens") {
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(read.tokens).accessToken),
          "access-secret",
        );
      }
    }).pipe(Effect.provide(over(storeLayer([k1], "k1")))),
  );

  // A5/A-4: an identity read selects only the identity columns, so it neither decrypts a token nor
  // re-encrypts one under a newer key (a write on the sign-in hot path).
  it.effect("identity reads never decrypt or re-encrypt a token; the strict token read may", () =>
    Effect.gen(function* () {
      yield* seed("a1").pipe(Effect.provide(storeLayer([k1], "k1")));
      const before = yield* rawTokens("a1");
      assert.strictEqual(kidOf(before.accessToken), "k1");

      const rotated = yield* Effect.gen(function* () {
        const store = yield* AccountStore.AccountStore;
        yield* store.get(accountId("a1"));
        yield* store.getByKey("github", "subject-a1", "");
        yield* store.listByUser(userId("user-1"));
        yield* store.readCredentialHash(accountId("a1"));
        return yield* rawTokens("a1");
      }).pipe(Effect.provide(storeLayer([k1, k2], "k2")));
      assert.deepStrictEqual(rotated, before);

      // The strict read decrypts, and lazily re-encrypts the stale envelope under the current key.
      yield* Effect.flatMap(AccountStore.AccountStore, (store) =>
        store.readProviderTokens(accountId("a1")),
      ).pipe(Effect.provide(storeLayer([k1, k2], "k2")));
      assert.strictEqual(kidOf((yield* rawTokens("a1")).accessToken), "k2");
    }).pipe(Effect.provide(sharedDatabase)),
  );

  it.effect(
    "an unreadable token is a typed answer; identity reads and a fresh write are unaffected",
    () =>
      Effect.gen(function* () {
        yield* seed("a1", "$argon2id$hash");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE accounts SET "accessToken" = 'garbage' WHERE id = ${"a1"}`;
        const store = yield* AccountStore.AccountStore;
        const read = Option.getOrThrow(yield* store.readProviderTokens(accountId("a1")));
        assert.deepStrictEqual(read._tag, "Undecryptable");
        // The identity and the credential hash are readable regardless.
        assert.isTrue(Option.isSome(yield* store.get(accountId("a1"))));
        const hash = Option.getOrThrow(
          Option.getOrThrow(yield* store.readCredentialHash(accountId("a1"))),
        );
        assert.strictEqual(Redacted.value(hash), "$argon2id$hash");
        // A fresh write overwrites the unreadable value without reading it.
        assert.isTrue(yield* store.writeProviderTokens(accountId("a1"), tokens, at(5)));
        const healed = Option.getOrThrow(yield* store.readProviderTokens(accountId("a1")));
        assert.strictEqual(healed._tag, "Tokens");
      }).pipe(Effect.provide(over(storeLayer([k1], "k1")))),
  );
});

describe("AccountStoreSql failure mapping (MA-004)", () => {
  const outage = () =>
    new SqlError({ reason: new UnknownError({ cause: new Error("connection reset") }) });

  const DownRepository = Layer.effect(
    Repositories.AccountsRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.AccountsRepository;
      return {
        ...real,
        insertIdentityIfAbsent: () => Effect.fail(outage()),
        findIdentityById: () => Effect.fail(outage()),
        findIdentityByKey: () => Effect.fail(outage()),
        listIdentitiesByUser: () => Effect.fail(outage()),
        findPasswordHash: () => Effect.fail(outage()),
        findTokensById: () => Effect.fail(outage()),
        writePasswordHash: () => Effect.fail(outage()),
        writeTokens: () => Effect.fail(outage()),
        deleteAllByUser: () => Effect.fail(outage()),
      };
    }),
  ).pipe(
    Layer.provide(
      Repositories.AccountsRepositoryLive.pipe(
        Layer.provide(
          Encryption.layer.pipe(
            Layer.provide(
              KeyProvider.layerEnv.pipe(
                Layer.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromEnv({
                      env: { AWTHAQ_ENCRYPTION_KEY: key(7) },
                    }),
                  ),
                ),
              ),
            ),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
    ),
  );

  const DownStore = AccountStoreSql.layer.pipe(
    Layer.provide(DownRepository),
    Layer.provide(SqlLive),
    Layer.provide(Migrated),
  );

  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const id = accountId("a1");
      const failures = {
        insertIfAbsent: yield* seed("a1").pipe(Effect.flip),
        get: yield* store.get(id).pipe(Effect.flip),
        getByKey: yield* store.getByKey("github", "s", "").pipe(Effect.flip),
        listByUser: yield* store.listByUser(userId("u1")).pipe(Effect.flip),
        readCredentialHash: yield* store.readCredentialHash(id).pipe(Effect.flip),
        readProviderTokens: yield* store.readProviderTokens(id).pipe(Effect.flip),
        writeCredentialHash: yield* store
          .writeCredentialHash(id, Redacted.make("h"), at(1))
          .pipe(Effect.flip),
        writeProviderTokens: yield* store.writeProviderTokens(id, tokens, at(1)).pipe(Effect.flip),
        deleteByUser: yield* store.deleteByUser(userId("u1")).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `AccountStore.${primitive}`);
      }
    }).pipe(Effect.provide(DownStore)),
  );
});
