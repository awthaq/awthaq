// @awthaq/two-factor — RecoveryCodes
//
// THS-001 step 8 (BEH-EA-264): minting, displaying and normalising recovery codes — the pure half;
// hashing goes through the `PasswordHasher` port and single-use through the store.
//
// A code is `length` characters from a 32-symbol alphabet that leaves out the look-alikes
// (`0 O 1 I`), so a person can read one off a printout. 32 symbols is 5 bits each, so a byte
// masked to its low five bits is *exactly* uniform (256 is a multiple of 32) — no modulo bias and
// no rejection loop. Ten characters is 50 bits: with an argon2id hash per code, an offline search
// of a leaked table is not worth an attacker's time, and online guesses are bounded by the shared
// failure budget (BCR-006). Codes are shown grouped (`ABCDE-FGHJK`) and normalised (upper-cased,
// separators stripped) before they are hashed or compared.

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUP = 5;

const mint = (
  crypto: Crypto.Crypto,
  length: number,
): Effect.Effect<string, PlatformError.PlatformError> =>
  Effect.map(crypto.randomBytes(length), (bytes) =>
    Array.from(bytes, (byte) => ALPHABET[byte & 31] ?? "").join(""),
  );

/** `count` fresh codes, normalised (no separators). Independent draws — a duplicate within a set is astronomically unlikely and harmless. */
export const generate = (
  crypto: Crypto.Crypto,
  count: number,
  length: number,
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
  Effect.forEach(Array.from({ length: count }), () => mint(crypto, length));

/** `ABCDEFGHJK` → `ABCDE-FGHJK`. */
export const display = (normalized: string): string =>
  normalized.match(new RegExp(`.{1,${GROUP}}`, "g"))?.join("-") ?? normalized;

/** What a person typed → what is hashed and compared: upper-case, no spaces or hyphens. */
export const normalize = (input: string): string => input.replaceAll(/[\s-]/g, "").toUpperCase();

/** A cheap shape test, so a code that cannot be one is refused without running a single password hash. */
export const isWellFormed = (normalized: string, length: number): boolean =>
  normalized.length === length && [...normalized].every((char) => ALPHABET.includes(char));
