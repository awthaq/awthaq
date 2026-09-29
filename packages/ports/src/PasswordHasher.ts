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
// different algorithm, corrupted, or claiming a cost above the ceilings
// below) as needing a rehash: the safe default per OWASP is to upgrade,
// never to silently keep a hash whose provenance this layer cannot vouch for.
//
// PHS-002: "below the configured floor" is what the default
// `AUTH_PASSWORD_REHASH_POLICY=floor` means: a stored hash *stronger* than
// the current target (argon2 m or t, scrypt N or r above it) is kept, so
// lowering the configured cost never silently downgrades existing hashes,
// and `p` alone never triggers a rehash. `exact` rewrites any hash whose
// parameters differ at all, for an operator who deliberately lowers cost.
//
// PHS-001: `verify` never calls hash-wasm's `argon2Verify`, whose digest
// comparison is a plain `===` on the encoded strings. Both layers parse the
// stored string themselves, recompute with the stored salt, and compare the
// digest bytes with `timingSafeEqualBytes`.
//
// ACS-006/PHS-007: a stored hash is untrusted input (an imported or
// corrupted row) yet its embedded cost parameters drive the recomputation,
// so both layers refuse, without running the KDF, any hash claiming a cost
// above a configurable ceiling (`AUTH_ARGON2_MAX_MEMORY_KIB`/`_ITERATIONS`/
// `_PARALLELISM`, `AUTH_SCRYPT_MAX_COST_LOG2`/`_BLOCK_SIZE`/`_PARALLELISM`),
// and each ceiling must be at least the layer's own target or the layer
// fails to build. scrypt additionally bounds `N * r` (its memory) by the
// ceiling on `N` times the larger of the configured `r` and 8, so raising
// `r` and `N` ceilings independently cannot combine into a multi-GiB
// allocation.
//
// AOMS-001/FAMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21):
// `LegacyPasswordVerifiers` below closes the "Known non-goal" this comment
// used to describe in full — an IdP-migration import (Auth0's bcrypt,
// Firebase's modified scrypt, …) lands a foreign hash format in
// `credentialHash` that neither shipped layer's own `verify` can parse.
// This is deliberately *not* a second first-class hasher: `hash()` still
// only ever produces argon2id/scrypt output for either layer below — a
// legacy format is something `verify` can recognize and retire (via the
// existing `needsRehash`/`rehashOnLogin` path, unchanged by this), never
// something re-adopted as a standing target.

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { argon2id, scrypt } from "hash-wasm";

const SALT_LENGTH = 16;
const HASH_LENGTH = 32;

/**
 * Constant-time equality for two equal-length hex digests — `hash-wasm`'s
 * `scrypt` has no built-in verify, so `layerScrypt`'s own `verify`
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

/**
 * PHS-001: the same for raw digest bytes, which `layerArgon2id.verify` now
 * compares itself (hash-wasm's `argon2Verify` ends in a plain `===`). A
 * length mismatch is not secret (the stored digest length is public), so it
 * returns early; content differences never do.
 */
export const timingSafeEqualBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
};

/** PHS-002: `floor` (default) rewrites only hashes weaker than the target; `exact` rewrites any that differ. */
const rehashPolicyConfig = Config.Literals(["floor", "exact"], "AUTH_PASSWORD_REHASH_POLICY").pipe(
  Config.withDefault("floor"),
);

/** ACS-006: a ceiling below the layer's own target could never verify the layer's own output. */
const requireCeiling = (name: string, ceiling: number, targetName: string, target: number) =>
  ceiling >= target
    ? Effect.void
    : Effect.die(
        new Error(`awthaq: ${name} (${ceiling}) is below the configured ${targetName} (${target})`),
      );

export interface PasswordHasherShape {
  readonly hash: (plain: Redacted.Redacted<string>) => Effect.Effect<string>;
  readonly verify: (plain: Redacted.Redacted<string>, phc: string) => Effect.Effect<boolean>;
  readonly needsRehash: (phc: string) => boolean;
}

