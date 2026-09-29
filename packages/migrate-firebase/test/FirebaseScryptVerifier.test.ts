// FAMS-001: Firebase's modified scrypt verifies, is clamped, and is rehashed after import.
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FirebaseScryptVerifier from "../src/FirebaseScryptVerifier.ts";

// TTE-005: a bare string is not a stored hash; these tests mint the ones they hand the hasher.
const mint = PasswordHasher.PhcHash;

// The published test vector from github.com/firebase/scrypt (and the
// `firebase-scrypt` npm package's README): password, per-user salt, project
// hash_config, and the hash Firebase produces for them.
const config: FirebaseScryptVerifier.FirebaseHashConfig = {
  signerKey:
    "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
  saltSeparator: "Bw==",
  rounds: 8,
  memCost: 14,
};
const salt = "42xEC+ixf3L2lw==";
const passwordHash =
  "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==";
const stored = FirebaseScryptVerifier.encodeHash({ passwordHash, salt, config });

const verifier = FirebaseScryptVerifier.firebaseScryptVerifier;

describe("FirebaseScryptVerifier", () => {
  it("recognizes only its own tag", () => {
    assert.isTrue(verifier.recognizes(mint(stored)));
    assert.isFalse(verifier.recognizes(mint("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")));
    assert.isFalse(verifier.recognizes(mint("$2b$10$abcdefghijklmnopqrstuv")));
    assert.isFalse(verifier.recognizes(mint("$scrypt$ln=17,r=8,p=1$c2FsdA==$deadbeef")));
  });

  it.effect("verifies the published firebase/scrypt test vector", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* verifier.verify(Redacted.make("user1password"), mint(stored)));
    }),
  );

  it.effect("a wrong password is false", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* verifier.verify(Redacted.make("user1passwore"), mint(stored)));
      assert.isFalse(yield* verifier.verify(Redacted.make(""), mint(stored)));
    }),
  );

  it.effect("out-of-envelope cost is refused without running scrypt", () =>
    Effect.gen(function* () {
      const hostile = (patch: Partial<FirebaseScryptVerifier.FirebaseHashConfig>) =>
        FirebaseScryptVerifier.encodeHash({ passwordHash, salt, config: { ...config, ...patch } });
      const started = Date.now();
      // mc=30 would need 2^30 * r * 128 bytes; r=999 likewise. Both must return at once.
      assert.isFalse(
        yield* verifier.verify(Redacted.make("user1password"), mint(hostile({ memCost: 30 }))),
      );
      assert.isFalse(
        yield* verifier.verify(Redacted.make("user1password"), mint(hostile({ rounds: 999 }))),
      );
      assert.isFalse(
        yield* verifier.verify(Redacted.make("user1password"), mint(hostile({ memCost: 0 }))),
      );
      assert.isBelow(Date.now() - started, 500);
    }),
  );

  it.effect("malformed strings are false, not defects", () =>
    Effect.gen(function* () {
      for (const bad of [
        "$firebase-scrypt$",
        "$firebase-scrypt$k=x,ss=y,r=8,mc=14$salt$hash",
        `${stored}$extra`,
        stored.replace("mc=14", "mc=abc"),
      ]) {
        assert.isFalse(yield* verifier.verify(Redacted.make("user1password"), mint(bad)), bad);
      }
    }),
  );

  it.effect(
    "wired into layerArgon2id: the legacy hash verifies, needsRehash is true, argon2id is unaffected",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isTrue(yield* hasher.verify(Redacted.make("user1password"), mint(stored)));
        assert.isFalse(yield* hasher.verify(Redacted.make("nope"), mint(stored)));
        assert.isTrue(hasher.needsRehash(mint(stored)));
        const native = yield* hasher.hash(Redacted.make("native-password"));
        assert.isTrue(yield* hasher.verify(Redacted.make("native-password"), native));
        assert.isFalse(hasher.needsRehash(native));
      }).pipe(
        Effect.provide(
          PasswordHasher.layerArgon2id.pipe(
            Layer.provideMerge(FirebaseScryptVerifier.layer),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
  );
});
