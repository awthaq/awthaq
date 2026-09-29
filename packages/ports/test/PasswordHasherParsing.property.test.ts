// ETVS-002: property tests for stored-hash parsing. A stored hash is attacker-influenceable
// (an import, a restored backup, a tampered row), and `verify`/`needsRehash` parse it before any
// KDF runs — so the parse must (a) never throw, (b) treat everything it cannot prove safe as
// "wrong password"/"needs rehash", and (c) never let a claimed cost above the configured ceiling
// reach the KDF (ACS-006/PHS-007). No property here ever runs a KDF on a hash it accepts:
// `verify` is only called on strings the oracle says must be rejected.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import * as PasswordHasher from "../src/PasswordHasher.ts";

const mint = PasswordHasher.PhcHash;

// A cheap configured target (so the layer is real but its target is small) with the default ceilings.
const withEnv = (env: Record<string, string>) =>
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const TARGET = { memory: 1024, iterations: 2 } as const;
const Argon2 = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(NodeCrypto.layer),
  withEnv({
    AUTH_ARGON2_MEMORY_KIB: String(TARGET.memory),
    AUTH_ARGON2_ITERATIONS: String(TARGET.iterations),
  }),
);
const ARGON2_CEILING = { memory: 262_144, iterations: 16, parallelism: 8 } as const;

const SCRYPT_TARGET = { costLog2: 10, blockSize: 8 } as const;
const Scrypt = PasswordHasher.layerScrypt.pipe(
  Layer.provide(NodeCrypto.layer),
  withEnv({
    AUTH_SCRYPT_COST_LOG2: String(SCRYPT_TARGET.costLog2),
    AUTH_SCRYPT_BLOCK_SIZE: String(SCRYPT_TARGET.blockSize),
  }),
);
const SCRYPT_CEILING = { costLog2: 20, blockSize: 32, parallelism: 16 } as const;
// AUTH_SCRYPT_MAX_COST_LOG2 * max(target block size, 8): the memory bound on N * r.
const SCRYPT_WORK = 2 ** SCRYPT_CEILING.costLog2 * Math.max(SCRYPT_TARGET.blockSize, 8);

// Printable ASCII, non-empty: the KDF backend rejects an empty password (the Password plugin's own
// minimum length keeps it away from here), and HMAC-based KDFs (scrypt = PBKDF2-HMAC) zero-pad the
// key, so "abc" and "abc\0" are the same key by construction — not a property of this library.
const Printable = Schema.String.check(Schema.isPattern(/^[ -~]{1,24}$/));

const bytes = (min: number, max: number) =>
  Arbitrary.map(
    Arbitrary.schema(
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
        Schema.isMinLength(min),
        Schema.isMaxLength(max),
      ),
    ),
    (values) => Uint8Array.from(values),
  );
const unpaddedBase64 = (data: Uint8Array): string =>
  Buffer.from(data).toString("base64").replace(/=+$/, "");

/**
 * Integers that straddle every boundary a check has: zero, small, the ceiling, just above it,
 * enormous, and the configured target's own neighbourhood (`pivots`) — without those a
 * "weaker than the target" comparison is almost never exercised at its edge.
 */
const cost = (ceiling: number, pivots: ReadonlyArray<number>) =>
  Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: ceiling + 3 })),
    Schema.Int.check(Schema.isBetween({ minimum: ceiling + 1, maximum: Number.MAX_SAFE_INTEGER })),
    Schema.Literals(pivots.flatMap((pivot) => [pivot - 1, pivot, pivot + 1])),
  ]);

const argon2 = (m: number, t: number, p: number, salt: Uint8Array, digest: Uint8Array) =>
  `$argon2id$v=19$m=${m},t=${t},p=${p}$${unpaddedBase64(salt)}$${unpaddedBase64(digest)}`;

/** Mirrors the documented acceptance rule (ACS-006): integers in [1, ceiling] and m >= 8p. */
const argon2Accepted = (m: number, t: number, p: number) =>
  m >= 1 &&
  m <= ARGON2_CEILING.memory &&
  t >= 1 &&
  t <= ARGON2_CEILING.iterations &&
  p >= 1 &&
  p <= ARGON2_CEILING.parallelism &&
  m >= 8 * p;

const scrypt = (ln: number, r: number, p: number, salt: Uint8Array, hash: string) =>
  `$scrypt$ln=${ln},r=${r},p=${p}$${Buffer.from(salt).toString("base64")}$${hash}`;

