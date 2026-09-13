// @awthaq/ports — PasswordHasher
//
// spec/overview.md's Ports stratum table ("PasswordHasher (layerArgon2id,
// layerScrypt)") and archive/design/api-design-v4.md §3, which gives this
// port's concrete interface almost verbatim:
//
//   export class PasswordHasher extends Context.Service<PasswordHasher, {
//     hash(plain: Redacted.Redacted<string>): Effect.Effect<string>            // PHC string
//     verify(plain: Redacted.Redacted<string>, phc: string): Effect.Effect<boolean>
//     needsRehash(phc: string): boolean
//   }>()("awthaq/ports/PasswordHasher") { ... }
//
// No BEH-EA range is allocated for the Ports stratum yet
// (spec/traceability.md); this module is grounded directly in the cited
// spec/archive/research sources rather than a numbered behavior, the same
// way `@awthaq/sql`'s workaround comments cite ADRs directly where no
// BEH-EA covers a specific implementation detail.
//
// research/07-passwords-2fa.md Q52 names the OWASP Password Storage Cheat
// Sheet baseline this follows: argon2id `m=19456, t=2, p=1` as the
// "balanced" default (one of five OWASP-equivalent configs), scrypt
// `N=2^17, r=8, p=1` as the fallback "when argon2 unavailable". Both are
// built on `hash-wasm` rather than `@node-rs/argon2` — research/07 Q52's
// own words: "hash-wasm v4.12.0 (MIT, zero-dep pure WASM, runs in
// browsers/Node/Deno/Web Workers) brings argon2id to edge runtimes" — the
// same "zero native compilation" preference already applied to
// `@effect/sql-sqlite-node` in `@awthaq/sql`: no platform-specific
// prebuilt binary, no native compilation step, works unmodified on any
// runtime that can load WASM.
//
// Rehash-on-login (`needsRehash`) is decidable entirely from the stored
// hash string, per OWASP's "Upgrading the Work Factor" and
// research/07-passwords-2fa.md's "two triggers: (a) a legacy algorithm,
// (b) parameters below the current configured floor" — both `layerArgon2id`
// and `layerScrypt` parse their own hash format's embedded parameters and
// compare them against the layer's *own* currently configured target, and
// treat any hash they cannot parse as their own format (produced by a
// different algorithm, or corrupted) as needing a rehash: the safe default
// per OWASP is to upgrade, never to silently keep a hash whose provenance
// this layer cannot vouch for.
//
// Known non-goal: swapping `PasswordHasher` implementations mid-flight
// (e.g. migrating a fleet from scrypt to argon2id) is not designed against
// here — `verify` only understands its own layer's hash format, matching
// archive/design/plugins-as-layers.md §3.3's "swapping a port is a
// `Layer.provide` at composition time", one implementation in scope at a
// time. A dual-format verifier for live algorithm migration is future work
// this module doesn't attempt to anticipate.

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { argon2id, argon2Verify, scrypt } from "hash-wasm";

const SALT_LENGTH = 16;
const HASH_LENGTH = 32;

/**
 * Constant-time equality for two equal-length hex digests — `hash-wasm`'s
 * `scrypt` has no built-in verify (unlike `argon2Verify`, which is expected
 * to compare in constant time internally), so `layerScrypt`'s own `verify`
 * needs one: an early `!==` return on length or an ordinary `===` on the
 * digest would leak timing information a constant-time comparison is
 * specifically meant to deny an attacker.
 */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

export interface PasswordHasherShape {
  readonly hash: (plain: Redacted.Redacted<string>) => Effect.Effect<string>;
  readonly verify: (plain: Redacted.Redacted<string>, phc: string) => Effect.Effect<boolean>;
  readonly needsRehash: (phc: string) => boolean;
}

export class PasswordHasher extends Context.Service<PasswordHasher, PasswordHasherShape>()(
  "awthaq/ports/PasswordHasher",
) {}

// $argon2id$v=19$m=<memorySize>,t=<iterations>,p=<parallelism>$<salt>$<hash>
const ARGON2ID_PARAMS = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/;

const parseArgon2idParams = (
  phc: string,
):
  | { readonly memorySize: number; readonly iterations: number; readonly parallelism: number }
  | undefined => {
  const match = ARGON2ID_PARAMS.exec(phc);
  if (match === null) return undefined;
  const [, memorySizeStr, iterationsStr, parallelismStr] = match;
  if (memorySizeStr === undefined || iterationsStr === undefined || parallelismStr === undefined)
    return undefined;
  return {
    memorySize: Number(memorySizeStr),
    iterations: Number(iterationsStr),
    parallelism: Number(parallelismStr),
  };
};

/**
 * BEH-EA-020 (`archive/design/plugins-as-layers.md` §3.3): the default,
 * OWASP-preferred hasher — argon2id, `m=19456, t=2, p=1` unless overridden
 * via `AUTH_ARGON2_MEMORY_KIB`/`AUTH_ARGON2_ITERATIONS`/
 * `AUTH_ARGON2_PARALLELISM`, matching `archive/PRD.md`'s own env var name
 * for the memory parameter.
 */
