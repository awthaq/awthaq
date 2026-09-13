// .scratch/jwt/issues/07-keyring-and-key-persistence.md — a fresh KeyRing
// produces a key with the right shape, lazily minting on first use and
// persisting it. The same contract suite runs against `layerMemory` and
// `layerSql`, mirroring `@awthaq/admin`'s own
// `ImpersonationRecords.test.ts`.
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { JwtConfig, KeyRing, SigningKeyRecords } from "../src/index.ts";

const TestConfig = JwtConfig.config({ issuer: "https://issuer.test" });

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE jwt_signing_key (
        kid TEXT PRIMARY KEY,
        alg TEXT NOT NULL,
        publicKeyJwk TEXT NOT NULL,
        privateKeyJwk TEXT,
        createdAt TEXT NOT NULL,
        rotatedAt TEXT,
        retiresAt TEXT
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlRecords = SigningKeyRecords.layerSql.pipe(
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
