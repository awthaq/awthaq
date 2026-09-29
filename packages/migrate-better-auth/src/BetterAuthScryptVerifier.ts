// @awthaq/migrate-better-auth — BetterAuthScryptVerifier
//
// BAM-004: the `LegacyPasswordVerifierShape` a better-auth user import needs.
// better-auth stores a credential as `${saltHex}:${keyHex}`, produced by
// scrypt over the NFKC-normalized password with N=16384, r=16, p=1 and a
// 64-byte key, the salt being the 32-character hex string itself (its UTF-8
// bytes, not the bytes it encodes). That shape is fixed by better-auth's own
// `hashPassword` (packages/better-auth/src/crypto/password.ts and the
// backward-compatibility test beside it, which reproduces it with
// `@noble/hashes`).
//
// It cannot be re-serialized into `PasswordHasher.layerScrypt`'s own
// `$scrypt$` form (that layer fixes a 32-byte key and a base64 salt), so an
// imported hash stays in this format until the user's next successful
// sign-in, when `rehashOnLogin` replaces it with the deployment's own
// argon2id/scrypt hash.
//
// hash-wasm is what `PasswordHasher` already uses; the derivation is CPU-heavy
// (about 32 MiB) but runs once per not-yet-rehashed account, and the
// hasher bounds it with the same permits as every other KDF.

import { ConstantTime, PasswordHasher } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { scrypt } from "hash-wasm";

// `${salt}:${key}` — 16 random bytes as 32 lowercase hex characters, then the
// 64-byte key as 128. Anything else (a `$argon2id$`/`$scrypt$` PHC string, a
// bcrypt hash) never matches.
const BETTER_AUTH_SCRYPT = /^([0-9a-f]{32}):([0-9a-f]{128})$/;

const PARAMS = { costFactor: 16384, blockSize: 16, parallelism: 1, hashLength: 64 };

export const betterAuthScryptVerifier: PasswordHasher.LegacyPasswordVerifierShape = {
  id: "better-auth-scrypt",
  recognizes: (phc) => BETTER_AUTH_SCRYPT.test(phc),
  verify: (plain, phc) => {
    const match = BETTER_AUTH_SCRYPT.exec(phc);
    const [, salt, key] = match ?? [];
    if (salt === undefined || key === undefined) return Effect.succeed(false);
    return Effect.tryPromise(() =>
      scrypt({
        ...PARAMS,
        password: Redacted.value(plain).normalize("NFKC"),
        salt: new TextEncoder().encode(salt),
        outputType: "hex",
      }),
    ).pipe(
      Effect.map((derived) => ConstantTime.equalHex(derived, key)),
      Effect.orElseSucceed(() => false),
    );
  },
};

/**
 * Compose alongside the deployment's primary hasher layer. A deployment that
 * never installs this layer sees zero behavior change
 * (`PasswordHasher.LegacyPasswordVerifiers` defaults to `[]`). Note the
 * reference holds one list: to accept several legacy formats at once, provide
 * `Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [a, b, ...])` with
 * each package's verifier rather than merging their `layer`s (the last one
 * merged would win).
 */
export const layer: Layer.Layer<never> = Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [
  betterAuthScryptVerifier,
]);
