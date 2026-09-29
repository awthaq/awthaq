// BAM-004: a better-auth `${saltHex}:${keyHex}` credential verifies after import.
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { scryptSync } from "node:crypto";
import * as BetterAuthScryptVerifier from "../src/BetterAuthScryptVerifier.ts";

// TTE-005: a bare string is not a stored hash; these tests mint the ones they hand the hasher.
const mint = PasswordHasher.PhcHash;

// Produced by better-auth's own recipe (NFKC password, the hex salt string as the
// salt, N=16384 r=16 p=1, 64-byte key), via node:crypto rather than hash-wasm so the
// verifier is checked against an independent implementation.
const SALT = "00112233445566778899aabbccddeeff";
const FIXTURE = `${SALT}:e7c6c267a71783f5e5a66fd2bb7a7156d70e1f3c7c79c127a12ecbea5dfd40f05b701b8b29b628f62c723f1cab9964a0440fa7809197fada4d783d8bdb2b1347`;
const UNICODE_FIXTURE = `${SALT}:98019d8d367509640e45a459ea9b23f32452dd310114f46daee657ebe74a7fe5a2ba724b8382f9a2ef80cd44dd048eb79ff35d9db1d8dd22aeae2d681eb0962e`;

const verifier = BetterAuthScryptVerifier.betterAuthScryptVerifier;

describe("BetterAuthScryptVerifier", () => {
  it("the fixture really is better-auth's recipe", () => {
    const key = scryptSync("ExistingUser123!".normalize("NFKC"), SALT, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 128 * 16384 * 16 * 2,
    });
    assert.strictEqual(`${SALT}:${key.toString("hex")}`, FIXTURE);
  });

  it("recognizes a better-auth hash but not argon2id, scrypt or bcrypt strings", () => {
    assert.isTrue(verifier.recognizes(mint(FIXTURE)));
    assert.isFalse(verifier.recognizes(mint("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")));
    assert.isFalse(verifier.recognizes(mint("$scrypt$ln=17,r=8,p=1$c2FsdA==$deadbeef")));
    assert.isFalse(verifier.recognizes(mint("$2b$10$abcdefghijklmnopqrstuv")));
    assert.isFalse(verifier.recognizes(mint(`${SALT}:short`)));
    assert.isFalse(verifier.recognizes(mint("")));
  });

  it.effect("verifies the right password, rejects the wrong one", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* verifier.verify(Redacted.make("ExistingUser123!"), mint(FIXTURE)));
      assert.isFalse(yield* verifier.verify(Redacted.make("existinguser123!"), mint(FIXTURE)));
    }),
  );

  it.effect("normalizes the password to NFKC like better-auth does", () =>
    Effect.gen(function* () {
      // "pässwörd" written with combining marks normalizes to the precomposed form the fixture used.
      const decomposed = "pässwörd";
      assert.isTrue(yield* verifier.verify(Redacted.make(decomposed), mint(UNICODE_FIXTURE)));
    }),
  );

  it.effect(
    "wired into layerArgon2id: legacy hash verifies and is flagged for rehash; native hashes are unaffected",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isTrue(yield* hasher.verify(Redacted.make("ExistingUser123!"), mint(FIXTURE)));
        assert.isFalse(yield* hasher.verify(Redacted.make("wrong"), mint(FIXTURE)));
        assert.isTrue(hasher.needsRehash(mint(FIXTURE)));
        const native = yield* hasher.hash(Redacted.make("native-password"));
        assert.isTrue(yield* hasher.verify(Redacted.make("native-password"), native));
        assert.isFalse(hasher.needsRehash(native));
      }).pipe(
        Effect.provide(
          PasswordHasher.layerArgon2id.pipe(
            Layer.provideMerge(BetterAuthScryptVerifier.layer),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
  );
});
