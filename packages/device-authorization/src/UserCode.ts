// @awthaq/device-authorization — UserCode
//
// BEH-EA-299, spec/models/13-device-authorization.md "Security parameters" (DAG-004, RFC 8628 §6.1).
// The two secrets of the grant:
//
// - the **user code**, typed by a person on a second device: 8 symbols drawn uniformly from the
//   20-symbol consonant alphabet `BCDFGHJKLMNPQRSTVWXZ` (no vowels, so no accidental words; no digits,
//   so no `0/O` or `1/I` confusion) — 20^8, about 34.6 bits, the example RFC 8628 §6.1 gives. It is
//   displayed `XXXX-XXXX`, normalised on input (upper-cased, hyphens and whitespace stripped) and
//   then matched **exactly**: nothing here does prefix or fuzzy matching.
// - the **device code**, held by the polling device: 32 CSPRNG bytes, base64url.
//
// Neither is stored: a row keeps the SHA-256 (`SecretHash`) of the normalised user code and of the
// device code, and is looked up by that hash, so a database read yields no usable code.

import { SecretHash } from "@awthaq/core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";

export const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const LENGTH = 8;

const WELL_FORMED = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

/**
 * `256` is not a multiple of the alphabet size, so a byte is only used when it falls below the
 * largest multiple of `ALPHABET.length` that fits (rejection sampling): no symbol is favoured.
 */
const UNBIASED_BELOW = 256 - (256 % ALPHABET.length);

/** A fresh user code, `LENGTH` symbols of `ALPHABET`, drawn uniformly. */
export const generate = Effect.fnUntraced(function* (crypto: Crypto.Crypto) {
  let code = "";
  while (code.length < LENGTH) {
    // Over-draw so one round almost always suffices; a rejected byte costs nothing.
    const bytes = yield* crypto.randomBytes(LENGTH * 2).pipe(Effect.orDie);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BELOW || code.length === LENGTH) continue;
      code += ALPHABET.charAt(byte % ALPHABET.length);
    }
  }
  return code;
});

/** The display form, `XXXX-XXXX`. */
export const format = (code: string): string =>
  `${code.slice(0, LENGTH / 2)}-${code.slice(LENGTH / 2)}`;

/** Upper-cases and strips hyphens and whitespace: what a person may reasonably type, and nothing else. */
export const normalize = (input: string): string => input.toUpperCase().replace(/[\s-]/g, "");

/** A normalised code is exactly `LENGTH` symbols of `ALPHABET`; anything else cannot be a user code. */
export const isWellFormed = (normalized: string): boolean => WELL_FORMED.test(normalized);

/** SHA-256 hex of the normalised code — the only form persisted, and the row's lookup key. */
export const hash = (crypto: Crypto.Crypto, input: string) =>
  SecretHash.digest(crypto, normalize(input)).pipe(Effect.orDie);

/** A fresh device code: 32 CSPRNG bytes, base64url (43 characters, no padding). Never logged. */
export const generateDeviceCode = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(32).pipe(Effect.map(Encoding.encodeBase64Url), Effect.orDie);

/** SHA-256 hex of a device code, the form persisted and looked up by. */
export const hashDeviceCode = (crypto: Crypto.Crypto, deviceCode: string) =>
  SecretHash.digest(crypto, deviceCode).pipe(Effect.orDie);
