// AOMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21).
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import bcrypt from "bcryptjs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as BcryptVerifier from "../src/BcryptVerifier.ts";

// TTE-005: a bare string is not a stored hash; these tests mint the ones they hand the hasher.
const mint = PasswordHasher.PhcHash;

describe("BcryptVerifier", () => {
  it("recognizes $2a$/$2b$/$2y$ bcrypt tags but not argon2id/scrypt", () => {
    assert.isTrue(BcryptVerifier.bcryptVerifier.recognizes(mint(bcrypt.hashSync("plain", 4))));
    assert.isTrue(BcryptVerifier.bcryptVerifier.recognizes(mint("$2a$10$abcdefghijklmnopqrstuv")));
    assert.isTrue(BcryptVerifier.bcryptVerifier.recognizes(mint("$2y$10$abcdefghijklmnopqrstuv")));
    assert.isFalse(
      BcryptVerifier.bcryptVerifier.recognizes(
        mint("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"),
      ),
    );
    assert.isFalse(
      BcryptVerifier.bcryptVerifier.recognizes(mint("$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA")),
    );
  });

  it.effect("verify: true for the correct password, false for the wrong one", () =>
    Effect.gen(function* () {
      const hash = bcrypt.hashSync("correct horse battery staple", 4);
      const correct = yield* BcryptVerifier.bcryptVerifier.verify(
        Redacted.make("correct horse battery staple"),
        mint(hash),
      );
      const wrong = yield* BcryptVerifier.bcryptVerifier.verify(
        Redacted.make("wrong password"),
        mint(hash),
      );
      assert.isTrue(correct);
      assert.isFalse(wrong);
    }),
  );

  // SAM-001: Supabase GoTrue stores `auth.users.encrypted_password` as `$2a$10$...`
  // bcrypt. `$2a$` and `$2b$` are algorithm-identical, so rewriting bcryptjs's `$2b$`
  // prefix produces a hash byte-shaped exactly like a GoTrue export.
  it.effect(
    "a GoTrue-style $2a$10$ hash verifies through layerArgon2id + BcryptVerifier.layer and needsRehash is true",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const gotrueHash = bcrypt.hashSync("imported-from-supabase", 10).replace(/^\$2b\$/, "$2a$");
        assert.match(gotrueHash, /^\$2a\$10\$/);

        assert.isTrue(
          yield* hasher.verify(Redacted.make("imported-from-supabase"), mint(gotrueHash)),
        );
        assert.isFalse(yield* hasher.verify(Redacted.make("wrong-guess"), mint(gotrueHash)));
        assert.isTrue(hasher.needsRehash(mint(gotrueHash)));
      }).pipe(
        Effect.provide(
          PasswordHasher.layerArgon2id.pipe(
            Layer.provideMerge(BcryptVerifier.layer),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect("verify: false (not a defect) for a malformed hash", () =>
    Effect.gen(function* () {
      const result = yield* BcryptVerifier.bcryptVerifier.verify(
        Redacted.make("anything"),
        mint("not-a-bcrypt-hash"),
      );
      assert.isFalse(result);
    }),
  );

  it.effect(
    "wired into PasswordHasher.layerArgon2id: verifies a legacy bcrypt hash, and needsRehash flags it for upgrade",
    () =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const legacyHash = bcrypt.hashSync("imported-from-auth0", 4);

        const verified = yield* hasher.verify(
          Redacted.make("imported-from-auth0"),
          mint(legacyHash),
        );
        const rejected = yield* hasher.verify(Redacted.make("wrong-guess"), mint(legacyHash));

        assert.isTrue(verified);
        assert.isFalse(rejected);
        assert.isTrue(hasher.needsRehash(mint(legacyHash)));

        // The primary algorithm's own format is completely unaffected by
        // the legacy verifier being installed alongside it.
        const nativeHash = yield* hasher.hash(Redacted.make("native-password"));
        const nativeVerified = yield* hasher.verify(Redacted.make("native-password"), nativeHash);
        assert.isTrue(nativeVerified);
        assert.isFalse(hasher.needsRehash(nativeHash));
      }).pipe(
        Effect.provide(
          PasswordHasher.layerArgon2id.pipe(
            Layer.provideMerge(BcryptVerifier.layer),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      ),
  );
});
