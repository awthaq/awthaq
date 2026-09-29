// @awthaq/jwt — KeyRing
//
// .scratch/jwt/spec.md's "Key management" decision. The first real
// consumer of `LayerRef.Service` in this codebase (see
// archive/design/api-design-v4.md §11's own `KeyRing`/`SigningKeys.layerFromStore`
// sketch, which this module implements for real): a `SigningKeysCache`
// snapshot — the current signing key plus every still-verifiable key — is
// built once by reading `SigningKeyRecords` (lazily minting a first key if
// none exists yet, rotating one already past `keyRotationInterval` — ticket
// 11), then cached behind a `LayerRef` so ordinary sign/verify calls
// (ticket 08 onward) never hit the store directly.
//
// Key generation uses the platform WebCrypto (`globalThis.crypto.subtle`)
// through `JwtCodec.generateKeyJwks`, over the one algorithm table `JwtCodec`
// owns (EdDSA, ES256, ES384, RS256, PS256) per `JwtConfig.algorithm`.
//
// .scratch/jwt/issues/11-key-rotation.md's own resolved design split: the
// *mutation* (mark the stale key rotated, mint its replacement) always
// happens inside `layerFromStore` itself, which already has every service
// that requires (`SigningKeyRecords`/`Crypto`); the *decision* to trigger
// it lives in the cheap, low-requirement `rotateIfDue` below (`KeyRing` +
// `JwtConfig` only — one in-memory age check against the already-cached
// snapshot, no store access unless a rotation is actually due), called by
// `current`/`verifiable` on every access rather than only on
// `idleTimeToLive`-driven rebuilds (age-since-mint, not
// time-since-last-access, is what actually matters here — a continuously
// busy `KeyRing` would otherwise never re-check). When due, it calls
// `ref.refresh`, which forces `layerFromStore` to re-run and perform the
// rotation for real.
//
// Multi-instance safety (JJS-004/KRS-009): several processes share one
// `SigningKeyRecords` store, so rotation must be safe to race. The store
// guarantees at most one current key (`SigningKeyRecords.ts`), `markRotated`
// is a compare-and-swap that reports whether this caller won, and the
// mark-then-mint pair runs inside one `SqlTransaction` (a crash between the
// two rolls back and leaves the previous key current). A loser — of the
// rotation or of the very first lazy mint — re-reads the store and adopts
// whatever key the winner made current. `KeyRing` therefore requires
// `SqlTransaction` (`layerNoop` for an in-memory composition).
//
// Convergence (KRS-006): a busy process never lets its `LayerRef` idle out, so
// its snapshot also expires after `JwtConfig.keyCacheMaxAge`, and `Jwt.verify`
// forces one rate-limited `refresh` when a token names a `kid` the snapshot
// lacks — peer or out-of-band rotations become visible without a restart.
//
// Emergency rotation (N12/KRS-008): `rotateNow` alone keeps the rotated-out
// key published and verifying for `keyGracePeriod`, which is exactly wrong for
// a *compromised* key. `rotateNow({ gracePeriod: Duration.zero })` retires the
// old key immediately, and `revoke(kid)` does the same for a key that was
// already rotated out. See spec/decisions/017-jwt-signing-key-rotation.md.

