// See src/PasswordHasher.ts's own header comment for what this port is
// grounded in (no BEH-EA range is allocated for the Ports stratum yet).
//
// `layerArgon2id` and `layerScrypt` both implement the identical
// `PasswordHasherShape` contract, so the same suite runs against each,
// parametrized — the same pattern `packages/core/test/Users.test.ts` etc.
// use for `layerMemory`/`layerSql`.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { argon2i, argon2id } from "hash-wasm";
import * as PasswordHasher from "../src/PasswordHasher.ts";

const suite = (
  name: string,
  layer: Layer.Layer<PasswordHasher.PasswordHasher, Config.ConfigError, never>,
  // A hand-built hash string, syntactically valid for this algorithm's own
  // parser, whose embedded work-factor parameters don't match the layer's
  // default config — proves `needsRehash` compares against the *live*
  // configured target, not just "did this parse at all".
  staleHash: string,
) => {
  describe(name, () => {
    it.effect("hashes and verifies a matching password", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = yield* hasher.hash(Redacted.make("correct horse battery staple"));
        assert.isTrue(yield* hasher.verify(Redacted.make("correct horse battery staple"), phc));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("rejects a wrong password", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = yield* hasher.hash(Redacted.make("correct horse battery staple"));
        assert.isFalse(yield* hasher.verify(Redacted.make("wrong password"), phc));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("rejects a malformed/foreign hash string without dying", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isFalse(yield* hasher.verify(Redacted.make("anything"), "not-a-real-hash"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("two hashes of the same password differ (salted)", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const a = yield* hasher.hash(Redacted.make("same password"));
        const b = yield* hasher.hash(Redacted.make("same password"));
        assert.notStrictEqual(a, b);
        // ...but both still verify.
        assert.isTrue(yield* hasher.verify(Redacted.make("same password"), a));
        assert.isTrue(yield* hasher.verify(Redacted.make("same password"), b));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("needsRehash is false for a hash produced under the current config", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = yield* hasher.hash(Redacted.make("same password"));
        assert.isFalse(hasher.needsRehash(phc));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("needsRehash is true for an unrecognized hash string", () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isTrue(hasher.needsRehash("$2b$10$not-this-algorithm-at-all"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "needsRehash is true for a hash whose own embedded params don't match the current config",
      () =>
        Effect.gen(function* () {
          const hasher = yield* PasswordHasher.PasswordHasher;
          assert.isTrue(hasher.needsRehash(staleHash));
        }).pipe(Effect.provide(layer)),
    );
  });
};

suite(
  "layerArgon2id",
  PasswordHasher.layerArgon2id.pipe(Layer.provide(NodeCrypto.layer)),
  "$argon2id$v=19$m=512,t=1,p=1$c29tZXNhbHQ$c29tZWhhc2g",
);

suite(
  "layerScrypt",
  PasswordHasher.layerScrypt.pipe(Layer.provide(NodeCrypto.layer)),
  "$scrypt$ln=4,r=8,p=1$c29tZXNhbHQ=$deadbeef",
);

const withEnv = (env: Record<string, string>) =>
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const argon2Layer = (env: Record<string, string> = {}) =>
  PasswordHasher.layerArgon2id.pipe(Layer.provide(NodeCrypto.layer), withEnv(env));

const scryptLayer = (env: Record<string, string> = {}) =>
  PasswordHasher.layerScrypt.pipe(Layer.provide(NodeCrypto.layer), withEnv(env));

const salt = new Uint8Array(16).fill(7);

// A syntactically valid argon2id string whose digest is 32 bytes (43 unpadded base64 chars).
const argon2String = (params: string) =>
  `$argon2id$v=19$${params}$c29tZXNhbHRzb21lc2FsdA$${"A".repeat(43)}`;

describe("timingSafeEqualBytes (PHS-001)", () => {
  it("is true for equal bytes and false for a differing byte or a different length", () => {
    const abc = new Uint8Array([1, 2, 3]);
    assert.isTrue(PasswordHasher.timingSafeEqualBytes(abc, new Uint8Array([1, 2, 3])));
    assert.isFalse(PasswordHasher.timingSafeEqualBytes(abc, new Uint8Array([1, 2, 4])));
    assert.isFalse(PasswordHasher.timingSafeEqualBytes(abc, new Uint8Array([1, 2])));
  });
});

describe("layerArgon2id own parse/compare path (PHS-001)", () => {
  it.effect("accepts a hash with a non-default digest length and rejects a bit-flipped digest", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      const phc = yield* Effect.promise(() =>
        argon2id({
          password: "pw",
          salt,
          iterations: 2,
          parallelism: 1,
          memorySize: 19_456,
          hashLength: 64,
          outputType: "encoded",
        }),
      );
      assert.isTrue(yield* hasher.verify(Redacted.make("pw"), phc));
      const digestStart = phc.lastIndexOf("$") + 1;
      // Changing the first character changes the first decoded byte, never the length.
      const flipped =
        phc.slice(0, digestStart) +
        (phc[digestStart] === "A" ? "B" : "A") +
        phc.slice(digestStart + 1);
      assert.isFalse(yield* hasher.verify(Redacted.make("pw"), flipped));
    }).pipe(Effect.provide(argon2Layer())),
  );

  it.effect("rejects a non-argon2id encoding instead of verifying it", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      const phc = yield* Effect.promise(() =>
        argon2i({
          password: "pw",
          salt,
          iterations: 2,
          parallelism: 1,
          memorySize: 19_456,
          hashLength: 32,
          outputType: "encoded",
        }),
      );
      assert.isFalse(yield* hasher.verify(Redacted.make("pw"), phc));
    }).pipe(Effect.provide(argon2Layer())),
  );
});

describe("stored-hash cost ceilings (ACS-006/PHS-007)", () => {
  it.effect(
    "argon2id verify of a hash claiming m=4194304 returns false without running the KDF",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const bomb = argon2String("m=4194304,t=2,p=1");
        assert.isFalse(yield* hasher.verify(Redacted.make("pw"), bomb));
        assert.isTrue(hasher.needsRehash(bomb));
      }).pipe(Effect.provide(argon2Layer())),
    2_000,
  );

  it.effect(
    "scrypt verify of a hash claiming ln=25 returns false without running the KDF",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const bomb = "$scrypt$ln=25,r=8,p=1$c29tZXNhbHQ=$deadbeef";
        assert.isFalse(yield* hasher.verify(Redacted.make("pw"), bomb));
        assert.isTrue(hasher.needsRehash(bomb));
      }).pipe(Effect.provide(scryptLayer())),
    2_000,
  );

  it.effect("the layer build dies when a ceiling is below the configured target", () =>
    Effect.gen(function* () {
      const argon = yield* Effect.exit(
        Layer.build(argon2Layer({ AUTH_ARGON2_MAX_MEMORY_KIB: "1000" })).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(argon));
      const scryptExit = yield* Effect.exit(
        Layer.build(scryptLayer({ AUTH_SCRYPT_MAX_COST_LOG2: "10" })).pipe(Effect.scoped),
      );
      assert.isTrue(Exit.isFailure(scryptExit));
    }),
  );
});

describe("rehash policy (PHS-002)", () => {
  // Stronger than the default target on every axis the floor looks at.
  const strongerArgon2 = argon2String("m=65536,t=4,p=1");
  const strongerScrypt = "$scrypt$ln=18,r=8,p=1$c29tZXNhbHQ=$deadbeef";

  it.effect("under the default floor policy a stronger stored hash is not rewritten", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      assert.isFalse(hasher.needsRehash(strongerArgon2));
    }).pipe(Effect.provide(argon2Layer())),
  );

  it.effect("under the exact policy a differing hash is rewritten", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      assert.isTrue(hasher.needsRehash(strongerArgon2));
    }).pipe(Effect.provide(argon2Layer({ AUTH_PASSWORD_REHASH_POLICY: "exact" }))),
  );

  it.effect("a below-floor hash is rewritten, and p alone never triggers the floor", () =>
    Effect.gen(function* () {
      const hasher = yield* PasswordHasher.PasswordHasher;
      assert.isTrue(hasher.needsRehash(argon2String("m=19456,t=1,p=1")));
      assert.isFalse(hasher.needsRehash(argon2String("m=19456,t=2,p=4")));
    }).pipe(Effect.provide(argon2Layer())),
  );

  it.effect("scrypt: floor keeps a stronger hash, exact rewrites it", () =>
    Effect.gen(function* () {
      const needsRehash = Effect.map(PasswordHasher.PasswordHasher, (hasher) =>
        hasher.needsRehash(strongerScrypt),
      );
      assert.isFalse(yield* Effect.provide(needsRehash, scryptLayer()));
      assert.isTrue(
        yield* Effect.provide(needsRehash, scryptLayer({ AUTH_PASSWORD_REHASH_POLICY: "exact" })),
      );
    }),
  );
});
