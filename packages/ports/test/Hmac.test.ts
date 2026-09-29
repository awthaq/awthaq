// ACS-005/ACS-007: see src/Hmac.ts's own header comment.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Hmac from "../src/Hmac.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const fill = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);

const compute = (key: Uint8Array, message: Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return Hmac.toHex(yield* Hmac.hmacSha256(crypto, key, message));
  }).pipe(Effect.provide(NodeCrypto.layer));

const oracle = (key: Uint8Array, message: Uint8Array): string =>
  createHmac("sha256", key).update(message).digest("hex");

// RFC 4231 section 4 test cases (case 5, a truncation test, does not apply).
const rfc4231: ReadonlyArray<{
  readonly name: string;
  readonly key: Uint8Array;
  readonly data: Uint8Array;
  /** Cases 1 and 2 are pinned to the RFC's published output; the rest use the oracle. */
  readonly expected?: string;
}> = [
  {
    name: "case 1",
    key: fill(0x0b, 20),
    data: utf8("Hi There"),
    expected: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  },
  {
    name: "case 2",
    key: utf8("Jefe"),
    data: utf8("what do ya want for nothing?"),
    expected: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  },
  { name: "case 3", key: fill(0xaa, 20), data: fill(0xdd, 50) },
  {
    name: "case 4",
    key: Uint8Array.from({ length: 25 }, (_, i) => i + 1),
    data: fill(0xcd, 50),
  },
  {
    name: "case 6 (key longer than the block size)",
    key: fill(0xaa, 131),
    data: utf8("Test Using Larger Than Block-Size Key - Hash Key First"),
  },
  {
    name: "case 7 (key and data longer than the block size)",
    key: fill(0xaa, 131),
    data: utf8(
      "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
    ),
  },
];

describe("Hmac.hmacSha256", () => {
  for (const vector of rfc4231) {
    it.effect(`RFC 4231 ${vector.name}`, () =>
      Effect.gen(function* () {
        const actual = yield* compute(vector.key, vector.data);
        assert.strictEqual(actual, oracle(vector.key, vector.data));
        if (vector.expected !== undefined) assert.strictEqual(actual, vector.expected);
      }),
    );
  }

  it.effect("agrees with node:crypto on random keys and messages of every size class", () =>
    Effect.gen(function* () {
      for (const keyLength of [0, 1, 31, 32, 63, 64, 65, 200]) {
        for (const messageLength of [0, 1, 55, 64, 500]) {
          const key = randomBytes(keyLength);
          const message = randomBytes(messageLength);
          assert.strictEqual(yield* compute(key, message), oracle(key, message));
        }
      }
    }),
  );
});

describe("Hmac.constantTimeEqual*", () => {
  it("agrees with timingSafeEqual on equal-length inputs and rejects a length mismatch", () => {
    for (let i = 0; i < 50; i++) {
      const a = randomBytes(32);
      const b = i % 2 === 0 ? Uint8Array.from(a) : randomBytes(32);
      assert.strictEqual(Hmac.constantTimeEqualBytes(a, b), timingSafeEqual(a, b));
    }
    assert.isFalse(Hmac.constantTimeEqualBytes(randomBytes(32), randomBytes(31)));
  });

  it("compares strings as UTF-8 bytes", () => {
    assert.isTrue(Hmac.constantTimeEqualString("abc", "abc"));
    assert.isFalse(Hmac.constantTimeEqualString("abc", "abd"));
    assert.isFalse(Hmac.constantTimeEqualString("abc", "abcd"));
    assert.isTrue(Hmac.constantTimeEqualString("é", "é"));
  });
});

describe("Hmac.requireMinSecretBytes", () => {
  it.effect("dies with WeakSigningSecret below 32 bytes", () =>
    Effect.gen(function* () {
      const exit = yield* Hmac.requireMinSecretBytes(Redacted.make("a".repeat(16))).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      if (!Exit.isFailure(exit)) return;
      const defect = Cause.squash(exit.cause);
      assert.instanceOf(defect, Hmac.WeakSigningSecret);
      if (defect instanceof Hmac.WeakSigningSecret) {
        assert.strictEqual(defect.bytes, 16);
        assert.strictEqual(defect.minimum, 32);
      }
    }),
  );

  it.effect("accepts a 32-byte secret and counts UTF-8 bytes, not characters", () =>
    Effect.gen(function* () {
      yield* Hmac.requireMinSecretBytes(Redacted.make("a".repeat(32)));
      // 16 two-byte characters are 32 bytes.
      yield* Hmac.requireMinSecretBytes(Redacted.make("é".repeat(16)));
    }),
  );
});
