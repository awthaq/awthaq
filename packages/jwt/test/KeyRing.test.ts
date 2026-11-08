// .scratch/jwt/issues/07-keyring-and-key-persistence.md — a fresh KeyRing
// produces a key with the right shape, lazily minting on first use and
// persisting it. The same contract suite runs against `layerMemory` and
// `layerSql`, mirroring `@awthaq/admin`'s own
// `ImpersonationRecords.test.ts`.
//
// BE-001 (.issues/high): `layerSql` is migrated via `Jwt.Jwt`'s own real
// `migrations` (`Migrations.run`, `@awthaq/core`) rather than a hand-rolled
// inline `CREATE TABLE`.
//
// Plan 25 ticket 20: the store's own contract (every `SigningKeyRecords`
// operation, the single-current and `kid` races, the indexes) is
// `test/contract/SigningKeyRecords.ts`, run from `Contract.test.ts`; what stays
// here is the ring on top of it. Not over `RecordsContract.recordsBase`: its mode
// union does not promise `SqlClient` to the type checker, and the ring needs
// `SqlTransaction.layerSql` over the very client the store uses.
//
// JJS-004/KRS-006/KRS-008/BAM-010: the multi-instance rotation, convergence,
// emergency-retirement and key-import suites run against both stores. Several
// `KeyRing` instances over one store are modelled by building the store (and
// config/crypto) once in the outer layer and providing a `Layer.fresh` KeyRing
// per simulated process.
import { Migrations } from "@awthaq/core";
import { Encryption, KeyProvider, SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as Jwt from "../src/Jwt.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";
import { TestSql } from "@awthaq/test";
import { SigningKeyRecordsLive } from "./support.ts";

const TestConfig = JwtConfig.config({ issuer: "https://issuer.test" });

const SqlLive = TestSql.layer("jwt_KeyRing");

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
const MemoryRecords = Layer.mergeAll(SigningKeyRecordsLive, SqlTransaction.layerNoop);

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

    // ---- plan 24 R6 / Q3: a kid names one key forever ---------------------------

    it.effect(
      "registering the same remote key again is a no-op: it stays the one current key and nothing is rotated",
      () =>
        Effect.gen(function* () {
          const local = yield* KeyRing.current;
          const { publicKeyJwk } = yield* JwtCodec.generateKeyJwks("EdDSA");
          const first = yield* KeyRing.registerRemoteKey({
            kid: "remote-1",
            alg: "EdDSA",
            publicKeyJwk,
          });
          yield* TestClock.adjust(Duration.hours(1));
          const again = yield* KeyRing.registerRemoteKey({
            kid: "remote-1",
            alg: "EdDSA",
            publicKeyJwk,
          });
          assert.strictEqual(
            DateTime.toEpochMillis(again.createdAt),
            DateTime.toEpochMillis(first.createdAt),
          );
          assert.deepStrictEqual(
            (yield* currentRows).map((row) => row.kid),
            ["remote-1"],
          );
          const records = yield* SigningKeyRecords.SigningKeyRecords;
          const localRow = Option.getOrThrow(yield* records.findByKid(local.kid));
          assert.isTrue(Option.isSome(localRow.rotatedAt));
        }).pipe(Effect.provide(TestLayer)),
    );

    it.effect(
      "a different key under a stored kid fails KidTaken from registerRemoteKey and importKey, rotating and writing nothing",
      () =>
        Effect.gen(function* () {
          const local = yield* KeyRing.current;
          const remote = yield* JwtCodec.generateKeyJwks("EdDSA");
          const other = yield* JwtCodec.generateKeyJwks("EdDSA");
          const records = yield* SigningKeyRecords.SigningKeyRecords;
          // The local current key's kid, under a remote public key.
          const overCurrent = yield* KeyRing.registerRemoteKey({
            kid: local.kid,
            alg: "EdDSA",
            publicKeyJwk: remote.publicKeyJwk,
          }).pipe(Effect.flip);
          assert.strictEqual(overCurrent._tag, "SigningKeyRecords/KidTaken");
          const importedOverCurrent = yield* KeyRing.importKey({
            kid: local.kid,
            alg: "EdDSA",
            publicKeyJwk: remote.publicKeyJwk,
          }).pipe(Effect.flip);
          assert.strictEqual(importedOverCurrent._tag, "SigningKeyRecords/KidTaken");
          assert.deepStrictEqual(
            (yield* currentRows).map((row) => row.kid),
            [local.kid],
          );
          assert.isTrue(
            Option.isSome(Option.getOrThrow(yield* records.findByKid(local.kid)).privateKeyJwk),
          );
          // An imported key's kid, under another public key: refused, the current key not rotated.
          yield* KeyRing.importKey({
            kid: "foreign",
            alg: "EdDSA",
            publicKeyJwk: remote.publicKeyJwk,
          });
          const overImported = yield* KeyRing.registerRemoteKey({
            kid: "foreign",
            alg: "EdDSA",
            publicKeyJwk: other.publicKeyJwk,
          }).pipe(Effect.flip);
          assert.strictEqual(overImported._tag, "SigningKeyRecords/KidTaken");
          assert.deepStrictEqual(
            (yield* currentRows).map((row) => row.kid),
            [local.kid],
          );
          // The same foreign key imported again is a no-op.
          const reimported = yield* KeyRing.importKey({
            kid: "foreign",
            alg: "EdDSA",
            publicKeyJwk: remote.publicKeyJwk,
          });
          assert.strictEqual(reimported.kid, "foreign");
        }).pipe(Effect.provide(TestLayer)),
    );

    it.effect(
      "8 concurrent registrations of one remote key leave it the one current key, the local key rotated once",
      () =>
        Effect.gen(function* () {
          const local = yield* KeyRing.current;
          const { publicKeyJwk } = yield* JwtCodec.generateKeyJwks("EdDSA");
          const records = yield* SigningKeyRecords.SigningKeyRecords;
          const outcomes = yield* Effect.all(
            Array.from({ length: 8 }, () =>
              KeyRing.registerRemoteKey({ kid: "remote-1", alg: "EdDSA", publicKeyJwk }),
            ),
            { concurrency: "unbounded" },
          );
          assert.isTrue(outcomes.every((record) => record.kid === "remote-1"));
          assert.deepStrictEqual(
            (yield* currentRows).map((row) => row.kid),
            ["remote-1"],
          );
          assert.isTrue(
            Option.isSome(Option.getOrThrow(yield* records.findByKid(local.kid)).rotatedAt),
          );
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
// KRS-001 and plan 05: the private JWK is a sealed column. That the stored value is an envelope bound to its
// row, opens to what was written and re-seals after an encryption-key rotation is the substrate's suite
// (`runSealedColumnTests`, below); what stays here is the ring's own behaviour on top of it.
const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => assert.fail(message),
};

const sampleJwk = { kty: "OKP", crv: "Ed25519", d: "private-scalar", x: "public-point" };

const writeKey = (kid: string, value: Record<string, unknown>) =>
  Effect.flatMap(SigningKeyRecords.SigningKeyRecords, (records) =>
    Effect.asVoid(
      records.create({
        kid,
        alg: "EdDSA",
        publicKeyJwk: { kty: "OKP", x: "public-point" },
        privateKeyJwk: Option.some(Redacted.make(value)),
        // Rotated at once, so two rows never compete for the single current slot.
        rotated: {
          rotatedAt: DateTime.makeUnsafe(0),
          retiresAt: DateTime.makeUnsafe(4_000_000_000_000),
        },
      }),
    ),
  );
const readKey = (kid: string) =>
  Effect.flatMap(SigningKeyRecords.SigningKeyRecords, (records) =>
    Effect.map(records.listVerifiable(DateTime.makeUnsafe(1)), (rows) =>
      Option.getOrThrow(
        Option.flatMap(
          Option.fromNullishOr(rows.find((row) => row.kid === kid)),
          (row) => row.privateKeyJwk,
        ),
      ),
    ),
  );

TestAuth.runSealedColumnTests<
  Record<string, unknown>,
  SigningKeyRecords.SigningKeyRecords | SigningKeyRecords.MemoryEnvelopes
>(vitestFramework, {
  column: SigningKeyRecords.privateKeyJwkColumn,
  sample: sampleJwk,
  adapters: [
    {
      name: "layerMemory",
      layer: SigningKeyRecords.layerMemory,
      raw: (kid) => Effect.flatMap(SigningKeyRecords.MemoryEnvelopes, (rows) => rows.stored(kid)),
      plant: (kid, stored) =>
        Effect.flatMap(SigningKeyRecords.MemoryEnvelopes, (rows) => rows.plant(kid, stored)),
    },
  ],
  write: writeKey,
  read: readKey,
});

TestAuth.runSealedColumnTests<
  Record<string, unknown>,
  SigningKeyRecords.SigningKeyRecords | SqlClient.SqlClient
>(vitestFramework, {
  column: SigningKeyRecords.privateKeyJwkColumn,
  sample: sampleJwk,
  adapters: [
    {
      name: "layerSql",
      layer: SigningKeyRecords.layerSql.pipe(
        Layer.provideMerge(SqlLive),
        Layer.provideMerge(Migrated),
      ),
      raw: (kid) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            readonly value: string;
          }>`SELECT "privateKeyJwk" AS value FROM jwt_signing_key WHERE kid = ${kid}`;
          return rows[0]?.value ?? "";
        }),
      plant: (kid, stored) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE jwt_signing_key SET "privateKeyJwk" = ${stored} WHERE kid = ${kid}`;
        }),
    },
  ],
  write: writeKey,
  read: readKey,
});

describe("a signing key sealed under a retired encryption key (plan 05)", () => {
  // Before the substrate a rotated AWTHAQ_ENCRYPTION_KEY_ID left every signing key on the retired kid
  // forever, so the old key could never be dropped. Now the key re-seals when the ring next reads it.
  it.effect("is re-sealed to the current encryption key the next time it is read", () =>
    Effect.gen(function* () {
      let current = "k1";
      const material = (kid: string): KeyProvider.KeyMaterial => ({
        kid,
        key: Redacted.make(new Uint8Array(32).fill(kid === "k1" ? 11 : 22)),
      });
      const provider = KeyProvider.KeyProvider.of({
        currentKey: Effect.sync(() => material(current)),
        getKey: (kid) =>
          kid === "k1" || kid === "k2"
            ? Effect.succeed(material(kid))
            : Effect.fail(new KeyProvider.UnknownKeyId({ kid })),
      });
      const rotating = Encryption.layer.pipe(
        Layer.provide(Layer.succeed(KeyProvider.KeyProvider, provider)),
        Layer.provide(NodeCrypto.layer),
      );
      const kidAtRest = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly value: string;
        }>`SELECT "privateKeyJwk" AS value FROM jwt_signing_key`;
        return JSON.parse(Buffer.from(rows[0]?.value ?? "", "base64url").toString("utf8")).kid;
      });
      const layer = SigningKeyRecords.layerSql.pipe(
        Layer.provide(rotating),
        Layer.provideMerge(SqlLive),
        Layer.provideMerge(Migrated),
      );
      yield* Effect.gen(function* () {
        const records = yield* SigningKeyRecords.SigningKeyRecords;
        yield* writeKey("retired-kid", sampleJwk);
        assert.strictEqual(yield* kidAtRest, "k1");
        current = "k2";
        yield* (yield* readKey("retired-kid")).open;
        assert.strictEqual(yield* kidAtRest, "k2");
        assert.isDefined(records);
      }).pipe(Effect.provide(layer));
    }),
  );
});

// JJS-004: the single-current guarantee lives in the schema, and a crash
// between mark and mint rolls back rather than leaving no current key.
describe("layerSql single current key (JJS-004)", () => {
  const Base = SqlRecords.pipe(
    Layer.provideMerge(TestConfig),
    Layer.provideMerge(NodeCrypto.layer),
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

// Plan 17: the plugin declares its sealed column, so `auth.sealedColumns` (the `also` of a rotation sweep) lists it.
describe("SigningKeyRecords sealed column declaration", () => {
  it("the plugin declares the signing key's private JWK", () => {
    assert.deepStrictEqual(Jwt.Jwt.sealedColumns, [SigningKeyRecords.privateKeyJwkColumn]);
  });
});
