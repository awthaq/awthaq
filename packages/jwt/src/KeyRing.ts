// @effect-auth/jwt — KeyRing
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
// Key generation uses the platform WebCrypto (`globalThis.crypto.subtle`),
// the same primitive `@effect-auth/oauth`'s own `Jwt.ts` already uses for
// RS256 verification — this module is the first to also *generate* and
// *export* keys, for EdDSA (Ed25519) and ES256 (ECDSA P-256) per
// `JwtConfig.algorithm`.
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
}

export class SigningKeysCache extends Context.Service<SigningKeysCache, SigningKeysShape>()(
  "effect-auth/jwt/SigningKeysCache",
) {}

const toSigningKey = (record: SigningKeyRecords.SigningKeyRecord): SigningKey => ({
  kid: record.kid,
  alg: record.alg,
  publicKeyJwk: record.publicKeyJwk,
  privateKeyJwk: record.privateKeyJwk,
  createdAt: record.createdAt,
});

const isStale = (
  createdAt: DateTime.Utc,
  now: DateTime.Utc,
  interval: Duration.Duration,
): boolean =>
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(createdAt) >= Duration.toMillis(interval);

class KeyGenerationError extends Data.TaggedError("KeyGenerationError")<{
  readonly cause: unknown;
}> {}

const generateKeyPair = (algorithm: Algorithm) =>
  Effect.tryPromise({
    try: () =>
      algorithm === "EdDSA"
        ? globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
        : globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
            "sign",
            "verify",
          ]),
    catch: (cause) => new KeyGenerationError({ cause }),
  }).pipe(Effect.orDie);

const exportJwk = (key: CryptoKey) =>
  Effect.tryPromise({
    try: () => globalThis.crypto.subtle.exportKey("jwk", key),
    catch: (cause) => new KeyGenerationError({ cause }),
  }).pipe(Effect.orDie);

/** Generates a fresh key pair and persists it — the lazy-mint path `layerFromStore` falls back to when no current key exists, and what a rotation always mints as the stale key's replacement. */
const mint = Effect.fnUntraced(function* (algorithm: Algorithm) {
  const records = yield* SigningKeyRecords.SigningKeyRecords;
  const crypto = yield* Crypto.Crypto;
  const kid = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  const keyPair = yield* generateKeyPair(algorithm);
  const rawPublicJwk = yield* exportJwk(keyPair.publicKey);
  const rawPrivateJwk = yield* exportJwk(keyPair.privateKey);
  return yield* records.create({
    kid,
    alg: algorithm,
    publicKeyJwk: { ...rawPublicJwk, kid, alg: algorithm },
    privateKeyJwk: Option.some(Redacted.make({ ...rawPrivateJwk, kid, alg: algorithm })),
  });
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
 */
export const registerRemoteKey = (input: {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: SigningKeyRecords.Jwk;
}) =>
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    return yield* records.create({ ...input, privateKeyJwk: Option.none() });
  });

/** Marks `record` rotated (stops signing, starts its grace period) — the one place the store's rotation columns are ever written. */
const markRotated = (
  record: SigningKeyRecords.SigningKeyRecord,
  now: DateTime.Utc,
  gracePeriod: Duration.Duration,
) =>
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    yield* records.markRotated(record.kid, now, DateTime.addDuration(now, gracePeriod));
  });

const layerFromStore = Layer.effect(
  SigningKeysCache,
  Effect.gen(function* () {
    const records = yield* SigningKeyRecords.SigningKeyRecords;
    const config = yield* JwtConfig;
    const now = yield* DateTime.now;

    const existing = yield* records.findCurrent();
    const current = yield* Option.isNone(existing)
      ? mint(config.algorithm)
      : isStale(existing.value.createdAt, now, config.keyRotationInterval)
        ? markRotated(existing.value, now, config.keyGracePeriod).pipe(
            Effect.andThen(mint(config.algorithm)),
          )
        : Effect.succeed(existing.value);

    const verifiable = yield* records.listVerifiable(now);

    return {
      current: toSigningKey(current),
      verifiable: verifiable.map(toSigningKey),
    };
  }),
);

export class KeyRing extends LayerRef.Service<KeyRing>()("effect-auth/jwt/KeyRing", {
  layer: layerFromStore,
  idleTimeToLive: "1 hour",
}) {}

/**
 * Rotates immediately if the cached current key is past `keyRotationInterval`
 * — cheap when not due (one in-memory age check against the snapshot
 * `ref.get` already has cached; no store access). `ref.refresh` re-runs
 * `layerFromStore`, which performs the actual rotation mutation.
 */
const rotateIfDue = Effect.gen(function* () {
  const ref = yield* KeyRing;
  const config = yield* JwtConfig;
  const cache = yield* Effect.provide(SigningKeysCache, ref.get);
  const now = yield* DateTime.now;
  if (isStale(cache.current.createdAt, now, config.keyRotationInterval)) {
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
 * .scratch/jwt/issues/11-key-rotation.md: forces an immediate rotation,
 * independent of `keyRotationInterval` — e.g. suspected key compromise.
 * Reachable from the planned CLI (`spec/roadmap.md` M6), not wired to any
 * HTTP handler, so — unlike `current`/`verifiable` — it's fine for this to
 * carry real service requirements rather than needing `R = never`.
 */
export const rotateNow = Effect.gen(function* () {
  const records = yield* SigningKeyRecords.SigningKeyRecords;
  const config = yield* JwtConfig;
  const now = yield* DateTime.now;
  const existing = yield* records.findCurrent();
  if (Option.isSome(existing)) {
    yield* markRotated(existing.value, now, config.keyGracePeriod);
  }
  yield* mint(config.algorithm);
  const ref = yield* KeyRing;
  yield* ref.refresh;
});
