// @awthaq/core — SecretHash
//
// OCM-002/BEH-EA-050: the one hash-at-rest and constant-time-compare recipe for
// a secret the server mints and shows once, never a human-chosen one (that is
// `PasswordHasher`'s job). Its guessing is bounded by its entropy (256-bit
// session secrets, API keys, client secrets, SCIM tokens, invitation tokens,
// device codes) or by a short lifetime plus an attempt or rate budget (the 34.6-bit
// device user code, RFC 8628 §6.1 and DAG-004; OTP-format verification values,
// SOS-004). SHA-256 is deliberately not a KDF: an unauthenticated endpoint must
// not let a caller burn password-grade CPU per request.
//
// Two lookup shapes. By a public id: hash the presented secret, read the row, then
// `equals` against the stored hash (or `NEVER_MATCHES` when there is no row) before
// any branch on record state (PIL-007, BEH-EA-050). Or by the hash itself, where
// no compare is needed.
//
// Callers: core Sessions and Verification, api-key keys and clients,
// device-authorization, organization invitations, SCIM connections.
//
// Hashing is for a value the server only recognises. A value it must read again
// is sealed (`SealedColumn`, ADR-EA-019).

import { Hmac } from "@awthaq/ports";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";

/** SHA-256 of `secret`'s UTF-8 bytes, lower-case hex — the only form persisted. */
export const digest = (hasher: Digest.Digest["Service"], secret: string): Effect.Effect<string> =>
  hasher.digest(Digest.sha256, new TextEncoder().encode(secret)).pipe(Effect.map(Hmac.toHex));

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