import { Defects, SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerRef from "effect/LayerRef";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as JwtCodec from "./JwtCodec.ts";
import type { Algorithm } from "./JwtConfig.ts";
import { JwtConfig } from "./JwtConfig.ts";
import * as SigningKeyRecords from "./SigningKeyRecords.ts";

export interface SigningKey {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: SigningKeyRecords.Jwk;
  readonly privateKeyJwk: Option.Option<Redacted.Redacted<SigningKeyRecords.Jwk>>;
  readonly createdAt: DateTime.Utc;
}

export interface SigningKeysShape {
  readonly current: SigningKey;
  readonly verifiable: ReadonlyArray<SigningKey>;
  /** When this snapshot was read from the store — see `keyCacheMaxAge`. */
  readonly loadedAt: DateTime.Utc;
}

export class SigningKeysCache extends Context.Service<SigningKeysCache, SigningKeysShape>()(
  "awthaq/jwt/SigningKeysCache",
) {}

/** `importKey` was handed a JWK that cannot be a public verification key for the stated algorithm. */
export class InvalidKeyImport extends Data.TaggedError("InvalidKeyImport")<{
  readonly reason: string;
}> {}

const toSigningKey = (record: SigningKeyRecords.SigningKeyRecord): SigningKey => ({
  kid: record.kid,
  alg: record.alg,
  publicKeyJwk: record.publicKeyJwk,
  privateKeyJwk: record.privateKeyJwk,
  createdAt: record.createdAt,
});

/**
 * JJS-003: a current key is due for rotation when it is past
 * `keyRotationInterval` *or* was minted under a different algorithm than
 * `JwtConfig.algorithm` now names — otherwise every new token would carry
 * the old algorithm until the interval elapsed. The old key stays in the
 * verifiable set for its grace period either way.
 */
const isDue = (
  key: { readonly createdAt: DateTime.Utc; readonly alg: Algorithm },
  now: DateTime.Utc,
  config: { readonly keyRotationInterval: Duration.Duration; readonly algorithm: Algorithm },
): boolean =>
  key.alg !== config.algorithm || isStale(key.createdAt, now, config.keyRotationInterval);

const isStale = (
  createdAt: DateTime.Utc,
  now: DateTime.Utc,
  interval: Duration.Duration,
): boolean =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(createdAt) >= Duration.toMillis(interval);

/** Generates a fresh key pair and persists it as the current key — the lazy-mint path `layerFromStore` falls back to when no current key exists, and what a rotation always mints as the stale key's replacement. */
const mint = Effect.fnUntraced(function* (algorithm: Algorithm, rsaModulusLength: number) {
  const records = yield* SigningKeyRecords.SigningKeyRecords;
  const crypto = yield* Crypto.Crypto;
  const kid = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  const { publicKeyJwk: rawPublicJwk, privateKeyJwk: rawPrivateJwk } =
    yield* JwtCodec.generateKeyJwks(algorithm, { rsaModulusLength });
  return yield* records.create({
    kid,
    alg: algorithm,
    publicKeyJwk: { ...rawPublicJwk, kid, alg: algorithm },
    privateKeyJwk: Option.some(Redacted.make({ ...rawPrivateJwk, kid, alg: algorithm })),
  });
});

/**
 * Brings the store to "exactly one current key, not due for rotation" and
 * returns that key — the single procedure behind the lazy first mint, the
 * scheduled rotation and `rotateNow`. Every write is safe to race (see the
 * header): on losing, it re-reads and adopts the winner's key; the bounded
 * loop only exists so a pathological store cannot spin forever.
 *
 * `force` rotates even when the key is not due (`rotateNow`); `gracePeriod`
 * is how long a key this call rotates out keeps verifying.
 */
const settleCurrent = Effect.fnUntraced(function* (options: {
  readonly force: boolean;
  readonly gracePeriod: Duration.Duration;
}) {
  const records = yield* SigningKeyRecords.SigningKeyRecords;
  const config = yield* JwtConfig;
  const transaction = yield* SqlTransaction.SqlTransaction;
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = yield* DateTime.now;
    const existing = yield* records.findCurrent();
    if (Option.isSome(existing) && !options.force && !isDue(existing.value, now, config)) {
      return existing.value;
    }
    const minted = yield* Option.match(existing, {
      // First mint: a concurrent minter may win the unique index.
      onNone: () => mint(config.algorithm, config.rsaModulusLength).pipe(Effect.option),
      // Rotation: mark + mint commit together or not at all; losing the
      // compare-and-swap (`false`) or the unique index means someone else
      // already rotated.
      onSome: (current) =>
        transaction
          .withTransaction(
            Effect.gen(function* () {
              const won = yield* records.markRotated(
                current.kid,
                now,
                DateTime.addDuration(now, options.gracePeriod),
              );
              return won
                ? Option.some(yield* mint(config.algorithm, config.rsaModulusLength))
                : Option.none();
            }),
          )
          .pipe(
            Effect.catchTag("CurrentKeyConflict", () => Effect.succeed(Option.none())),
            Effect.orDie,
          ),
    });
    if (Option.isSome(minted)) return minted.value;
    // A `force` rotation that lost the race is satisfied by the winner's
    // fresh key: re-read it without rotating a second time.
    const winner = yield* records.findCurrent();
    if (Option.isSome(winner) && options.force) return winner.value;
  }
  return yield* Defects.invariantViolation(
    "SigningKeyUnsettled",
    "awthaq/jwt: could not settle a single current signing key after 5 attempts",
  );
});