const scryptAccepted = (ln: number, r: number, p: number) =>
  ln >= 1 &&
  ln <= SCRYPT_CEILING.costLog2 &&
  r >= 1 &&
  r <= SCRYPT_CEILING.blockSize &&
  p >= 1 &&
  p <= SCRYPT_CEILING.parallelism &&
  2 ** ln * r <= SCRYPT_WORK;

describe("stored argon2id hash parsing properties (ACS-006/PHS-001)", () => {
  it.effect.prop(
    "any string fails verification and needs a rehash, and parsing never throws",
    { text: Schema.String, plain: Schema.String },
    ({ text, plain }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isFalse(yield* hasher.verify(Redacted.make(plain), mint(text)));
        assert.isTrue(hasher.needsRehash(mint(text)));
      }).pipe(Effect.provide(Argon2)),
  );

  it.effect.prop(
    "ACS-006: a hash claiming a cost above the ceiling (or a non-positive/oversized value) is rejected without running the KDF",
    {
      m: cost(ARGON2_CEILING.memory, [TARGET.memory]),
      t: cost(ARGON2_CEILING.iterations, [TARGET.iterations]),
      p: cost(ARGON2_CEILING.parallelism, [1]),
      salt: bytes(8, 24),
      digest: bytes(4, 64),
    },
    ({ m, t, p, salt, digest }) =>
      Effect.gen(function* () {
        // Only the definitively over-ceiling shapes are verified: a KDF run is never reached.
        if (argon2Accepted(m, t, p)) return;
        if (
          !(
            m > ARGON2_CEILING.memory ||
            t > ARGON2_CEILING.iterations ||
            p > ARGON2_CEILING.parallelism
          )
        ) {
          return;
        }
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = mint(argon2(m, t, p, salt, digest));
        assert.isFalse(yield* hasher.verify(Redacted.make("pw"), phc));
        assert.isTrue(hasher.needsRehash(phc));
      }).pipe(Effect.provide(Argon2)),
    2_000,
  );

  it.effect.prop(
    "PHS-002: needsRehash is exactly `unparseable, or weaker than the configured target` (floor policy)",
    {
      m: cost(ARGON2_CEILING.memory, [TARGET.memory]),
      t: cost(ARGON2_CEILING.iterations, [TARGET.iterations]),
      p: cost(ARGON2_CEILING.parallelism, [1]),
      salt: bytes(0, 24),
      digest: bytes(0, 140),
    },
    ({ m, t, p, salt, digest }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const wellFormed =
          argon2Accepted(m, t, p) && salt.length >= 8 && digest.length >= 4 && digest.length <= 128;
        const expected = !wellFormed || m < TARGET.memory || t < TARGET.iterations;
        assert.strictEqual(hasher.needsRehash(mint(argon2(m, t, p, salt, digest))), expected);
      }).pipe(Effect.provide(Argon2)),
  );

  it.effect.prop(
    "PHS-002: at the target's own boundary (m, t one below/at/above) needsRehash flips exactly when the hash is weaker",
    {
      m: Schema.Literals([TARGET.memory - 1, TARGET.memory, TARGET.memory + 1]),
      t: Schema.Literals([TARGET.iterations - 1, TARGET.iterations, TARGET.iterations + 1]),
      p: Schema.Literals([1, 2]),
      salt: bytes(8, 16),
      digest: bytes(4, 32),
    },
    ({ m, t, p, salt, digest }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const weaker = m < TARGET.memory || t < TARGET.iterations;
        assert.strictEqual(hasher.needsRehash(mint(argon2(m, t, p, salt, digest))), weaker);
      }).pipe(Effect.provide(Argon2)),
  );

  it.effect.prop(
    "PHS-001: a hash minted at the configured cost round-trips (verify true, no rehash) and any other password fails",
    { plain: Printable, other: Printable },
    ({ plain, other }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = yield* hasher.hash(Redacted.make(plain));
        assert.isTrue(yield* hasher.verify(Redacted.make(plain), phc));
        assert.isFalse(hasher.needsRehash(phc));
        if (other !== plain) assert.isFalse(yield* hasher.verify(Redacted.make(other), phc));
      }).pipe(Effect.provide(Argon2)),
    // KDF runs (cheap params): keep the run count low so this stays fast in CI.
    { arbitrary: { runs: 8 } },
  );
});

