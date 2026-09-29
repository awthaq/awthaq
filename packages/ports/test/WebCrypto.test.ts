// ERAS-002: the edge-safe `Crypto` provider. Parity is checked against Node's
// own layer, the reference every other suite in the repository runs on.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hmac from "../src/Hmac.ts";
import * as WebCrypto from "../src/WebCrypto.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("WebCrypto.layer (ERAS-002)", () => {
  it.effect("randomBytes returns the requested length, and two draws differ", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const a = yield* crypto.randomBytes(32);
      const b = yield* crypto.randomBytes(32);
      assert.strictEqual(a.length, 32);
      assert.notStrictEqual(Hmac.toHex(a), Hmac.toHex(b));
      // Larger than getRandomValues' 64 KiB per-call ceiling: filled in chunks.
      assert.strictEqual((yield* crypto.randomBytes(200_000)).length, 200_000);
    }).pipe(Effect.provide(WebCrypto.layer)),
  );

  it.effect("SHA-256 and HMAC-SHA256 agree with NodeCrypto for the same input", () =>
    Effect.gen(function* () {
      const inputs = [utf8(""), utf8("abc"), utf8("the quick brown fox"), new Uint8Array(1000).fill(7)];
      const web = yield* Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return {
          digests: yield* Effect.forEach(inputs, (data) => crypto.digest("SHA-256", data)),
          mac: yield* Hmac.hmacSha256(crypto, utf8("key"), utf8("message")),
        };
      }).pipe(Effect.provide(WebCrypto.layer));
      const node = yield* Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return {
          digests: yield* Effect.forEach(inputs, (data) => crypto.digest("SHA-256", data)),
          mac: yield* Hmac.hmacSha256(crypto, utf8("key"), utf8("message")),
        };
      }).pipe(Effect.provide(NodeCrypto.layer));
      assert.deepStrictEqual(web.digests.map(Hmac.toHex), node.digests.map(Hmac.toHex));
      assert.strictEqual(Hmac.toHex(web.mac), Hmac.toHex(node.mac));
    }),
  );

  it.effect("mints uuidv7 ids", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      assert.match(
        yield* crypto.randomUUIDv7,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }).pipe(Effect.provide(WebCrypto.layer)),
  );

  it("dies at build when the runtime has no Web Crypto object", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Crypto.Crypto;
      }).pipe(
        Effect.provide(WebCrypto.layer),
        Effect.provideService(WebCrypto.WebCryptoApi, undefined),
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
  });
});
