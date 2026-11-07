// @awthaq/ports — WebCrypto
//
// ERAS-002. Every composition in this repository can provide the effect crypto services
// (`SecureRandom`, `Digest`, `Mac`) through `@effect/platform-node`'s `NodeCrypto.layer`, which an
// edge runtime (Cloudflare Workers, Vercel Edge, Deno Deploy) does not have. This layer provides
// the same three services over `globalThis.crypto`, present in every runtime with the Web Crypto
// API and in Node >= 20, using effect's own `layerWebCrypto` implementations (which chunk
// `getRandomValues` past its 65536-byte cap). Provide it where you would provide
// `NodeCrypto.layer`:
//
//   const AppLayer = MyLayer.pipe(Layer.provide(WebCrypto.layer));
//
// The layer dies at build time when no Web Crypto object exists, which is better than a later,
// per-call failure in a security primitive.

import * as Defects from "./Defects.ts";
import * as Digest from "effect/crypto/Digest";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The crypto services awthaq's layers draw on; `NodeCrypto.layer` and {@link layer} both provide them. */
export type Services = SecureRandom.SecureRandom | Digest.Digest | Mac.Mac;

const available = Layer.effectDiscard(
  globalThis.crypto === undefined
    ? Defects.invalidConfiguration(
        "Crypto",
        "awthaq: the Web Crypto API (globalThis.crypto) is not available",
      )
    : Effect.void,
);

export const layer: Layer.Layer<Services> = Layer.mergeAll(
  SecureRandom.layerWebCrypto,
  Digest.layerWebCrypto,
  Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
).pipe(Layer.provideMerge(available));