describe("stored scrypt hash parsing properties (ACS-006/PHS-007)", () => {
  it.effect.prop(
    "any string fails verification and needs a rehash, and parsing never throws",
    { text: Schema.String, plain: Schema.String },
    ({ text, plain }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        assert.isFalse(yield* hasher.verify(Redacted.make(plain), mint(text)));
        assert.isTrue(hasher.needsRehash(mint(text)));
      }).pipe(Effect.provide(Scrypt)),
  );

  it.effect.prop(
    "ACS-006: a hash claiming ln/r/p above the ceiling, or N*r above the memory bound, is rejected without running the KDF",
    {
      ln: cost(SCRYPT_CEILING.costLog2, [SCRYPT_TARGET.costLog2]),
      r: cost(SCRYPT_CEILING.blockSize, [SCRYPT_TARGET.blockSize]),
      p: cost(SCRYPT_CEILING.parallelism, [1]),
      salt: bytes(1, 24),
      hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/)),
    },
    ({ ln, r, p, salt, hash }) =>
      Effect.gen(function* () {
        // Only shapes the oracle proves are past a bound: verify must never reach the KDF.
        if (scryptAccepted(ln, r, p)) return;
        const overAxis =
          ln > SCRYPT_CEILING.costLog2 ||
          r > SCRYPT_CEILING.blockSize ||
          p > SCRYPT_CEILING.parallelism;
        const overWork =
          ln >= 1 && ln <= SCRYPT_CEILING.costLog2 && r >= 1 && 2 ** ln * r > SCRYPT_WORK;
        if (!overAxis && !overWork) return;
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = mint(scrypt(ln, r, p, salt, hash));
        assert.isFalse(yield* hasher.verify(Redacted.make("pw"), phc));
        assert.isTrue(hasher.needsRehash(phc));
      }).pipe(Effect.provide(Scrypt)),
    2_000,
  );

  it.effect.prop(
    "PHS-002: needsRehash is exactly `unparseable, or weaker than the configured target` (floor policy)",
    {
      ln: cost(SCRYPT_CEILING.costLog2, [SCRYPT_TARGET.costLog2]),
      r: cost(SCRYPT_CEILING.blockSize, [SCRYPT_TARGET.blockSize]),
      p: cost(SCRYPT_CEILING.parallelism, [1]),
      salt: bytes(0, 24),
      hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/)),
    },
    ({ ln, r, p, salt, hash }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const expected =
          // The format needs a non-empty salt field; the scrypt parser sets no minimum length beyond that.
          salt.length === 0 ||
          !scryptAccepted(ln, r, p) ||
          ln < SCRYPT_TARGET.costLog2 ||
          r < SCRYPT_TARGET.blockSize;
        assert.strictEqual(hasher.needsRehash(mint(scrypt(ln, r, p, salt, hash))), expected);
      }).pipe(Effect.provide(Scrypt)),
  );

  it.effect.prop(
    "PHS-002: at the target's own boundary (ln, r one below/at/above) needsRehash flips exactly when the hash is weaker",
    {
      ln: Schema.Literals([
        SCRYPT_TARGET.costLog2 - 1,
        SCRYPT_TARGET.costLog2,
        SCRYPT_TARGET.costLog2 + 1,
      ]),
      r: Schema.Literals([
        SCRYPT_TARGET.blockSize - 1,
        SCRYPT_TARGET.blockSize,
        SCRYPT_TARGET.blockSize + 1,
      ]),
      p: Schema.Literals([1, 2]),
      salt: bytes(1, 16),
      hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{4,64}$/)),
    },
    ({ ln, r, p, salt, hash }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const weaker = ln < SCRYPT_TARGET.costLog2 || r < SCRYPT_TARGET.blockSize;
        assert.strictEqual(hasher.needsRehash(mint(scrypt(ln, r, p, salt, hash))), weaker);
      }).pipe(Effect.provide(Scrypt)),
  );

  it.effect.prop(
    "PHS-007: a hash minted at the configured cost round-trips (verify true, no rehash) and any other password fails",
    { plain: Printable, other: Printable },
    ({ plain, other }) =>
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        const phc = yield* hasher.hash(Redacted.make(plain));
        assert.isTrue(yield* hasher.verify(Redacted.make(plain), phc));
        assert.isFalse(hasher.needsRehash(phc));
        if (other !== plain) assert.isFalse(yield* hasher.verify(Redacted.make(other), phc));
      }).pipe(Effect.provide(Scrypt)),
    { arbitrary: { runs: 8 } },
  );
});