export class PasswordHasher extends Context.Service<PasswordHasher, PasswordHasherShape>()(
  "awthaq/ports/PasswordHasher",
) {}

/**
 * AOMS-001/FAMS-001: one foreign hash format an IdP migration package
 * knows how to verify. `recognizes` must be a cheap, crypto-free format
 * sniff (a PHC-tag prefix test) — never runs a KDF — since it runs on
 * every `verify` call regardless of whether the stored hash is actually
 * this format.
 */
export interface LegacyPasswordVerifierShape {
  /** e.g. "bcrypt", "firebase-scrypt" — observability only. */
  readonly id: string;
  readonly recognizes: (phc: string) => boolean;
  readonly verify: (plain: Redacted.Redacted<string>, phc: string) => Effect.Effect<boolean>;
}

/**
 * BEH-EA-017's `Context.Reference`-with-default pattern (matching
 * `.scratch/resolve-ready-for-human-findings` ticket 20's
 * `LegacySessionBridge`): a no-op `[]` default, so a deployment that
 * installs neither `@awthaq/migrate-auth0` nor a similar package sees
 * zero behavior change. `layerArgon2id`/`layerScrypt` both consult this,
 * legacy-first, inside their own `verify`.
 */
export const LegacyPasswordVerifiers: Context.Reference<
  ReadonlyArray<LegacyPasswordVerifierShape>
> = Context.Reference("awthaq/ports/LegacyPasswordVerifiers", {
  defaultValue: (): ReadonlyArray<LegacyPasswordVerifierShape> => [],
});

// $argon2id$v=19$m=<memorySize>,t=<iterations>,p=<parallelism>$<salt>$<hash>
// (salt and hash are unpadded base64).
const ARGON2ID_PHC =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** hash-wasm emits the salt and digest as unpadded base64; `Encoding.decodeBase64` wants padding. */
const decodeUnpaddedBase64 = (value: string): Uint8Array | undefined => {
  if (value.length % 4 === 1) return undefined;
  const decoded = Encoding.decodeBase64(value.padEnd(Math.ceil(value.length / 4) * 4, "="));
  return decoded._tag === "Success" ? decoded.success : undefined;
};

