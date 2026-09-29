// @awthaq/passkey — Hmac (internal)
//
// BEH-EA-075's own `Csrf.ts` HMAC — copied rather than imported: this plugin
// does not depend on `@awthaq/server`, and the primitive is small enough that
// duplicating it costs less than the cross-stratum dependency would. Shared
// by `ChallengeStore.layerCookie` (signed challenges) and `Passkey.ts`'s
// enumeration decoys (TC-001); not part of the package's public surface.

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

const SHA256_BLOCK_SIZE = 64;

export const concatBytes = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const hmacSha256 = (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
): Effect.Effect<Uint8Array> =>
  Effect.gen(function* () {
    let blockKey = key.length > SHA256_BLOCK_SIZE ? yield* crypto.digest("SHA-256", key) : key;
    if (blockKey.length < SHA256_BLOCK_SIZE) {
      const padded = new Uint8Array(SHA256_BLOCK_SIZE);
      padded.set(blockKey);
      blockKey = padded;
    }
    const ipad = new Uint8Array(SHA256_BLOCK_SIZE);
    const opad = new Uint8Array(SHA256_BLOCK_SIZE);
    for (let i = 0; i < SHA256_BLOCK_SIZE; i++) {
      const keyByte = blockKey[i] ?? 0;
      ipad[i] = keyByte ^ 0x36;
      opad[i] = keyByte ^ 0x5c;
    }
    const inner = yield* crypto.digest("SHA-256", concatBytes(ipad, message));
    return yield* crypto.digest("SHA-256", concatBytes(opad, inner));
  }).pipe(Effect.orDie);

export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
