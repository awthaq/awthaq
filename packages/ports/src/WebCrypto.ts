// @awthaq/ports — WebCrypto
//
// ERAS-002. Every composition in this repository provided `Crypto.Crypto` through
// `@effect/platform-node`'s `NodeCrypto`, which an edge runtime (Cloudflare Workers,
// Vercel Edge, Deno Deploy) does not have. This is the same service over
// `globalThis.crypto` — present in every runtime with the Web Crypto API and in Node >= 20 —
// mirroring `@effect/platform-browser`'s `BrowserCrypto` without adding a browser-platform
// dependency to the server packages (the same no-new-dependency posture as the rest of this
// stratum). Provide it where you would provide `NodeCrypto.layer`:
//
//   const AppLayer = MyLayer.pipe(Layer.provide(WebCrypto.layer));
//
// Everything the library needs from `Crypto` — randomness, uuidv7 ids, SHA-256 digests (and
// HMAC-SHA256, built from them in `Hmac.ts`) — is covered; what is *not* edge-friendly is
// password hashing (argon2id/scrypt in WASM burns CPU budgets), which belongs on the origin.
//
// The layer dies at build time when no Web Crypto object exists (better than a later,
// per-call failure in a security primitive); a digest failure is a `PlatformError`.

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Defects from "./Defects.ts";

/** The Web Crypto object the layer reads; defaults to `globalThis.crypto`, overridable for tests and embedded runtimes. */
export const WebCryptoApi = Context.Reference<typeof globalThis.crypto | undefined>(
  "awthaq/ports/WebCrypto/WebCryptoApi",
  { defaultValue: () => globalThis.crypto },
);

/** `crypto.getRandomValues` refuses more than 65536 bytes per call. */
const MAX_RANDOM_CHUNK = 65_536;

const digestFailure = (description: string, cause?: unknown) =>
  PlatformError.systemError({
    module: "Crypto",
    method: "digest",
    _tag: "Unknown",
    description,
    ...(cause === undefined ? {} : { cause }),
  });

export const layer = Layer.effect(
  Crypto.Crypto,
  Effect.gen(function* () {
    const webCrypto = yield* WebCryptoApi;
    if (webCrypto === undefined) {
      return yield* Defects.invalidConfiguration("Crypto", "awthaq: the Web Crypto API (globalThis.crypto) is not available");
    }

    const randomBytes = (size: number) => {
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += MAX_RANDOM_CHUNK) {
        webCrypto.getRandomValues(bytes.subarray(offset, offset + MAX_RANDOM_CHUNK));
      }
      return bytes;
    };

    const digest: Crypto.Crypto["digest"] = (algorithm, data) =>
      typeof webCrypto.subtle?.digest === "function"
        ? Effect.tryPromise({
            try: () => webCrypto.subtle.digest(algorithm, new Uint8Array(data)),
            catch: (cause) => digestFailure("Could not compute digest", cause),
          }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
        : Effect.fail(digestFailure("crypto.subtle.digest is not available"));

    return Crypto.make({ randomBytes, digest });
  }),
);
