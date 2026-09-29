// @awthaq/migrate-firebase — FirebaseScryptVerifier
//
// FAMS-001 (decision 21): the `LegacyPasswordVerifierShape` a Firebase
// Authentication export needs. Firebase does not store a plain scrypt digest;
// it stores an AES-256-CTR encryption of a project-wide "signer key" under a
// key derived from the password (github.com/firebase/scrypt):
//
//   derived = scrypt(password, salt || saltSeparator, N = 2^memCost, r = rounds, p = 1, dkLen = 32)
//   hash    = AES-256-CTR(key = derived, counter = 16 zero bytes).encrypt(signerKey)
//
// `salt` is per user (exported as `salt`); `signerKey`, `saltSeparator`,
// `rounds` and `memCost` are project-wide (`hash_config` in
// `firebase auth:export`). A stored hash is only checkable with those four
// values, so the import encodes them into the credential string itself:
//
//   $firebase-scrypt$k=<signerKeyB64>,ss=<saltSeparatorB64>,r=<rounds>,mc=<memCost>$<saltB64>$<hashB64>
//
// (`encodeHash` builds it). Every value is base64 (no `$` or `,`), so the
// string is self-describing and nothing but this verifier needs project
// configuration at sign-in time.
//
// Verified against the algorithm's published test vector (see the test).
// Nothing here is hand-invented crypto: the two primitives are hash-wasm's
// scrypt (the same one `PasswordHasher` uses) and WebCrypto's AES-CTR, and the
// composition is exactly Firebase's. Like every legacy format it only ever
// *verifies*: the next successful sign-in replaces it with the deployment's
// argon2id/scrypt hash (`rehashOnLogin`).
//
// The stored parameters are untrusted input (an imported row), so cost is
// clamped before any derivation, in `PasswordHasher`'s ACS-006 style:
// `memCost` at most 17 (N = 131072, ~128 MiB at r = 8) and `rounds` at most 16.
// Firebase's own defaults are `memCost` 14 and `rounds` 8.

import { Hmac, PasswordHasher } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { scrypt } from "hash-wasm";

const BASE64 = "[A-Za-z0-9+/]+={0,2}";
const FIREBASE_SCRYPT = new RegExp(
  `^\\$firebase-scrypt\\$k=(${BASE64}),ss=(${BASE64}),r=(\\d{1,3}),mc=(\\d{1,3})\\$(${BASE64})\\$(${BASE64})$`,
);

/** Clamps on the stored cost parameters (ACS-006 style); see the header. */
export const MAX_MEM_COST = 17;
export const MAX_ROUNDS = 16;
/** Sanity bounds on the decoded byte lengths, so a hostile row cannot make the concat or cipher large. */
const MAX_KEY_BYTES = 256;

export interface FirebaseHashConfig {
  /** `hash_config.base64_signer_key`. */
  readonly signerKey: string;
  /** `hash_config.base64_salt_separator`. */
  readonly saltSeparator: string;
  /** `hash_config.rounds` (scrypt `r`). */
  readonly rounds: number;
  /** `hash_config.mem_cost` (`N = 2^memCost`). */
  readonly memCost: number;
}

/**
 * Builds the credential string to import for one exported Firebase user:
 * `salt` and `passwordHash` are the user's exported `salt` and `passwordHash`
 * (both base64), `config` the project's `hash_config`.
 */
export const encodeHash = (input: {
  readonly passwordHash: string;
  readonly salt: string;
  readonly config: FirebaseHashConfig;
}): PasswordHasher.PhcHash =>
  // TTE-005: the import trust boundary — this is where the credential is minted.
  PasswordHasher.PhcHash(
    `$firebase-scrypt$k=${input.config.signerKey},ss=${input.config.saltSeparator},r=${input.config.rounds},mc=${input.config.memCost}$${input.salt}$${input.passwordHash}`,
  );

const decode = (value: string | undefined): Uint8Array | undefined => {
  if (value === undefined) return undefined;
  const decoded = Encoding.decodeBase64(value);
  return decoded._tag === "Success" && decoded.success.length <= MAX_KEY_BYTES
    ? decoded.success
    : undefined;
};

const parse = (phc: string) => {
  const match = FIREBASE_SCRYPT.exec(phc);
  if (match === null) return undefined;
  const [, signerKeyB64, separatorB64, roundsStr, memCostStr, saltB64, hashB64] = match;
  const rounds = Number(roundsStr);
  const memCost = Number(memCostStr);
  if (
    !Number.isInteger(rounds) ||
    !Number.isInteger(memCost) ||
    rounds < 1 ||
    rounds > MAX_ROUNDS ||
    memCost < 1 ||
    memCost > MAX_MEM_COST
  ) {
    return undefined;
  }
  const signerKey = decode(signerKeyB64);
  const separator = decode(separatorB64);
  const salt = decode(saltB64);
  const hash = decode(hashB64);
  if (
    signerKey === undefined ||
    separator === undefined ||
    salt === undefined ||
    hash === undefined
  ) {
    return undefined;
  }
  return { signerKey, separator, salt, hash, rounds, memCost };
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export const firebaseScryptVerifier: PasswordHasher.LegacyPasswordVerifierShape = {
  id: "firebase-scrypt",
  recognizes: (phc) => phc.startsWith("$firebase-scrypt$"),
  verify: (plain, phc) => {
    const parsed = parse(phc);
    if (parsed === undefined) return Effect.succeed(false);
    return Effect.tryPromise(async () => {
      const derived = await scrypt({
        password: Redacted.value(plain),
        salt: concat(parsed.salt, parsed.separator),
        costFactor: 2 ** parsed.memCost,
        blockSize: parsed.rounds,
        parallelism: 1,
        hashLength: 32,
        outputType: "binary",
      });
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        // Copied into a fresh `ArrayBuffer`: WebCrypto's `BufferSource` rejects a view over `ArrayBufferLike`.
        Uint8Array.from(derived),
        { name: "AES-CTR" },
        false,
        ["encrypt"],
      );
      const encrypted = await globalThis.crypto.subtle.encrypt(
        { name: "AES-CTR", counter: new Uint8Array(16), length: 128 },
        key,
        Uint8Array.from(parsed.signerKey),
      );
      return Hmac.constantTimeEqualBytes(new Uint8Array(encrypted), parsed.hash);
    }).pipe(Effect.orElseSucceed(() => false));
  },
};

/**
 * Compose alongside the deployment's primary hasher layer. A deployment that
 * never installs this layer sees zero behavior change
 * (`PasswordHasher.LegacyPasswordVerifiers` defaults to `[]`). The reference
 * holds one list: to accept several legacy formats, provide
 * `Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [a, b, ...])` with
 * each package's verifier rather than merging their `layer`s.
 */
export const layer: Layer.Layer<never> = Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [
  firebaseScryptVerifier,
]);
