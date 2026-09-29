// THS-001 step 1 (BEH-EA-260): the pure RFC 4226 / RFC 6238 module, against the published vectors.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Totp from "../src/Totp.ts";

const ascii = (text: string) => new TextEncoder().encode(text);
const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>) =>
  Effect.provide(effect, NodeCrypto.layer);

// RFC 4226 Appendix D: secret "12345678901234567890", 6 digits.
const rfc4226 = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

describe("Totp.hotp (RFC 4226 Appendix D)", () => {
  it.effect("matches every published HOTP value for counters 0..9", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        for (const [counter, expected] of rfc4226.entries()) {
          assert.strictEqual(
            yield* Totp.hotp(crypto, ascii("12345678901234567890"), BigInt(counter), 6),
            expected,
          );
        }
      }),
    ),
  );
});

describe("Totp.totp (RFC 6238 Appendix B, SHA-1)", () => {
  const vectors: ReadonlyArray<readonly [number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.effect("matches every published 8-digit TOTP value", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        for (const [time, expected] of vectors) {
          assert.strictEqual(
            yield* Totp.totp(crypto, ascii("12345678901234567890"), time, {
              period: 30,
              digits: 8,
            }),
            expected,
          );
        }
      }),
    ),
  );
});

describe("Totp.verifyTotp", () => {
  const key = ascii("12345678901234567890");
  const options = { period: 30, digits: 6, window: 1, lastUsedStep: Option.none<bigint>() };

  it.effect("accepts the current step and the adjacent ones, rejects two steps away", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const now = 1_700_000_000;
        const at = (offset: number) =>
          Totp.totp(crypto, key, now + offset * 30, { period: 30, digits: 6 });
        const current = Totp.stepOf(now, 30);
        assert.deepStrictEqual(
          yield* Totp.verifyTotp(crypto, key, yield* at(0), now, options),
          Option.some(current),
        );
        assert.deepStrictEqual(
          yield* Totp.verifyTotp(crypto, key, yield* at(-1), now, options),
          Option.some(current - BigInt(1)),
        );
        assert.deepStrictEqual(
          yield* Totp.verifyTotp(crypto, key, yield* at(1), now, options),
          Option.some(current + BigInt(1)),
        );
        assert.isTrue(
          Option.isNone(yield* Totp.verifyTotp(crypto, key, yield* at(-2), now, options)),
        );
        assert.isTrue(
          Option.isNone(yield* Totp.verifyTotp(crypto, key, yield* at(2), now, options)),
        );
      }),
    ),
  );

  it.effect("THS-005: a step at or before lastUsedStep is a replay and is refused", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const now = 1_700_000_000;
        const code = yield* Totp.totp(crypto, key, now, { period: 30, digits: 6 });
        const step = Totp.stepOf(now, 30);
        // Already consumed this very step: the same code must not verify twice.
        assert.isTrue(
          Option.isNone(
            yield* Totp.verifyTotp(crypto, key, code, now, {
              ...options,
              lastUsedStep: Option.some(step),
            }),
          ),
        );
        // A later step than the last used one is still fine.
        assert.deepStrictEqual(
          yield* Totp.verifyTotp(crypto, key, code, now, {
            ...options,
            lastUsedStep: Option.some(step - BigInt(1)),
          }),
          Option.some(step),
        );
      }),
    ),
  );

  it.effect("rejects a malformed code without throwing", () =>
    withCrypto(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        for (const bad of ["", "12345", "1234567", "abcdef", "12 345"]) {
          assert.isTrue(
            Option.isNone(yield* Totp.verifyTotp(crypto, key, bad, 1_700_000_000, options)),
          );
        }
      }),
    ),
  );
});

describe("Totp base32 and otpauth URI", () => {
  it("base32 round-trips arbitrary bytes and is RFC 4648 without padding", () => {
    assert.strictEqual(Totp.base32Encode(ascii("foobar")), "MZXW6YTBOI");
    assert.strictEqual(Totp.base32Encode(ascii("f")), "MY");
    assert.deepStrictEqual(Totp.base32Decode("MZXW6YTBOI"), Option.some(ascii("foobar")));
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      assert.deepStrictEqual(Totp.base32Decode(Totp.base32Encode(bytes)), Option.some(bytes));
    }
  });

  it("base32Decode tolerates case, spaces, hyphens and padding, and rejects other characters", () => {
    assert.deepStrictEqual(Totp.base32Decode("mzxw 6ytb-oi======"), Option.some(ascii("foobar")));
    assert.isTrue(Option.isNone(Totp.base32Decode("MZXW1YTBOI")));
  });

  it("otpauthUri follows the Key Uri Format", () => {
    const uri = Totp.otpauthUri({
      issuer: "Acme Co",
      accountName: "ada@example.com",
      secret: "JBSWY3DPEHPK3PXP",
      period: 30,
      digits: 6,
    });
    assert.strictEqual(
      uri,
      "otpauth://totp/Acme%20Co:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Co&algorithm=SHA1&digits=6&period=30",
    );
  });
});
