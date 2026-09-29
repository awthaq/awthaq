// ERAS-002: an edge-runtime `Crypto` provider over `globalThis.crypto`, no Node built-ins.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WebCrypto from "../src/WebCrypto.ts";

const digestWith = (layer: Layer.Layer<Crypto.Crypto>, algorithm: Crypto.DigestAlgorithm) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* crypto.digest(algorithm, new TextEncoder().encode("awthaq"));
  }).pipe(Effect.provide(layer));

describe("WebCrypto.layer", () => {
  it.effect("randomBytes returns the requested length and differs between calls", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const a = yield* crypto.randomBytes(32);
      const b = yield* crypto.randomBytes(32);
      assert.strictEqual(a.length, 32);
      assert.notDeepEqual(a, b);
      // Web Crypto caps one `getRandomValues` call at 65536 bytes; larger requests are chunked.
      assert.strictEqual((yield* crypto.randomBytes(100_000)).length, 100_000);
    }).pipe(Effect.provide(WebCrypto.layer)),
  );

  it.effect("digest matches NodeCrypto's for every supported algorithm", () =>
    Effect.gen(function* () {
      const algorithms: ReadonlyArray<Crypto.DigestAlgorithm> = [
        "SHA-1",
        "SHA-256",
        "SHA-384",
        "SHA-512",
      ];
      for (const algorithm of algorithms) {
        assert.deepStrictEqual(
          yield* digestWith(WebCrypto.layer, algorithm),
          yield* digestWith(NodeCrypto.layer, algorithm),
        );
      }
    }),
  );
});
