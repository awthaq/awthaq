// @awthaq/core — SecretHash
//
// OCM-002/BEH-EA-050: the one hash-at-rest and constant-time-compare recipe for
// high-entropy secrets that are looked up by a public id and compared by hash —
// session secrets (`Sessions.ts`), API keys and client secrets
// (`@awthaq/api-key`). SHA-256 is deliberately not a password KDF: these secrets
// are 256 random bits (nothing to brute-force) and an unauthenticated endpoint
// must not let a caller burn password-grade CPU per request. Never use this for a
// human-chosen secret; that is `PasswordHasher`'s job.

import { Hmac } from "@awthaq/ports";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

/** SHA-256 of `secret`'s UTF-8 bytes, lower-case hex — the only form persisted. */
export const digest = (
  crypto: Crypto.Crypto,
  secret: string,
): Effect.Effect<string, PlatformError.PlatformError> =>
  crypto.digest("SHA-256", new TextEncoder().encode(secret)).pipe(Effect.map(Hmac.toHex));

/**
 * Constant-time equality of two `digest` outputs (fixed-length hex, so length is
 * no signal). Never compare a stored hash with `===`.
 */
export const equals = (presentedHash: string, storedHash: string): boolean =>
  Hmac.constantTimeEqualString(presentedHash, storedHash);

/**
 * A hash no real secret produces (all zeros), for comparing against when the
 * looked-up id does not exist, so a miss does the same hash + compare work as a
 * hit with a wrong secret (PIL-007).
 */
export const NEVER_MATCHES = "0".repeat(64);
