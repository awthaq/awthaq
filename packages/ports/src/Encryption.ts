// @awthaq/ports — Encryption
//
// Shipping-gap map (.scratch/shipping-gaps), ticket 18 — the AES-256-GCM
// envelope spec.md's workstream 4 calls for: "Encrypt/decrypt live behind
// a single dedicated service — not a bare model-field transform — because
// PKCE verifier/nonce state is in scope for the same treatment [ticket
// 19], and PKCE state doesn't live in the SQL persistence layer at all;
// it's carried in a signed cookie and in the existing verification-flow
// payload mechanism. The encryption service is therefore callable from
// both the SQL persistence path and the cookie/flow-payload path, not
// just one." — hence this lives here, in `@awthaq/ports`, alongside
// `KeyProvider`: `@awthaq/sql` (ticket 18's own consumer) and
// `@awthaq/oauth` (ticket 19's) both already depend on this package;
// neither depends on `@awthaq/core`.
//
// Fixed AES-256-GCM logic wrapping the swappable `KeyProvider` port — the
// same "fixed algorithm over a swappable store" shape `RateLimiter.layer`
// already has over `RateLimiterStore` in this same package.
//
// Uses the platform WebCrypto (`globalThis.crypto.subtle`), not Node's
// `node:crypto` module — the same "zero platform-specific dependency, runs
// anywhere WebCrypto exists (Node/Deno/Bun/browsers)" choice
// `@awthaq/jwt`'s `KeyRing.ts`/`JwtCodec.ts` and `@awthaq/oauth`'s
// `Jwt.ts` already make for their own signing/verification. WebCrypto's
// own `AES-GCM` `encrypt` result already has the authentication tag
// appended to the ciphertext (unlike Node's `crypto` module, which
// separates them via `getAuthTag()`), so the envelope only needs to carry
// `iv` and `ciphertext`.
//
// The IV itself comes from the ambient `effect/Crypto` service (the same
// `Crypto.Crypto.randomBytes` every other random-material generator in
// this codebase already uses — `Sessions.ts`, `Verification.ts`,
// `Accounts.ts`), not `globalThis.crypto.getRandomValues` directly, so a
// test can substitute a deterministic `Crypto` layer the same way it
// already can for every other capability this codebase generates
// randomly.

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { KeyProvider, UnknownKeyId } from "./KeyProvider.ts";

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;

interface Envelope {
  readonly v: 1;
  readonly kid: string;
  readonly iv: string;
  readonly ciphertext: string;
}

const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === "object" &&
  value !== null &&
  "v" in value &&
  value.v === 1 &&
  "kid" in value &&
  typeof value.kid === "string" &&
  "iv" in value &&
  typeof value.iv === "string" &&
  "ciphertext" in value &&
  typeof value.ciphertext === "string";

const encodeEnvelope = (envelope: Envelope): string =>
  Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");

const decodeEnvelope = (encoded: string): Envelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return isEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A malformed envelope (not this module's own JSON shape) or a failed
 * AES-GCM authentication check (tampered ciphertext, wrong AAD, or wrong
 * key) — WebCrypto's own `decrypt` reports both as the same opaque
 * rejection, so this module cannot (and, for a security boundary, should
 * not) distinguish "corrupt" from "tampered" any further than that.
 */
export class DecryptionFailed extends Data.TaggedError("DecryptionFailed")<{
  readonly reason: string;
}> {}

export interface EncryptionShape {
  /**
   * `aad` (additional authenticated data) is bound into the resulting
   * envelope without being encrypted itself — decrypting with a
   * *different* `aad` than was used to encrypt fails authentication
   * (`DecryptionFailed`), even with the right key. Ticket 18: the caller
   * passes an id that ties a ciphertext to the specific row it belongs to
   * (e.g. `providerId:userId:accessToken`), so a ciphertext copied into a
   * different row's column no longer decrypts.
   */
  readonly encrypt: (plaintext: Redacted.Redacted<string>, aad: string) => Effect.Effect<string>;
  readonly decrypt: (
    envelope: string,
    aad: string,
  ) => Effect.Effect<Redacted.Redacted<string>, DecryptionFailed | UnknownKeyId>;
}

export class Encryption extends Context.Service<Encryption, EncryptionShape>()(
  "awthaq/ports/Encryption",
) {}

const toArrayBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

const importAesKey = (bytes: Uint8Array, usage: "encrypt" | "decrypt") =>
  Effect.promise(() =>
    globalThis.crypto.subtle.importKey("raw", toArrayBuffer(bytes), ALGORITHM, false, [usage]),
  );

export const layer: Layer.Layer<Encryption, never, KeyProvider | Crypto.Crypto> = Layer.effect(
  Encryption,
  Effect.gen(function* () {
    const keyProvider = yield* KeyProvider;
    const crypto = yield* Crypto.Crypto;

    const encrypt: EncryptionShape["encrypt"] = (plaintext, aad) =>
      Effect.gen(function* () {
        const material = yield* keyProvider.currentKey;
        const iv = yield* crypto.randomBytes(IV_LENGTH).pipe(Effect.orDie);
        const key = yield* importAesKey(Redacted.value(material.key), "encrypt");
        const ciphertext = yield* Effect.promise(() =>
          globalThis.crypto.subtle.encrypt(
            {
              name: ALGORITHM,
              iv: toArrayBuffer(iv),
              additionalData: new TextEncoder().encode(aad),
            },
            key,
            new TextEncoder().encode(Redacted.value(plaintext)),
          ),
        );
        return encodeEnvelope({
          v: 1,
          kid: material.kid,
          iv: Buffer.from(iv).toString("base64"),
          ciphertext: Buffer.from(ciphertext).toString("base64"),
        });
      });

    const decrypt: EncryptionShape["decrypt"] = (encoded, aad) =>
      Effect.gen(function* () {
        const envelope = decodeEnvelope(encoded);
        if (envelope === undefined) {
          return yield* Effect.fail(
            new DecryptionFailed({ reason: "malformed ciphertext envelope" }),
          );
        }
        const material = yield* keyProvider.getKey(envelope.kid);
        const key = yield* importAesKey(Redacted.value(material.key), "decrypt");
        const plaintext = yield* Effect.tryPromise({
          try: () =>
            globalThis.crypto.subtle.decrypt(
              {
                name: ALGORITHM,
                iv: toArrayBuffer(Buffer.from(envelope.iv, "base64")),
                additionalData: new TextEncoder().encode(aad),
              },
              key,
              toArrayBuffer(Buffer.from(envelope.ciphertext, "base64")),
            ),
          catch: () =>
            new DecryptionFailed({
              reason: "authentication failed (tampered ciphertext, wrong AAD, or wrong key)",
            }),
        });
        return Redacted.make(new TextDecoder().decode(plaintext));
      });

    return Encryption.of({ encrypt, decrypt });
  }),
);
