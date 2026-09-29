// @awthaq/passkey — Hmac (internal)
//
// ACS-005: thin adapters over `@awthaq/ports`' one shared `Hmac` (RFC 2104
// HMAC-SHA256, constant-time comparison) — this plugin used to carry its own
// copy of the primitive. Shared by `ChallengeStore.layerCookie` (signed
// challenges) and `Passkey.ts`'s enumeration decoys (TC-001); not part of the
// package's public surface.

import { Hmac } from "@awthaq/ports";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

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

/** A `PlatformError` from the digest is a defect here, as it always was in this plugin. */
export const hmacSha256 = (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
): Effect.Effect<Uint8Array> => Hmac.hmacSha256(crypto, key, message).pipe(Effect.orDie);

export const constantTimeEqual = Hmac.constantTimeEqualBytes;
