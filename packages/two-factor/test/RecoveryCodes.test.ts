// THS-001 step 8, BCR-001 (BEH-EA-264): minting, displaying and normalising recovery codes.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as RecoveryCodes from "../src/RecoveryCodes.ts";

const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.provide(effect, NodeCrypto.layer);

describe("RecoveryCodes", () => {
  it.effect("mints `count` codes of `length` characters from the unambiguous alphabet", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const codes = yield* RecoveryCodes.generate(crypto, 10, 10);
        assert.strictEqual(codes.length, 10);
        for (const code of codes) {
          assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
          assert.isTrue(RecoveryCodes.isWellFormed(code, 10));
        }
        // Independent draws: no two of ten 50-bit codes collide in practice.
        assert.strictEqual(new Set(codes).size, 10);
      }),
    ),
  );

  it.effect("draws every symbol uniformly (32 divides 256, so no modulo bias)", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const codes = yield* RecoveryCodes.generate(crypto, 3000, 10);
        const counts = new Map<string, number>();
        for (const char of codes.join("")) counts.set(char, (counts.get(char) ?? 0) + 1);
        assert.strictEqual(counts.size, 32);
        // 30000 draws, 937.5 expected per symbol: chi-square with 31 df stays far below 61.1 (p = 0.001).
        const expected = 30_000 / 32;
        const chi = [...counts.values()].reduce(
          (sum, seen) => sum + (seen - expected) ** 2 / expected,
          0,
        );
        assert.isBelow(chi, 61.1);
      }),
    ),
  );

  it("displays in groups of five and normalises what a person typed", () => {
    assert.strictEqual(RecoveryCodes.display("ABCDEFGHJK"), "ABCDE-FGHJK");
    assert.strictEqual(RecoveryCodes.normalize(" abcde-fghjk "), "ABCDEFGHJK");
    assert.strictEqual(RecoveryCodes.normalize("ABCDE FGHJK"), "ABCDEFGHJK");
    assert.strictEqual(RecoveryCodes.normalize(RecoveryCodes.display("ABCDEFGHJK")), "ABCDEFGHJK");
  });

  it("rejects a string that cannot be a code without a hash being computed", () => {
    assert.isFalse(RecoveryCodes.isWellFormed("ABCDE", 10));
    assert.isFalse(RecoveryCodes.isWellFormed("ABCDEFGHJ0", 10)); // 0 is not in the alphabet
    assert.isFalse(RecoveryCodes.isWellFormed("ABCDEFGHIK", 10)); // nor is I
    assert.isTrue(RecoveryCodes.isWellFormed("ABCDEFGHJK", 10));
  });
});