/**
 * .scratch/jwt/issues/15-remote-signing-swap.md: registers a key whose
 * private material lives entirely in a remote KMS/HSM, identified by `kid`
 * alone — `privateKeyJwk` is `None`, matching `SigningKeyRecords.ts`'s own
 * documented meaning for that case. `publicKeyJwk` still comes from the
 * remote signer (the only party that ever held the private half), supplied
 * by the caller rather than derived here. Not invoked by `layerFromStore`'s
 * own lazy-mint path, which always mints locally — a deployment wanting
 * remote signing from the very first key provisions it via this function
 * before `KeyRing` is ever accessed (e.g. at boot), a documented, narrower
 * scope than a fully remote-first lazy-provisioning path would need.
 *
 * JJS-004: the remote key must be the store's single current key, so in one
 * transaction any existing current key is rotated out (its grace period is
 * `keyGracePeriod`) before the remote key is inserted.
 */
export const registerRemoteKey = (input: {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: SigningKeyRecords.Jwk;
}) =>
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    const config = yield* JwtConfig;
    const transaction = yield* SqlTransaction.SqlTransaction;
    return yield* transaction
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const existing = yield* records.findCurrent();
          if (Option.isSome(existing)) {
            yield* records.markRotated(
              existing.value.kid,
              now,
              DateTime.addDuration(now, config.keyGracePeriod),
            );
          }
          return yield* records.create({ ...input, privateKeyJwk: Option.none() });
        }),
      )
      .pipe(Effect.orDie);
  });

/**
 * BAM-010: imports a foreign signing key's *public* half as a verification-only
 * key — e.g. a better-auth or Firebase signing key — so tokens minted before a
 * migration keep verifying (and the key appears in the served JWKS) for
 * `retiresAfter` (default `keyGracePeriod`). It is inserted already rotated, so
 * it never competes with the one current key, and no private material is ever
 * accepted or stored. A running `KeyRing` picks it up within `keyCacheMaxAge`
 * (or at once, when a token names its `kid`).
 */
export const importKey = (input: {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: SigningKeyRecords.Jwk;
  readonly retiresAfter?: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    const config = yield* JwtConfig;
    if (input.publicKeyJwk["kty"] !== JwtCodec.keyTypeFor(input.alg)) {
      return yield* Effect.fail(
        new InvalidKeyImport({
          reason: `${input.alg} requires a JWK with kty ${JwtCodec.keyTypeFor(input.alg)}`,
        }),
      );
    }
    if ("d" in input.publicKeyJwk) {
      return yield* Effect.fail(
        new InvalidKeyImport({ reason: "the JWK carries private key material (d)" }),
      );
    }
    const now = yield* DateTime.now;
    return yield* records
      .create({
        kid: input.kid,
        alg: input.alg,
        publicKeyJwk: { ...input.publicKeyJwk, kid: input.kid, alg: input.alg },
        privateKeyJwk: Option.none(),
        rotated: {
          rotatedAt: now,
          retiresAt: DateTime.addDuration(now, input.retiresAfter ?? config.keyGracePeriod),
        },
      })
      .pipe(Effect.orDie);
  });

const layerFromStore = Layer.effect(
  SigningKeysCache,
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    const config = yield* JwtConfig;
    const current = yield* settleCurrent({ force: false, gracePeriod: config.keyGracePeriod });
    const now = yield* DateTime.now;
    const verifiable = yield* records.listVerifiable(now);
    return {
      current: toSigningKey(current),
      verifiable: verifiable.map(toSigningKey),
      loadedAt: now,
    };
  }),
);

