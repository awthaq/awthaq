// @awthaq/ports — Hmac
//
// ACS-005/ACS-007: the one HMAC-SHA256 (RFC 2104), constant-time comparison
// and hex encoding this repository uses. The platform-neutral `Crypto`
// service exposes only plain digests, not a keyed MAC, so the primitive is
// built once here — previously copied into `@awthaq/server`'s `Csrf.ts` and
// `@awthaq/passkey`'s `ChallengeStore.ts`, with the comparison and hex helpers
// duplicated again in core — and tested against RFC 4231 vectors and Node's
// own `createHmac` as an oracle (`test/Hmac.test.ts`).

import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";

const SHA256_BLOCK_SIZE = 64;

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * BEH-EA-056: compares byte-for-byte without short-circuiting on the first
 * mismatch. A length mismatch returns early: every caller compares
 * fixed-length outputs of one digest/MAC (or lengths already public), so the
 * length itself is not a secret-dependent timing signal.
 */
export const constantTimeEqualBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

/** Strings are compared as their UTF-8 bytes, so multi-byte characters cannot alias by code-point arithmetic. */
export const constantTimeEqualString = (a: string, b: string): boolean =>
  constantTimeEqualBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** RFC 2104 HMAC-SHA256 built from `Crypto.digest` — keys longer than the block size are hashed first. */
export const hmacSha256: (
  crypto: Crypto.Crypto,
  key: Uint8Array,
  message: Uint8Array,
) => Effect.Effect<Uint8Array, PlatformError.PlatformError> = Effect.fnUntraced(
  function* (crypto, key, message) {
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
  },
);

/** ACS-007: the floor for an HMAC-SHA256 signing secret — the digest's own 32-byte output size. */
export const MIN_SIGNING_SECRET_BYTES = 32;

/** A signing secret shorter than `minimum` UTF-8 bytes was supplied — a boot-time misconfiguration, so a defect. */
export class WeakSigningSecret extends Data.TaggedError("WeakSigningSecret")<{
  readonly bytes: number;
  readonly minimum: number;
}> {
  override get message(): string {
    return `awthaq: signing secret is ${this.bytes} bytes; at least ${this.minimum} are required.`;
  }
}

/**
 * Dies with `WeakSigningSecret` when `secret` is under `minimum` UTF-8 bytes
 * (default 32). Call it at layer construction, so a composition can never run
 * CSRF or challenge signing on a guessable key — the same "fail loudly, don't
 * limp along misconfigured" posture `KeyProvider.layerEnv` takes.
 */
export const requireMinSecretBytes = (
  secret: Redacted.Redacted<string>,
  minimum: number = MIN_SIGNING_SECRET_BYTES,
): Effect.Effect<void> => {
  const bytes = new TextEncoder().encode(Redacted.value(secret)).length;
  return bytes < minimum ? Effect.die(new WeakSigningSecret({ bytes, minimum })) : Effect.void;
};
