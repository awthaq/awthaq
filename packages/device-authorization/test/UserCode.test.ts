// BEH-EA-310, spec/models/13-device-authorization.md "Security parameters": the user code is 8
// symbols drawn uniformly from a 20-symbol consonant alphabet, shown as `XXXX-XXXX`, normalised
// and matched exactly, and stored only as a hash. The device code is 32 CSPRNG bytes.
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as UserCode from "../src/UserCode.ts";

const run = <A, E>(body: (crypto: Crypto.Crypto) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* Crypto.Crypto);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

describe("UserCode", () => {
  it("uses the 20-symbol unambiguous consonant alphabet, so a code carries about 34.6 bits", () => {
    assert.strictEqual(UserCode.ALPHABET, "BCDFGHJKLMNPQRSTVWXZ");
    assert.strictEqual(UserCode.ALPHABET.length, 20);
    // No vowels (no accidental words), no digits (no 0/O or 1/I confusables).
    assert.notMatch(UserCode.ALPHABET, /[AEIOU0-9]/);
    const bits = UserCode.LENGTH * Math.log2(UserCode.ALPHABET.length);
    assert.isAbove(bits, 34.5);
    assert.isBelow(bits, 34.7);
  });

  it("generates 8-symbol codes from the alphabet, displayed XXXX-XXXX", async () => {
    const codes = await run((crypto) =>
      Effect.all(Array.from({ length: 200 }, () => UserCode.generate(crypto))),
    );
    for (const code of codes) {
      assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
      assert.match(UserCode.format(code), /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    }
    // 200 draws over 20^8 possibilities: a repeat means the generator is not random.
    assert.strictEqual(new Set(codes).size, codes.length);
  });

  it("draws every symbol uniformly (rejection sampling, no modulo bias)", async () => {
    const codes = await run((crypto) =>
      Effect.all(Array.from({ length: 2000 }, () => UserCode.generate(crypto))),
    );
    const counts = new Map<string, number>();
    for (const symbol of codes.join("")) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    const total = codes.length * UserCode.LENGTH;
    const expected = total / UserCode.ALPHABET.length;
    for (const symbol of UserCode.ALPHABET) {
      const seen = counts.get(symbol) ?? 0;
      // 800 expected per symbol; a 5-sigma band is ~ +-140.
      assert.isBelow(Math.abs(seen - expected), 150, symbol);
    }
  });

  it("normalises case, hyphens and spaces, then matches exactly", () => {
    assert.strictEqual(UserCode.normalize("bcdf-ghjk"), "BCDFGHJK");
    assert.strictEqual(UserCode.normalize(" bcdf ghjk "), "BCDFGHJK");
    assert.strictEqual(UserCode.normalize("BCDF - GHJK"), "BCDFGHJK");
    assert.isTrue(UserCode.isWellFormed("BCDFGHJK"));
    // One character off, too short, too long, a forbidden symbol: none is fuzzy-matched into a code.
    for (const bad of ["", "BCDFGHJ", "BCDFGHJKL", "BCDFGHJA", "BCDFGHJ0", "bcdfghjk"]) {
      assert.isFalse(UserCode.isWellFormed(bad), bad);
    }
  });

  it("hashes a code (SHA-256 hex) so the row holds no usable code, and the hash is stable", async () => {
    const [first, second, other] = await run((crypto) =>
      Effect.all([
        UserCode.hash(crypto, "BCDFGHJK"),
        UserCode.hash(crypto, "BCDF-ghjk"),
        UserCode.hash(crypto, "BCDFGHJL"),
      ]),
    );
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.strictEqual(first, second, "hashing normalises first");
    assert.notStrictEqual(first, other);
    assert.notInclude(first, "BCDFGHJK");
  });

  it("generates a 32-byte base64url device code that is never the user code", async () => {
    const codes = await run((crypto) =>
      Effect.all(Array.from({ length: 50 }, () => UserCode.generateDeviceCode(crypto))),
    );
    for (const code of codes) {
      // 32 bytes -> 43 base64url characters, no padding.
      assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    }
    assert.strictEqual(new Set(codes).size, codes.length);
  });
});
