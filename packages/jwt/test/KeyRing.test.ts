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
import { Migrations } from "@awthaq/core";
import { Encryption, KeyProvider } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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

const SqlRecords = SigningKeyRecords.layerSql.pipe(
  Layer.provide(EncryptionLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const kty = (jwk: SigningKeyRecords.Jwk): unknown => (jwk as { kty?: unknown }).kty;
const privateField = (jwk: SigningKeyRecords.Jwk): unknown => (jwk as { d?: unknown }).d;

const suite = (
  name: string,
  RecordsLayer: Layer.Layer<SigningKeyRecords.SigningKeyRecords, unknown, never>,
): void => {
  describe(name, () => {
    const TestLayer = KeyRing.KeyRing.layer.pipe(
      Layer.provideMerge(RecordsLayer),
      Layer.provideMerge(TestConfig),
      Layer.provideMerge(NodeCrypto.layer),
    );

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
  });
};

suite("layerMemory", SigningKeyRecords.layerMemory);
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
      yield* KeyRing.rotateNow;
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

describe("algorithm selection", () => {
  it.effect("mints an ES256 key when configured", () =>
    Effect.gen(function* () {
      const key = yield* KeyRing.current;
      assert.strictEqual(key.alg, "ES256");
      assert.strictEqual(kty(key.publicKeyJwk), "EC");
    }).pipe(
      Effect.provide(
        KeyRing.KeyRing.layer.pipe(
          Layer.provideMerge(SigningKeyRecords.layerMemory),
          Layer.provideMerge(
            JwtConfig.config({ issuer: "https://issuer.test", algorithm: "ES256" }),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    ),
  );
});

// .scratch/jwt/issues/11-key-rotation.md — automatic, time-based rotation
// at `keyRotationInterval`, a rotated-out key still verifiable through its
// `keyGracePeriod`, and an explicit `rotateNow` independent of the
// schedule.
describe("rotation", () => {
  const RotationLayer = KeyRing.KeyRing.layer.pipe(
    Layer.provideMerge(SigningKeyRecords.layerMemory),
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

      yield* KeyRing.rotateNow;

      const rotated = yield* KeyRing.current;
      assert.notStrictEqual(rotated.kid, original.kid);

      const all = yield* KeyRing.verifiable;
      assert.isTrue(all.some((key) => key.kid === original.kid));
      assert.isTrue(all.some((key) => key.kid === rotated.kid));
    }).pipe(Effect.provide(RotationLayer)),
  );
});