interface Argon2Ceilings {
  readonly memorySize: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/** The argon2 reference implementation's own floor for a salt; digests below 4 bytes are rejected outright. */
const ARGON2_MIN_SALT = 8;
const ARGON2_MIN_DIGEST = 4;
const ARGON2_MAX_DIGEST = 128;

const withinCeiling = (value: number, ceiling: number): boolean =>
  Number.isSafeInteger(value) && value >= 1 && value <= ceiling;

/**
 * Parses a stored argon2id string, or `undefined` if it is not argon2id
 * v19, is malformed, or claims a cost above `ceilings` (ACS-006). Never runs
 * the KDF.
 */
const parseArgon2id = (phc: string, ceilings: Argon2Ceilings) => {
  const match = ARGON2ID_PHC.exec(phc);
  if (match === null) return undefined;
  const [, version, memorySizeStr, iterationsStr, parallelismStr, saltB64, digestB64] = match;
  if (
    version === undefined ||
    memorySizeStr === undefined ||
    iterationsStr === undefined ||
    parallelismStr === undefined ||
    saltB64 === undefined ||
    digestB64 === undefined ||
    Number(version) !== 19
  ) {
    return undefined;
  }
  const memorySize = Number(memorySizeStr);
  const iterations = Number(iterationsStr);
  const parallelism = Number(parallelismStr);
  if (
    !withinCeiling(memorySize, ceilings.memorySize) ||
    !withinCeiling(iterations, ceilings.iterations) ||
    !withinCeiling(parallelism, ceilings.parallelism) ||
    memorySize < 8 * parallelism
  ) {
    return undefined;
  }
  const salt = decodeUnpaddedBase64(saltB64);
  const digest = decodeUnpaddedBase64(digestB64);
  if (
    salt === undefined ||
    digest === undefined ||
    salt.length < ARGON2_MIN_SALT ||
    digest.length < ARGON2_MIN_DIGEST ||
    digest.length > ARGON2_MAX_DIGEST
  ) {
    return undefined;
  }
  return { memorySize, iterations, parallelism, salt, digest };
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
      const legacy = yield* LegacyPasswordVerifiers;
      const memorySize = yield* Config.Int("AUTH_ARGON2_MEMORY_KIB").pipe(
        Config.withDefault(19_456),
      );
      const iterations = yield* Config.Int("AUTH_ARGON2_ITERATIONS").pipe(Config.withDefault(2));
      const parallelism = yield* Config.Int("AUTH_ARGON2_PARALLELISM").pipe(Config.withDefault(1));
      const rehashPolicy = yield* rehashPolicyConfig;
      const ceilings: Argon2Ceilings = {
        memorySize: yield* Config.Int("AUTH_ARGON2_MAX_MEMORY_KIB").pipe(
          Config.withDefault(262_144),
        ),
        iterations: yield* Config.Int("AUTH_ARGON2_MAX_ITERATIONS").pipe(Config.withDefault(16)),
        parallelism: yield* Config.Int("AUTH_ARGON2_MAX_PARALLELISM").pipe(Config.withDefault(8)),
      };
      yield* requireCeiling(
        "AUTH_ARGON2_MAX_MEMORY_KIB",
        ceilings.memorySize,
        "AUTH_ARGON2_MEMORY_KIB",
        memorySize,
      );
      yield* requireCeiling(
        "AUTH_ARGON2_MAX_ITERATIONS",
        ceilings.iterations,
        "AUTH_ARGON2_ITERATIONS",
        iterations,
      );
      yield* requireCeiling(
        "AUTH_ARGON2_MAX_PARALLELISM",
        ceilings.parallelism,
        "AUTH_ARGON2_PARALLELISM",
        parallelism,
      );

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

      const verify: PasswordHasherShape["verify"] = (plain, phc) => {
        const match = legacy.find((verifier) => verifier.recognizes(phc));
        if (match !== undefined) return match.verify(plain, phc);
        return Effect.gen(function* () {
          const parsed = parseArgon2id(phc, ceilings);
          if (parsed === undefined) return false;
          const digest = yield* Effect.tryPromise(() =>
            argon2id({
              password: Redacted.value(plain),
              salt: parsed.salt,
              iterations: parsed.iterations,
              parallelism: parsed.parallelism,
              memorySize: parsed.memorySize,
              hashLength: parsed.digest.length,
              outputType: "binary",
            }),
          );
          return timingSafeEqualBytes(digest, parsed.digest);
        }).pipe(Effect.orElseSucceed(() => false));
      };

      const needsRehash: PasswordHasherShape["needsRehash"] = (phc) => {
        const parsed = parseArgon2id(phc, ceilings);
        if (parsed === undefined) return true;
        if (rehashPolicy === "exact") {
          return (
            parsed.memorySize !== memorySize ||
            parsed.iterations !== iterations ||
            parsed.parallelism !== parallelism
          );
        }
        return parsed.memorySize < memorySize || parsed.iterations < iterations;
      };

      return PasswordHasher.of({ hash, verify, needsRehash });
    }),
  );

// A de-facto encoding (no PHC spec entry exists for scrypt), mirroring
// passlib's own `$scrypt$` format: `ln` is log2(costFactor), so the
// parameter block round-trips exactly instead of needing an approximate
// power-of-two recovery.
const SCRYPT_PARAMS = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/;

interface ScryptCeilings {
  readonly costLog2: number;
  readonly blockSize: number;
  readonly parallelism: number;
  /** ACS-006: bound on `N * r`, i.e. on scrypt's memory, so the per-axis ceilings cannot multiply into a huge allocation. */
  readonly work: number;
}