export class KeyRing extends LayerRef.Service<KeyRing>()("awthaq/jwt/KeyRing", {
  layer: layerFromStore,
  idleTimeToLive: "1 hour",
}) {}

/**
 * Refreshes the snapshot when the cached current key is due for rotation, or
 * when the snapshot itself is older than `keyCacheMaxAge` (KRS-006: a busy
 * process never idles out, so rotations made elsewhere would otherwise stay
 * invisible). Cheap when neither applies — one in-memory comparison against
 * the snapshot `ref.get` already has cached; no store access. `ref.refresh`
 * re-runs `layerFromStore`, which performs any rotation for real.
 */
const rotateIfDue = Effect.gen(function* () {
  const ref = yield* KeyRing;
  const config = yield* JwtConfig;
  const cache = yield* Effect.provide(SigningKeysCache, ref.get);
  const now = yield* DateTime.now;
  if (isDue(cache.current, now, config) || isStale(cache.loadedAt, now, config.keyCacheMaxAge)) {
    yield* ref.refresh;
  }
});

/** The key currently used to sign new tokens — lazily minted on first use, auto-rotated when past `keyRotationInterval`, cached in between. */
export const current = Effect.gen(function* () {
  yield* rotateIfDue;
  const ref = yield* KeyRing;
  return yield* Effect.provide(
    Effect.map(SigningKeysCache, (cache) => cache.current),
    ref.get,
  );
});

/** Every not-yet-retired key, for JWKS exposure and signature verification. */
export const verifiable = Effect.gen(function* () {
  yield* rotateIfDue;
  const ref = yield* KeyRing;
  return yield* Effect.provide(
    Effect.map(SigningKeysCache, (cache) => cache.verifiable),
    ref.get,
  );
});

/**
 * KRS-006: re-reads the store unconditionally — what `Jwt.verify` does (rate
 * limited) when a token names a `kid` the snapshot does not have, so keys minted
 * or imported by a peer verify at once instead of after `keyCacheMaxAge`.
 */
export const refresh = Effect.gen(function* () {
  const ref = yield* KeyRing;
  yield* ref.refresh;
});

/**
 * .scratch/jwt/issues/11-key-rotation.md: forces an immediate rotation,
 * independent of `keyRotationInterval`. Reachable from the planned CLI
 * (`spec/roadmap.md` M6), not wired to any HTTP handler, so — unlike
 * `current`/`verifiable` — it's fine for this to carry real service
 * requirements rather than needing `R = never`.
 *
 * `gracePeriod` is how long the key being rotated out keeps verifying and
 * stays in the JWKS (default `JwtConfig.keyGracePeriod`, right for routine
 * rotation). For a suspected compromise pass `Duration.zero` (N12/KRS-008):
 * the old key stops verifying at once instead of for the full grace period.
 * If a concurrent caller already rotated, this adopts their fresh key rather
 * than rotating twice.
 */
export const rotateNow = (options?: { readonly gracePeriod?: Duration.Duration }) =>
  Effect.gen(function* () {
    const config = yield* JwtConfig;
    yield* settleCurrent({
      force: true,
      gracePeriod: options?.gracePeriod ?? config.keyGracePeriod,
    });
    const ref = yield* KeyRing;
    yield* ref.refresh;
  });

/**
 * N12/KRS-008: stops trusting `kid` immediately. A key that is still current
 * is rotated out with no grace period (a replacement is minted); a key that was
 * already rotated out has its remaining grace period cut to now. Resolves
 * `false` when `kid` is unknown or already retired. Tokens signed by `kid`
 * stop verifying once each verifier's JWKS cache (`cacheTtl`) refreshes.
 */
export const revoke = (kid: string) =>
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    const now = yield* DateTime.now;
    const existing = yield* records.findCurrent();
    const changed =
      Option.isSome(existing) && existing.value.kid === kid
        ? yield* rotateNow({ gracePeriod: Duration.zero }).pipe(Effect.as(true))
        : yield* records.retire(kid, now);
    const ref = yield* KeyRing;
    yield* ref.refresh;
    return changed;
  });
