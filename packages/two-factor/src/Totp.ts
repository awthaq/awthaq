// @awthaq/two-factor — Totp
//
// THS-001 step 1 (BEH-EA-260): the pure algorithm, with no plugin, store or clock in sight —
// RFC 4226 HOTP, RFC 6238 TOTP (HMAC-SHA-1, the algorithm every authenticator app implements),
// RFC 4648 base32 (the alphabet an authenticator's manual-entry field takes) and the Key Uri
// Format `otpauth://` link a QR code carries. It is sequenced first because the rest of the
// plugin has nothing to verify against without it, and it is checked against the published
// vectors (`test/Totp.test.ts`).
//
// HMAC-SHA-1 is effect's `Mac` service (`Mac.hmacSha1`), like `@awthaq/ports`' `Hmac` uses
// `Mac.hmacSha256`, so the module needs no `node:crypto` and runs wherever the composition's
// `Mac` layer does (`NodeCrypto.layer`, or `WebCrypto.layer` on an edge runtime). SHA-1 is fine here: HOTP's security rests on the
// HMAC construction, not on SHA-1's collision resistance (RFC 6238 §3, RFC 4226 §7.5).
//
// Codes are compared in constant time and *every* candidate step is evaluated, so the time a
// verification takes does not depend on which step (if any) matched. Replay is the caller's
// job in the sense that the last accepted step is a stored fact (`lastUsedStep`, THS-005): this
// module takes it as an input and refuses any step at or before it, and returns the matched
// step so the store can compare-and-set it (RFC 6238 §5.2: a verifier MUST NOT accept a second
// attempt of the same OTP).

import { Hmac } from "@awthaq/ports";
import type * as CryptoError from "effect/crypto/CryptoError";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** RFC 2104 HMAC-SHA-1 over effect's `Mac` service, the primitive HOTP (RFC 4226) is defined on. */
const hmacSha1 = (
  mac: Mac.Mac["Service"],
  key: Uint8Array,
  message: Uint8Array,
): Effect.Effect<Uint8Array, CryptoError.CryptoError> =>
  Effect.flatMap(Mac.key(Mac.hmacSha1, Hmac.rfc2104Key(key)), (macKey) =>
    mac.sign(macKey, message),
  );

const counterBytes = (counter: bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, counter, false);
  return bytes;
};

/**
 * RFC 4226 §5.3 dynamic truncation of the HMAC to `digits` decimal digits (zero-padded).
 * `digits` between 6 and 8 is what RFC 4226 §5.4 allows; 6 is what authenticator apps default to.
 */
export const hotp = (
  mac: Mac.Mac["Service"],
  key: Uint8Array,
  counter: bigint,
  digits: number,
): Effect.Effect<string, CryptoError.CryptoError> =>
  Effect.map(hmacSha1(mac, key, counterBytes(counter)), (tag) => {
    const offset = (tag[tag.length - 1] ?? 0) & 0x0f;
    const binary =
      (((tag[offset] ?? 0) & 0x7f) << 24) |
      ((tag[offset + 1] ?? 0) << 16) |
      ((tag[offset + 2] ?? 0) << 8) |
      (tag[offset + 3] ?? 0);
    return String(binary % 10 ** digits).padStart(digits, "0");
  });

export interface TotpOptions {
  /** Seconds per step — 30 in RFC 6238 and every authenticator app. */
  readonly period: number;
  readonly digits: number;
}

/** RFC 6238 §4.2: the time step a Unix time falls in (T0 = 0). */
export const stepOf = (epochSeconds: number, period: number): bigint =>
  BigInt(Math.floor(epochSeconds / period));

export const totp = (
  mac: Mac.Mac["Service"],
  key: Uint8Array,
  epochSeconds: number,
  options: TotpOptions,
): Effect.Effect<string, CryptoError.CryptoError> =>
  hotp(mac, key, stepOf(epochSeconds, options.period), options.digits);

export interface VerifyOptions extends TotpOptions {
  /** Steps accepted either side of the current one, for clock drift and typing delay (RFC 6238 §5.2 suggests one step). */
  readonly window: number;
  /** The last step this secret already accepted; that step and every earlier one are refused (replay). */
  readonly lastUsedStep: Option.Option<bigint>;
}

/**
 * Whether `code` is the TOTP of a step within `window` of `epochSeconds`'s step and after
 * `lastUsedStep`. Resolves the matched step (the caller compare-and-sets it into the store).
 * Every candidate is computed and compared in constant time; a malformed `code` (wrong length,
 * non-digits) is simply no match, never an error.
 */
export const verifyTotp = (
  mac: Mac.Mac["Service"],
  key: Uint8Array,
  code: string,
  epochSeconds: number,
  options: VerifyOptions,
): Effect.Effect<Option.Option<bigint>, CryptoError.CryptoError> =>
  Effect.gen(function* () {
    const wellFormed = code.length === options.digits && /^[0-9]+$/.test(code);
    const current = stepOf(epochSeconds, options.period);
    let matched: Option.Option<bigint> = Option.none();
    for (let offset = -options.window; offset <= options.window; offset += 1) {
      const step = current + BigInt(offset);
      if (step < BigInt(0)) continue;
      const expected = yield* hotp(mac, key, step, options.digits);
      // Compared even when `code` is malformed, so the work does not depend on its shape.
      const equal = Hmac.constantTimeEqualString(
        expected,
        wellFormed ? code : "x".repeat(options.digits),
      );
      const fresh = Option.match(options.lastUsedStep, {
        onNone: () => true,
        onSome: (last) => step > last,
      });
      if (wellFormed && equal && fresh) {
        matched = Option.match(matched, {
          onNone: () => Option.some(step),
          onSome: (best) => Option.some(step > best ? step : best),
        });
      }
    }
    return matched;
  });

// ---- base32 (RFC 4648 §6, unpadded) ---------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";
  return out;
};

/**
 * Tolerant of what people paste from an authenticator's manual-entry field: case, spaces,
 * hyphens and `=` padding are ignored. Any other character is `None`.
 */
export const base32Decode = (text: string): Option.Option<Uint8Array> => {
  const cleaned = text.replaceAll(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const bytes: Array<number> = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return Option.none();
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Option.some(Uint8Array.from(bytes));
};

// ---- the otpauth:// Key Uri Format ----------------------------------------------------

/** The link an authenticator app's QR scanner reads: label `issuer:account`, plus the parameters it needs. */
export const otpauthUri = (input: {
  readonly issuer: string;
  readonly accountName: string;
  /** The base32 secret. */
  readonly secret: string;
  readonly period: number;
  readonly digits: number;
}): string => {
  const issuer = encodeURIComponent(input.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(input.accountName)}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${input.digits}&period=${input.period}`;
};
