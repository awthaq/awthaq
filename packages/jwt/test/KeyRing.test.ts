// .scratch/jwt/issues/07-keyring-and-key-persistence.md — a fresh KeyRing
// produces a key with the right shape, lazily minting on first use and
// persisting it. The same contract suite runs against `layerMemory` and
// `layerSql`, mirroring `@awthaq/admin`'s own
// `ImpersonationRecords.test.ts`.
//
// BE-001 (.issues/high): `layerSql` is migrated via `Jwt.Jwt`'s own real
// `migrations` (`Migrations.run`, `@awthaq/core`) rather than a hand-rolled
// inline `CREATE TABLE` — the same conversion `RevocationStore.test.ts`
// already made, and `Jwt.ts`'s own `jwtMigrations` doc comment names this
// file as the pre-existing gap it closed "in passing." Running the full
// `Jwt.Jwt.migrations` (not just the `jwt_signing_key` migration this suite
// needs) also creates `jwt_token_revocation`, unused here but harmless —
// the same shape `RevocationStore.test.ts` already accepts in reverse.
//
// JJS-004/KRS-006/KRS-008/BAM-010: the multi-instance rotation, convergence,
// emergency-retirement and key-import suites run against both stores. Several
// `KeyRing` instances over one store are modelled by building the store (and
// config/crypto) once in the outer layer and providing a `Layer.fresh` KeyRing
// per simulated process.
import { Migrations } from "@awthaq/core";
import { Encryption, KeyProvider, SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as Jwt from "../src/Jwt.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const TestConfig = JwtConfig.config({ issuer: "https://issuer.test" });

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(Migrations.run(Jwt.Jwt.migrations)).pipe(
  Layer.provide(SqlLive),
);

// KRS-001: `layerSql` encrypts `privateKeyJwk` through the `Encryption` port.
const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AWTHAQ_ENCRYPTION_KEYS: JSON.stringify([
                { kid: "k1", key: Buffer.alloc(32, 7).toString("base64") },
              ]),
              AWTHAQ_ENCRYPTION_KEY_ID: "k1",
            },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const SqlBase = SigningKeyRecords.layerSql.pipe(
  Layer.provide(EncryptionLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

// The store plus its transaction port, built once so every KeyRing in a test
// shares one database.
const SqlRecords = SqlTransaction.layerSql.pipe(Layer.provideMerge(SqlBase));
const MemoryRecords = Layer.mergeAll(SigningKeyRecords.layerMemory, SqlTransaction.layerNoop);

const kty = (jwk: SigningKeyRecords.Jwk): unknown => jwk["kty"];
const privateField = (jwk: SigningKeyRecords.Jwk): unknown => jwk["d"];

/** Rows of the store that are still current (no `rotatedAt`). */
const currentRows = Effect.gen(function* () {
  const records = yield* SigningKeyRecords.SigningKeyRecords;
  const now = yield* DateTime.now;
  const rows = yield* records.listVerifiable(now);
  return rows.filter((row) => Option.isNone(row.rotatedAt));
});

/** A process's own KeyRing over whatever store is in the surrounding context. */
const anotherProcess = Layer.fresh(KeyRing.KeyRing.layer);

const suite = (
  name: string,
  RecordsLayer: Layer.Layer<
    SigningKeyRecords.SigningKeyRecords | SqlTransaction.SqlTransaction,
    unknown,
    never
  >,
  config: Layer.Layer<JwtConfig.JwtConfig> = TestConfig,
): void => {
  describe(name, () => {
    const Base = RecordsLayer.pipe(
      Layer.provideMerge(config),
      Layer.provideMerge(NodeCrypto.layer),
    );
    const TestLayer = KeyRing.KeyRing.layer.pipe(Layer.provideMerge(Base));

    it.effect("mints a well-formed EdDSA key on first use", () =>
      Effect.gen(function* () {
        const key = yield* KeyRing.current;
        assert.isTrue(key.kid.length > 0);
        assert.strictEqual(key.alg, "EdDSA");
        assert.strictEqual(kty(key.publicKeyJwk), "OKP");
        assert.isUndefined(privateField(key.publicKeyJwk));
        assert.isTrue(Option.isSome(key.privateKeyJwk));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("the lazily-minted key is persisted as the current row", () =>
      Effect.gen(function* () {
        const minted = yield* KeyRing.current;
        const records = yield* SigningKeyRecords.SigningKeyRecords;
        const stored = yield* records.findCurrent();
        assert.isTrue(Option.isSome(stored));
        assert.strictEqual(Option.getOrThrow(stored).kid, minted.kid);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("verifiable includes the current key", () =>
      Effect.gen(function* () {
        const current = yield* KeyRing.current;
        const all = yield* KeyRing.verifiable;
        assert.isTrue(all.some((key) => key.kid === current.kid));
      }).pipe(Effect.provide(TestLayer)),
    );

    // ---- JJS-004 / KRS-009: one current key under any interleaving ------------

    it.effect("two concurrent rotations of a key leave exactly one current key", () =>
      Effect.gen(function* () {
        yield* KeyRing.current;
        yield* Effect.all(
          [
            KeyRing.rotateNow().pipe(Effect.provide(anotherProcess)),
            KeyRing.rotateNow().pipe(Effect.provide(anotherProcess)),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual((yield* currentRows).length, 1);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("concurrent lazy first-mint from two KeyRings yields exactly one current key", () =>
      Effect.gen(function* () {
        const [a, b] = yield* Effect.all(
          [
            KeyRing.current.pipe(Effect.provide(anotherProcess)),
            KeyRing.current.pipe(Effect.provide(anotherProcess)),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(a.kid, b.kid);
        assert.strictEqual((yield* currentRows).length, 1);
      }).pipe(Effect.provide(Base)),
    );

    it.effect("a second current key is rejected with CurrentKeyConflict", () =>
      Effect.gen(function* () {
        const key = yield* KeyRing.current;
        const records = yield* SigningKeyRecords.SigningKeyRecords;
        const conflict = yield* records
          .create({
            kid: "second-current",
            alg: "EdDSA",
            publicKeyJwk: { kty: "OKP" },
            privateKeyJwk: Option.none(),
          })
          .pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "CurrentKeyConflict");
        assert.strictEqual((yield* records.findCurrent()).pipe(Option.getOrThrow).kid, key.kid);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect(
      "markRotated on an already-rotated kid leaves retiresAt unchanged and reports false",
      () =>
        Effect.gen(function* () {
          const original = yield* KeyRing.current;
          const records = yield* SigningKeyRecords.SigningKeyRecords;
          const now = yield* DateTime.now;
          const soon = DateTime.addDuration(now, Duration.days(1));
          const later = DateTime.addDuration(now, Duration.days(30));
          assert.isTrue(yield* records.markRotated(original.kid, now, soon));
          assert.isFalse(yield* records.markRotated(original.kid, now, later));
          const [row] = (yield* records.listVerifiable(now)).filter((r) => r.kid === original.kid);
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(row?.retiresAt ?? Option.none())),
            DateTime.toEpochMillis(soon),
          );
        }).pipe(Effect.provide(TestLayer)),
    );

    // ---- KRS-006: convergence on rotations made elsewhere ---------------------

    it.effect(
      "an out-of-band rotateNow on the shared store is picked up by a busy KeyRing within keyCacheMaxAge",
      () =>
        Effect.gen(function* () {
          const before = yield* KeyRing.current;
          yield* KeyRing.rotateNow().pipe(Effect.provide(anotherProcess));
          // still inside the cache window: this process has not re-read the store
          assert.strictEqual((yield* KeyRing.current).kid, before.kid);
          yield* TestClock.adjust(Duration.minutes(6));
          const after = yield* KeyRing.current;
          assert.notStrictEqual(after.kid, before.kid);
        }).pipe(Effect.provide(TestLayer)),
    );

    // ---- KRS-008 / N12: emergency retirement ----------------------------------

    it.effect("rotateNow with a zero gracePeriod drops the old kid immediately", () =>
      Effect.gen(function* () {
        const compromised = yield* KeyRing.current;
        yield* KeyRing.rotateNow({ gracePeriod: Duration.zero });
        const all = yield* KeyRing.verifiable;
        assert.isFalse(all.some((key) => key.kid === compromised.kid));
        assert.notStrictEqual((yield* KeyRing.current).kid, compromised.kid);
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("rotateNow without options keeps the old key verifying for the grace period", () =>
      Effect.gen(function* () {
        const original = yield* KeyRing.current;
        yield* KeyRing.rotateNow();
        assert.isTrue((yield* KeyRing.verifiable).some((key) => key.kid === original.kid));
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect(
      "revoke cuts an already-rotated key's grace period to now, and reports unknown kids",
      () =>
        Effect.gen(function* () {
          const original = yield* KeyRing.current;
          yield* KeyRing.rotateNow();
          assert.isTrue((yield* KeyRing.verifiable).some((key) => key.kid === original.kid));
          assert.isTrue(yield* KeyRing.revoke(original.kid));
          assert.isFalse((yield* KeyRing.verifiable).some((key) => key.kid === original.kid));
          assert.isFalse(yield* KeyRing.revoke(original.kid));
          assert.isFalse(yield* KeyRing.revoke("no-such-kid"));
        }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("revoke of the current key mints a replacement and retires it at once", () =>
      Effect.gen(function* () {
        const original = yield* KeyRing.current;
        assert.isTrue(yield* KeyRing.revoke(original.kid));
        const replacement = yield* KeyRing.current;
        assert.notStrictEqual(replacement.kid, original.kid);
        assert.isFalse((yield* KeyRing.verifiable).some((key) => key.kid === original.kid));
      }).pipe(Effect.provide(TestLayer)),
    );

    // ---- BAM-010: key import, remote registration -----------------------------

    it.effect(
      "imports a foreign RS256 key and verifies a token signed by it, without disturbing the current key",
      () =>
        Effect.gen(function* () {
          const current = yield* KeyRing.current;
          const { publicKeyJwk, privateKeyJwk } = yield* JwtCodec.generateKeyJwks("RS256");
          yield* KeyRing.importKey({ kid: "foreign-1", alg: "RS256", publicKeyJwk });
          yield* KeyRing.refresh;
          assert.strictEqual((yield* KeyRing.current).kid, current.kid);
          assert.strictEqual((yield* currentRows).length, 1);
          const keys = yield* KeyRing.verifiable;
          const foreign = keys.find((key) => key.kid === "foreign-1");
          assert.isDefined(foreign);
          const token = yield* JwtCodec.sign({
            kid: "foreign-1",
            alg: "RS256",
            typ: "at+jwt",
            signer: JwtCodec.localSigner(privateKeyJwk),
            claims: {
              iss: "https://issuer.test",
              aud: "https://issuer.test",
              exp: 4_000_000_000,
              sub: "migrated-user",
            },
          });
          const claims = yield* JwtCodec.verify({
            token,
            keys: keys.map(({ kid, alg, publicKeyJwk: jwk }) => ({ kid, alg, publicKeyJwk: jwk })),
            algorithms: ["EdDSA", "RS256"],
            issuer: "https://issuer.test",
            audience: "https://issuer.test",
            expectedTyp: "at+jwt",
          });
          assert.strictEqual(claims.sub, "migrated-user");
        }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("importKey refuses a JWK of the wrong key type or carrying private material", () =>
      Effect.gen(function* () {
        const rsa = yield* JwtCodec.generateKeyJwks("RS256");
        const wrongKty = yield* KeyRing.importKey({
          kid: "bad-1",
          alg: "EdDSA",
          publicKeyJwk: rsa.publicKeyJwk,
        }).pipe(Effect.flip);
        assert.strictEqual(wrongKty._tag, "InvalidKeyImport");
        const withPrivate = yield* KeyRing.importKey({
          kid: "bad-2",
          alg: "RS256",
          publicKeyJwk: rsa.privateKeyJwk,
        }).pipe(Effect.flip);
        assert.strictEqual(withPrivate._tag, "InvalidKeyImport");
      }).pipe(Effect.provide(TestLayer)),
    );

    it.effect("registerRemoteKey makes the remote key the single current key", () =>
      Effect.gen(function* () {
        const local = yield* KeyRing.current;
        const { publicKeyJwk } = yield* JwtCodec.generateKeyJwks("EdDSA");
        yield* KeyRing.registerRemoteKey({ kid: "remote-1", alg: "EdDSA", publicKeyJwk });
        const rows = yield* currentRows;
        assert.deepStrictEqual(
          rows.map((row) => row.kid),
          ["remote-1"],
        );
        const records = yield* SigningKeyRecords.SigningKeyRecords;
        const now = yield* DateTime.now;
        assert.isTrue((yield* records.listVerifiable(now)).some((row) => row.kid === local.kid));
        assert.isTrue(rows[0] !== undefined && Option.isNone(rows[0].privateKeyJwk));
      }).pipe(Effect.provide(TestLayer)),
    );
  });
};

suite("layerMemory", MemoryRecords);
suite("layerSql", SqlRecords);

// KRS-001 (+SMS-001-secrets-management-specialist): the private JWK is an
// `Encryption` envelope bound to its own row, never JWK JSON.
describe("layerSql private key at rest (KRS-001)", () => {
  const TestLayer = KeyRing.KeyRing.layer.pipe(
    Layer.provideMerge(SqlRecords),
    Layer.provideMerge(TestConfig),
    Layer.provideMerge(NodeCrypto.layer),
  );

  it.effect("never stores the private JWK in plaintext", () =>
    Effect.gen(function* () {
      yield* KeyRing.current;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly privateKeyJwk: string | null }>`
        SELECT privateKeyJwk FROM jwt_signing_key`;
      assert.strictEqual(rows.length, 1);
      const stored = rows[0]?.privateKeyJwk;
      assert.isString(stored);
      assert.notInclude(stored, '"d"');
      const envelope = JSON.parse(Buffer.from(stored ?? "", "base64url").toString("utf8"));
      assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "iv", "kid", "v"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a privateKeyJwk ciphertext copied onto another kid's row fails to decrypt", () =>
    Effect.gen(function* () {
      const original = yield* KeyRing.current;
      yield* KeyRing.rotateNow();
      const sql = yield* SqlClient.SqlClient;
      const records = yield* SigningKeyRecords.SigningKeyRecords;
      const [donor] = yield* sql<{ readonly privateKeyJwk: string }>`
        SELECT privateKeyJwk FROM jwt_signing_key WHERE kid = ${original.kid}`;
      yield* sql`UPDATE jwt_signing_key SET privateKeyJwk = ${donor?.privateKeyJwk ?? ""}
        WHERE kid <> ${original.kid}`;
      const exit = yield* Effect.exit(records.findCurrent());
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(TestLayer)),
  );
});

// JJS-004: the single-current guarantee lives in the schema, and a crash
// between mark and mint rolls back rather than leaving no current key.
describe("layerSql single current key (JJS-004)", () => {
  const Base = SqlRecords.pipe(
    Layer.provideMerge(TestConfig),
    Layer.provideMerge(NodeCrypto.layer),
  );

  it.effect("the migrations create the single-current unique index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly sql: string | null }>`
        SELECT sql FROM sqlite_master WHERE name = 'jwt_signing_key_single_current'`;
      assert.strictEqual(rows.length, 1);
      assert.include(rows[0]?.sql ?? "", "UNIQUE");
    }).pipe(Effect.provide(Base)),
  );

  it.effect("a failing mint after markRotated rolls back and the previous key stays current", () =>
    Effect.gen(function* () {
      const original = yield* KeyRing.current.pipe(Effect.provide(anotherProcess));
      const records = yield* SigningKeyRecords.SigningKeyRecords;
      const failNext = yield* Ref.make(false);
      const flaky: SigningKeyRecords.SigningKeyRecordsShape = {
        ...records,
        create: (input) =>
          Effect.flatMap(Ref.get(failNext), (fail) =>
            fail ? Effect.die(new Error("mint crashed")) : records.create(input),
          ),
      };
      yield* Ref.set(failNext, true);
      const exit = yield* Effect.exit(
        KeyRing.rotateNow().pipe(
          Effect.provide(anotherProcess),
          Effect.provideService(SigningKeyRecords.SigningKeyRecords, flaky),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      const stillCurrent = yield* records.findCurrent();
      assert.strictEqual(Option.getOrThrow(stillCurrent).kid, original.kid);
      assert.isTrue(Option.isNone(Option.getOrThrow(stillCurrent).rotatedAt));
    }).pipe(Effect.provide(Base)),
  );
});

describe("algorithm selection", () => {
  it.effect("mints an ES256 key when configured", () =>
    Effect.gen(function* () {
      const key = yield* KeyRing.current;
      assert.strictEqual(key.alg, "ES256");
      assert.strictEqual(kty(key.publicKeyJwk), "EC");
    }).pipe(
      Effect.provide(
        KeyRing.KeyRing.layer.pipe(
          Layer.provideMerge(MemoryRecords),
          Layer.provideMerge(
            JwtConfig.config({ issuer: "https://issuer.test", algorithm: "ES256" }),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("mints a key for every supported algorithm", () =>
    Effect.gen(function* () {
      for (const [algorithm, expected] of [
        ["ES384", "EC"],
        ["RS256", "RSA"],
        ["PS256", "RSA"],
      ] as const) {
        const key = yield* KeyRing.current.pipe(
          Effect.provide(
            KeyRing.KeyRing.layer.pipe(
              Layer.provideMerge(MemoryRecords),
              Layer.provideMerge(JwtConfig.config({ issuer: "https://issuer.test", algorithm })),
              Layer.provideMerge(NodeCrypto.layer),
            ),
          ),
        );
        assert.strictEqual(key.alg, algorithm);
        assert.strictEqual(kty(key.publicKeyJwk), expected);
      }
    }),
  );
});

// JwtConfig validation (KRS-008): a grace period shorter than the token
// lifetime would invalidate still-live tokens on every rotation.
describe("JwtConfig validation", () => {
  it.effect("dies when keyGracePeriod is shorter than ttl", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          Effect.void,
          JwtConfig.config({
            issuer: "https://issuer.test",
            ttl: Duration.hours(1),
            keyGracePeriod: Duration.minutes(10),
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

// .scratch/jwt/issues/11-key-rotation.md — automatic, time-based rotation
// at `keyRotationInterval`, a rotated-out key still verifiable through its
// `keyGracePeriod`, and an explicit `rotateNow` independent of the
// schedule.
describe("rotation", () => {
  const RotationLayer = KeyRing.KeyRing.layer.pipe(
    Layer.provideMerge(MemoryRecords),
    Layer.provideMerge(
      JwtConfig.config({
        issuer: "https://issuer.test",
        keyRotationInterval: Duration.days(90),
        keyGracePeriod: Duration.days(30),
      }),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );

  it.effect(
    "rotates automatically once past keyRotationInterval; the old key stays verifiable through its grace period, then drops out",
    () =>
      Effect.gen(function* () {
        const original = yield* KeyRing.current;

        yield* TestClock.adjust(Duration.days(91));

        const rotated = yield* KeyRing.current;
        assert.notStrictEqual(rotated.kid, original.kid);

        const duringGrace = yield* KeyRing.verifiable;
        assert.isTrue(duringGrace.some((key) => key.kid === original.kid));
        assert.isTrue(duringGrace.some((key) => key.kid === rotated.kid));

        yield* TestClock.adjust(Duration.days(31));

        const afterGrace = yield* KeyRing.verifiable;
        assert.isFalse(afterGrace.some((key) => key.kid === original.kid));
        assert.isTrue(afterGrace.some((key) => key.kid === rotated.kid));
      }).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("does not rotate before keyRotationInterval elapses", () =>
    Effect.gen(function* () {
      const original = yield* KeyRing.current;
      yield* TestClock.adjust(Duration.days(1));
      const stillCurrent = yield* KeyRing.current;
      assert.strictEqual(stillCurrent.kid, original.kid);
    }).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("rotateNow forces rotation immediately, independent of the schedule", () =>
    Effect.gen(function* () {
      const original = yield* KeyRing.current;

      yield* KeyRing.rotateNow();

      const rotated = yield* KeyRing.current;
      assert.notStrictEqual(rotated.kid, original.kid);

      const all = yield* KeyRing.verifiable;
      assert.isTrue(all.some((key) => key.kid === original.kid));
      assert.isTrue(all.some((key) => key.kid === rotated.kid));
    }).pipe(Effect.provide(RotationLayer)),
  );
});
