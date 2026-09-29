// @awthaq/ports — WebCrypto
//
// ERAS-002 (.issues/medium): the one `Crypto.Crypto` provider in the repository
// used to be Node's (`@effect/platform-node`'s `NodeCrypto`), which pulls
// `node:crypto` into every edge bundle. This is the edge-safe alternative: a
// `Crypto` layer backed by `globalThis.crypto` (Web Crypto — present in Node
// >= 20, browsers, Cloudflare Workers, Deno, Bun, Vercel Edge), with no
// dependency beyond `effect`. It mirrors `@effect/platform-browser`'s
// `BrowserCrypto` (random bytes from `getRandomValues`, digests from
// `crypto.subtle.digest`) without adding a browser-platform package to the
// server packages — the same no-new-dependency posture as the rest of the
// edge tier (`@awthaq/next/edge`).
//
// Use it where `node:crypto` is unavailable: `Layer.provide(WebCrypto.layer)`
// wherever `NodeCrypto.layer` would go. On Node, `NodeCrypto.layer` remains fine.
// Everything the library needs from `Crypto` — randomness, uuidv7 ids, SHA-256
// digests (and HMAC-SHA256, built from them in `Hmac.ts`) — is covered; what is
// *not* edge-friendly is password hashing (argon2id/scrypt in WASM burns CPU
// budgets), which belongs on the origin (see `PasswordHasher.ts`, ERAS-004).

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

/** The Web Crypto object the layer reads; defaults to `globalThis.crypto`, overridable for tests and embedded runtimes. */
export const WebCryptoApi = Context.Reference<typeof globalThis.crypto | undefined>(
  "awthaq/ports/WebCrypto/WebCryptoApi",
  { defaultValue: () => globalThis.crypto },
);

const RANDOM_CHUNK = 65_536; // `getRandomValues` refuses more than 64 KiB per call

/**
 * A `Crypto.Crypto` over Web Crypto. Dies at build if no Web Crypto object exists;
 * `digest` fails with a `PlatformError` when `crypto.subtle.digest` is missing or the
 * runtime rejects the request.
 */
export const layer: Layer.Layer<Crypto.Crypto> = Layer.effect(
  Crypto.Crypto,
  Effect.gen(function* () {
    const webCrypto = yield* WebCryptoApi;
    if (webCrypto === undefined) {
      return yield* Effect.die(new Error("awthaq: the Web Crypto API is not available in this runtime"));
    }
    const randomBytes = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < bytes.length; offset += RANDOM_CHUNK) {
        webCrypto.getRandomValues(bytes.subarray(offset, offset + RANDOM_CHUNK));
      }
      return bytes;
    };
    const digest: Crypto.Crypto["digest"] = (algorithm, data) => {
      if (typeof webCrypto.subtle?.digest !== "function") {
        return Effect.fail(
          PlatformError.systemError({
            module: "Crypto",
            method: "digest",
            _tag: "Unknown",
            description: "crypto.subtle.digest is not available",
          }),
        );
      }
      return Effect.map(
        Effect.tryPromise({
          try: () => webCrypto.subtle.digest(algorithm, new Uint8Array(data)),
          catch: (cause) =>
            PlatformError.systemError({
              module: "Crypto",
              method: "digest",
              _tag: "Unknown",
              description: "Could not compute digest",
              cause,
            }),
        }),
        (buffer) => new Uint8Array(buffer),
      );
    };
    return Crypto.make({ randomBytes, digest });
  }),
);
