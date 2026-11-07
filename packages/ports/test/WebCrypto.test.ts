// ERAS-002: an edge-runtime crypto provider over `globalThis.crypto`, no Node built-ins.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Hmac from "../src/Hmac.ts";
import * as WebCrypto from "../src/WebCrypto.ts";

const input = new TextEncoder().encode("awthaq");

const digestWith = (layer: Layer.Layer<Digest.Digest>, algorithm: Digest.Algorithm) =>
  Effect.gen(function* () {
    const hasher = yield* Digest.Digest;
    return yield* hasher.digest(algorithm, input);
  }).pipe(Effect.provide(layer));

const hmacWith = (layer: Layer.Layer<Mac.Mac>) =>
  Effect.gen(function* () {
    const mac = yield* Mac.Mac;
    return yield* Hmac.hmacSha256(mac, new TextEncoder().encode("k".repeat(32)), input);
  }).pipe(Effect.provide(layer));

describe("WebCrypto.layer", () => {
  it.effect("randomBytes returns the requested length and differs between calls", () =>
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const a = yield* random.randomBytes(32);
      const b = yield* random.randomBytes(32);
      assert.strictEqual(a.length, 32);
      assert.notDeepEqual(a, b);
      // Web Crypto caps one `getRandomValues` call at 65536 bytes; larger requests are chunked.
      assert.strictEqual((yield* random.randomBytes(100_000)).length, 100_000);
    }).pipe(Effect.provide(WebCrypto.layer)),
  );

  it.effect("digest matches NodeCrypto's for every supported algorithm", () =>
    Effect.gen(function* () {
      for (const algorithm of [Digest.sha1, Digest.sha256, Digest.sha384, Digest.sha512]) {
        assert.deepStrictEqual(
          yield* digestWith(WebCrypto.layer, algorithm),
          yield* digestWith(NodeCrypto.layer, algorithm),
        );
      }
    }),
  );

  it.effect("HMAC-SHA256 matches NodeCrypto's", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* hmacWith(WebCrypto.layer), yield* hmacWith(NodeCrypto.layer));
    }),
  );
});