export const layerArgon2id: Layer.Layer<PasswordHasher, Config.ConfigError, Crypto.Crypto> =
  Layer.effect(
    PasswordHasher,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const memorySize = yield* Config.Int("AUTH_ARGON2_MEMORY_KIB").pipe(
        Config.withDefault(19_456),
      );
      const iterations = yield* Config.Int("AUTH_ARGON2_ITERATIONS").pipe(Config.withDefault(2));
      const parallelism = yield* Config.Int("AUTH_ARGON2_PARALLELISM").pipe(Config.withDefault(1));

      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          return yield* Effect.promise(() =>
            argon2id({
              password: Redacted.value(plain),
              salt,
              iterations,
              parallelism,
              memorySize,
              hashLength: HASH_LENGTH,
              outputType: "encoded",
            }),
          );
        }).pipe(Effect.orDie);

      const verify: PasswordHasherShape["verify"] = (plain, phc) =>
        Effect.tryPromise(() => argon2Verify({ password: Redacted.value(plain), hash: phc })).pipe(
          Effect.orElseSucceed(() => false),
        );

      const needsRehash: PasswordHasherShape["needsRehash"] = (phc) => {
        const params = parseArgon2idParams(phc);
        if (params === undefined) return true;
        return (
          params.memorySize !== memorySize ||
          params.iterations !== iterations ||
          params.parallelism !== parallelism
        );
      };

      return PasswordHasher.of({ hash, verify, needsRehash });
    }),
  );

// A de-facto encoding (no PHC spec entry exists for scrypt), mirroring
// passlib's own `$scrypt$` format: `ln` is log2(costFactor), so the
// parameter block round-trips exactly instead of needing an approximate
// power-of-two recovery.
const SCRYPT_PARAMS = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/;

const parseScryptHash = (
  phc: string,
):
  | {
      readonly costFactor: number;
      readonly blockSize: number;
      readonly parallelism: number;
      readonly salt: Uint8Array;
      readonly hash: string;
    }
  | undefined => {
  const match = SCRYPT_PARAMS.exec(phc);
  if (match === null) return undefined;
  const [, costLog2Str, blockSizeStr, parallelismStr, saltB64, hash] = match;
  if (
    costLog2Str === undefined ||
    blockSizeStr === undefined ||
    parallelismStr === undefined ||
    saltB64 === undefined ||
    hash === undefined
  ) {
    return undefined;
  }
  const salt = Encoding.decodeBase64(saltB64);
  if (salt._tag === "Failure") return undefined;
  return {
    costFactor: 2 ** Number(costLog2Str),
    blockSize: Number(blockSizeStr),
    parallelism: Number(parallelismStr),
    salt: salt.success,
    hash,
  };
};

/**
 * BEH-EA-020: the zero-native-dependency fallback named in
 * `research/07-passwords-2fa.md` Q52 for when argon2id itself is
 * unavailable — `N=2^17, r=8, p=1` unless overridden via
 * `AUTH_SCRYPT_COST_LOG2`/`AUTH_SCRYPT_BLOCK_SIZE`/
 * `AUTH_SCRYPT_PARALLELISM`.
 */
export const layerScrypt: Layer.Layer<PasswordHasher, Config.ConfigError, Crypto.Crypto> =
  Layer.effect(
    PasswordHasher,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const costLog2 = yield* Config.Int("AUTH_SCRYPT_COST_LOG2").pipe(Config.withDefault(17));
      const blockSize = yield* Config.Int("AUTH_SCRYPT_BLOCK_SIZE").pipe(Config.withDefault(8));
      const parallelism = yield* Config.Int("AUTH_SCRYPT_PARALLELISM").pipe(Config.withDefault(1));
      const costFactor = 2 ** costLog2;

      const hash: PasswordHasherShape["hash"] = (plain) =>
        Effect.gen(function* () {
          const salt = yield* crypto.randomBytes(SALT_LENGTH);
          const digest = yield* Effect.promise(() =>
            scrypt({
              password: Redacted.value(plain),
              salt,
              costFactor,
              blockSize,
              parallelism,
              hashLength: HASH_LENGTH,
              outputType: "hex",
            }),
          );
          return `$scrypt$ln=${costLog2},r=${blockSize},p=${parallelism}$${Encoding.encodeBase64(salt)}$${digest}`;
        }).pipe(Effect.orDie);

      const verify: PasswordHasherShape["verify"] = (plain, phc) =>
        Effect.gen(function* () {
          const parsed = parseScryptHash(phc);
          if (parsed === undefined) return false;
          const digest = yield* Effect.promise(() =>
            scrypt({
              password: Redacted.value(plain),
              salt: parsed.salt,
              costFactor: parsed.costFactor,
              blockSize: parsed.blockSize,
              parallelism: parsed.parallelism,
              hashLength: HASH_LENGTH,
              outputType: "hex",
            }),
          );
          return timingSafeEqualHex(digest, parsed.hash);
        }).pipe(Effect.orElseSucceed(() => false));

      const needsRehash: PasswordHasherShape["needsRehash"] = (phc) => {
        const parsed = parseScryptHash(phc);
        if (parsed === undefined) return true;
        return (
          parsed.costFactor !== costFactor ||
          parsed.blockSize !== blockSize ||
          parsed.parallelism !== parallelism
        );
      };

      return PasswordHasher.of({ hash, verify, needsRehash });
    }),
  );
