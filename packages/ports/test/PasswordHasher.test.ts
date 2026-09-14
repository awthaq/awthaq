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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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