/**
 * Parses a stored scrypt string, or `undefined` if malformed or claiming a
 * cost above `ceilings` (ACS-006/PHS-007) — never runs the KDF. `ln` is
 * checked as an integer before `2 ** ln` is taken, so a huge exponent cannot
 * become `Infinity`.
 */
const parseScryptHash = (phc: string, ceilings: ScryptCeilings) => {
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
  const costLog2 = Number(costLog2Str);
  const blockSize = Number(blockSizeStr);
  const parallelism = Number(parallelismStr);
  if (
    !withinCeiling(costLog2, ceilings.costLog2) ||
    !withinCeiling(blockSize, ceilings.blockSize) ||
    !withinCeiling(parallelism, ceilings.parallelism) ||
    2 ** costLog2 * blockSize > ceilings.work
  ) {
    return undefined;
  }
  const salt = Encoding.decodeBase64(saltB64);
  if (salt._tag === "Failure") return undefined;
  return {
    costFactor: 2 ** costLog2,
    blockSize,
    parallelism,
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
      const legacy = yield* LegacyPasswordVerifiers;
      const costLog2 = yield* Config.Int("AUTH_SCRYPT_COST_LOG2").pipe(Config.withDefault(17));
      const blockSize = yield* Config.Int("AUTH_SCRYPT_BLOCK_SIZE").pipe(Config.withDefault(8));
      const parallelism = yield* Config.Int("AUTH_SCRYPT_PARALLELISM").pipe(Config.withDefault(1));
      const costFactor = 2 ** costLog2;
      const rehashPolicy = yield* rehashPolicyConfig;
      const maxCostLog2 = yield* Config.Int("AUTH_SCRYPT_MAX_COST_LOG2").pipe(
        Config.withDefault(20),
      );
      const maxBlockSize = yield* Config.Int("AUTH_SCRYPT_MAX_BLOCK_SIZE").pipe(
        Config.withDefault(32),
      );
      const maxParallelism = yield* Config.Int("AUTH_SCRYPT_MAX_PARALLELISM").pipe(
        Config.withDefault(16),
      );
      yield* requireCeiling(
        "AUTH_SCRYPT_MAX_COST_LOG2",
        maxCostLog2,
        "AUTH_SCRYPT_COST_LOG2",
        costLog2,
      );
      yield* requireCeiling(
        "AUTH_SCRYPT_MAX_BLOCK_SIZE",
        maxBlockSize,
        "AUTH_SCRYPT_BLOCK_SIZE",
        blockSize,
      );
      yield* requireCeiling(
        "AUTH_SCRYPT_MAX_PARALLELISM",
        maxParallelism,
        "AUTH_SCRYPT_PARALLELISM",
        parallelism,
      );
      const ceilings: ScryptCeilings = {
        costLog2: maxCostLog2,
        blockSize: maxBlockSize,
        parallelism: maxParallelism,
        work: 2 ** maxCostLog2 * Math.max(blockSize, 8),
      };

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

      const verify: PasswordHasherShape["verify"] = (plain, phc) => {
        const match = legacy.find((verifier) => verifier.recognizes(phc));
        if (match !== undefined) return match.verify(plain, phc);
        return Effect.gen(function* () {
          const parsed = parseScryptHash(phc, ceilings);
          if (parsed === undefined) return false;
          const digest = yield* Effect.tryPromise(() =>
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
      };

      const needsRehash: PasswordHasherShape["needsRehash"] = (phc) => {
        const parsed = parseScryptHash(phc, ceilings);
        if (parsed === undefined) return true;
        if (rehashPolicy === "exact") {
          return (
            parsed.costFactor !== costFactor ||
            parsed.blockSize !== blockSize ||
            parsed.parallelism !== parallelism
          );
        }
        return parsed.costFactor < costFactor || parsed.blockSize < blockSize;
      };

      return PasswordHasher.of({ hash, verify, needsRehash });
    }),
  );
