// @awthaq/ports — Hmac
//
// ACS-005/ACS-007: the one HMAC-SHA256 (RFC 2104), constant-time comparison
// and hex encoding this repository uses. The HMAC itself is effect's `Mac`
// service (`effect/crypto/Mac`); this module fixes the algorithm and the
// call shape every awthaq signer shares, and is tested against RFC 4231
// vectors and Node's own `createHmac` as an oracle (`test/Hmac.test.ts`).

import type * as CryptoError from "effect/crypto/CryptoError";
import * as Mac from "effect/crypto/Mac";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

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

/**
 * RFC 2104 zero-pads a key shorter than the hash's block size, so an empty key and a single zero
 * byte produce the same MAC. effect's `Mac.key` refuses an empty key outright; this keeps the
 * RFC's behaviour for it instead.
 */
export const rfc2104Key = (key: Uint8Array): Uint8Array =>
  key.length === 0 ? new Uint8Array(1) : key;

/**
 * RFC 2104 HMAC-SHA256 over effect's `Mac` service. Pass the service captured at layer
 * construction, so the returned effect has no requirement of its own.
 */
export const hmacSha256 = (
  mac: Mac.Mac["Service"],
  key: Uint8Array,
  message: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError.CryptoError> =>
  Effect.flatMap(Mac.key(Mac.hmacSha256, rfc2104Key(key)), (macKey) => mac.sign(macKey, message));

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
