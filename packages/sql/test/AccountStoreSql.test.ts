// Plan 02, phase 4: what only the SQL adapter of `AccountStore` can show. What every adapter must do
// is `StoreContract.accounts` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); this is the adapter's token encryption, the identity reads that never touch it,
// the typed unreadable-token answer, and the failure mapping.
import { AccountStore, Encryption, KeyProvider, Sealed } from "@awthaq/ports";
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
import { UnknownError } from "effect/unstable/sql/SqlError";
import * as AccountStoreSql from "../src/AccountStoreSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as FaultySql from "./support/FaultySql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const migrate = Migrator.make({})({ loader: CoreMigrations.coreMigrations });
const Migrated = Layer.effectDiscard(migrate).pipe(Layer.provide(SqlLive));

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const k1 = { kid: "k1", key: key(1) };
const k2 = { kid: "k2", key: key(2) };

/** An adapter over an encryption keyset whose current key is `current`, on whatever client is ambient. */
const storeLayer = (keyset: ReadonlyArray<{ kid: string; key: string }>, current: string) =>
  AccountStoreSql.layer.pipe(
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

      // The strict read hands the tokens over sealed; opening one lazily re-seals the stale envelope
      // under the current key.
      yield* Effect.gen(function* () {
        const store = yield* AccountStore.AccountStore;
        const read = Option.getOrThrow(
          Option.getOrThrow(yield* store.readProviderTokens(accountId("a1"))),
        );
        const unopened = yield* rawTokens("a1");
        assert.strictEqual(kidOf(unopened.accessToken), "k1", "reading does not decrypt");
        assert.strictEqual(Redacted.value(yield* read.accessToken.open), "access-secret");
      }).pipe(Effect.provide(storeLayer([k1, k2], "k2")));
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
        const read = Option.getOrThrow(
          Option.getOrThrow(yield* store.readProviderTokens(accountId("a1"))),
        );
        const unreadable = yield* read.accessToken.open.pipe(Effect.flip);
        assert.strictEqual(unreadable.reason, "DecryptionFailed");
        // The identity and the credential hash are readable regardless.
        assert.isTrue(Option.isSome(yield* store.get(accountId("a1"))));
        const hash = Option.getOrThrow(
          Option.getOrThrow(yield* store.readCredentialHash(accountId("a1"))),
        );
        assert.strictEqual(Redacted.value(hash), "$argon2id$hash");
        // A fresh write overwrites the unreadable value without reading it.
        assert.isTrue(yield* store.writeProviderTokens(accountId("a1"), tokens, at(5)));
        const healed = Option.getOrThrow(
          Option.getOrThrow(yield* store.readProviderTokens(accountId("a1"))),
        );
        assert.strictEqual(Redacted.value(yield* healed.accessToken.open), "access-secret");
      }).pipe(Effect.provide(over(storeLayer([k1], "k1")))),
  );

  // Ticket 18 / BAM-008: the three token columns, idToken included, are ciphertext at rest.
  it.effect("the three token columns are ciphertext at rest and open to the plaintext", () =>
    Effect.gen(function* () {
      yield* seed("a1");
      const raw = yield* rawTokens("a1");
      for (const [column, plaintext] of [
        [raw.accessToken, "access-secret"],
        [raw.refreshToken, "refresh-secret"],
        [raw.idToken, "id-secret"],
      ] as const) {
        assert.isString(column);
        assert.notInclude(column, plaintext);
        assert.strictEqual(kidOf(column), "k1");
      }
      const store = yield* AccountStore.AccountStore;
      const read = Option.getOrThrow(
        Option.getOrThrow(yield* store.readProviderTokens(accountId("a1"))),
      );
      assert.strictEqual(Redacted.value(yield* read.accessToken.open), "access-secret");
      assert.strictEqual(
        Redacted.value(yield* Sealed.orDie(Option.getOrThrow(read.idToken).open)),
        "id-secret",
      );
    }).pipe(Effect.provide(over(storeLayer([k1], "k1")))),
  );

  // Plan 17: the AAD is `accounts:<id>:<field>`, so a ciphertext copied to another account is unreadable.
  it.effect(
    "writeProviderTokens seals under the row's own AAD; a token moved to another row is unreadable",
    () =>
      Effect.gen(function* () {
        const store = yield* AccountStore.AccountStore;
        const sql = yield* SqlClient.SqlClient;
        yield* seed("a1");
        yield* seed("a2");
        yield* store.writeProviderTokens(accountId("a1"), tokens, at(2));
        const donor = yield* rawTokens("a1");
        yield* sql`UPDATE accounts SET "accessToken" = ${donor.accessToken} WHERE id = ${"a2"}`;
        const moved = Option.getOrThrow(
          Option.getOrThrow(yield* store.readProviderTokens(accountId("a2"))),
        );
        const failure = yield* moved.accessToken.open.pipe(Effect.flip);
        assert.strictEqual(failure.reason, "DecryptionFailed");
        // The owner still reads its own.
        const own = Option.getOrThrow(
          Option.getOrThrow(yield* store.readProviderTokens(accountId("a1"))),
        );
        assert.strictEqual(Redacted.value(yield* own.accessToken.open), "access-secret");
      }).pipe(Effect.provide(over(storeLayer([k1], "k1")))),
  );
});

describe("AccountStoreSql failure mapping (MA-004)", () => {
  const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));
  const DownStore = storeLayer([{ kid: "k7", key: key(7) }], "k7").pipe(
    Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
    Layer.provideMerge(Faulty),
  );

  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* AccountStore.AccountStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: Number.POSITIVE_INFINITY,
        reason: new UnknownError({ cause: new Error("connection reset") }),
      });
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
        deleteUnlessLast: yield* store.deleteUnlessLast(id, true).pipe(Effect.flip),
        deleteByUser: yield* store.deleteByUser(userId("u1")).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `AccountStore.${primitive}`);
      }
    }).pipe(Effect.provide(DownStore)),
  );
});
