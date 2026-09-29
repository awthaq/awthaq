// @awthaq/ports — KeyProvider
//
// Shipping-gap map (.scratch/shipping-gaps), ticket 17 — the seam ticket
// 18 (provider-token encryption at rest) and ticket 19 (PKCE
// verifier/nonce encryption) both build on. spec.md's workstream 4:
// "Key retrieval sits behind a new, swappable key-provider seam — a
// provider-agnostic interface with a concrete env-key-backed
// implementation satisfying it for dev/test, so nothing here is blocked
// on an actual cloud KMS account existing, while the seam itself is real
// and KMS-shaped from the start." — a real KMS's own `KeyProvider`
// implementation (fetching key material by `kid` from a remote service,
// possibly caching it) satisfies exactly this same interface; nothing
// about `currentKey`/`getKey`'s shape needs to change when that
// implementation replaces `layerEnv`.
//
// Keyed by a rotatable `kid` (spec.md: "Encrypted values carry a key id
// so a future key rotation doesn't require synchronously re-encrypting
// every existing row") — a ciphertext's own `kid` says which key
// unlocks it, so an old row stays decryptable under a retired key even
// after `currentKey` has moved on to a newer one. `layerEnv` (KRS-002,
// wayfinder ticket 22) holds a whole keyset: `currentKey` is the one
// named by `AWTHAQ_ENCRYPTION_KEY_ID`, `getKey` looks up any kid in the
// set, so rotating the current kid never orphans existing ciphertext.
// A retired key is *retired, not expired*: it must stay in the keyset
// until nothing written under it remains (`Encryption.decrypt`'s
// `staleKid` drives lazy re-encryption). That is deliberately different
// from a JWT signing-key grace window, which is sized to token TTL —
// see spec/decisions/ADR-EA-017 for that model.
//
// Key material hygiene (SMS-005): `Redacted` only keeps key bytes out of
// logs and `toString`; a JS runtime cannot guarantee zeroization, so the
// bytes live in process memory for the life of the layer. `layerEnv` is
// therefore the dev/test/small-deployment seam. Production deployments
// that must not hold raw key bytes in-process should implement this port
// over a KMS/HSM so the bytes never enter the process.
//
// Matches the `PasswordHasher`/`Mailer`/`RateLimiter`/`SqlTransaction`
// port convention: a plugin (ticket 18/19's encryption service) depends
// on this port, never a concrete implementation.

import * as Defects from "./Defects.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const DEFAULT_KID = "env";
const AES_256_KEY_LENGTH = 32;

export interface KeyMaterial {
  readonly kid: string;
  readonly key: Redacted.Redacted<Uint8Array>;
}

/** Retrieval by an unrecognized `kid` — e.g. a ciphertext written under a key this provider no longer (or not yet) knows about. */
export class UnknownKeyId extends Data.TaggedError("UnknownKeyId")<{
  readonly kid: string;
}> {}

export interface KeyProviderShape {
  /** The key new ciphertext should be written under. */
  readonly currentKey: Effect.Effect<KeyMaterial>;
  /** The key a specific existing ciphertext was written under — its own recorded `kid`, not necessarily `currentKey`'s. */
  readonly getKey: (kid: string) => Effect.Effect<KeyMaterial, UnknownKeyId>;
}

export class KeyProvider extends Context.Service<KeyProvider, KeyProviderShape>()(
  "awthaq/ports/KeyProvider",
) {}

const KeysetJson = Schema.fromJsonString(
  Schema.NonEmptyArray(Schema.Struct({ kid: Schema.NonEmptyString, key: Schema.String })),
);

const decodeKey = (label: string, encoded: string) =>
  Effect.gen(function* () {
    const decoded = Encoding.decodeBase64(encoded);
    if (decoded._tag === "Failure") {
      return yield* Defects.invalidConfiguration("AWTHAQ_ENCRYPTION_KEYS", `awthaq: ${label} must be valid base64 (${decoded.failure.message}).`);
    }
    if (decoded.success.length !== AES_256_KEY_LENGTH) {
      // Zero the (too short/long) decoded copy before dying (SMS-005).
      const length = decoded.success.length;
      decoded.success.fill(0);
      return yield* Defects.invalidConfiguration("AWTHAQ_ENCRYPTION_KEYS", `awthaq: ${label} must decode to exactly ${AES_256_KEY_LENGTH} bytes for AES-256, got ${length}.`);
    }
    return decoded.success;
  });

/**
 * Dev/test seam: a keyset read once from the environment at layer
 * construction.
 *
 * - `AWTHAQ_ENCRYPTION_KEYS` — a JSON array of
 *   `{ "kid": string, "key": "<base64, exactly 32 bytes>" }`, at least one
 *   entry, no duplicate `kid`s. Single-key deployments supply a one-entry
 *   array, e.g. `[{"kid":"env","key":"<the old base64 key>"}]`.
 * - `AWTHAQ_ENCRYPTION_KEY_ID` — the `kid` of the entry that is
 *   `currentKey`. Required with a keyset, and must name an entry in it.
 *
 * The pre-KRS-002 single-key form (`AWTHAQ_ENCRYPTION_KEY`, optional
 * `AWTHAQ_ENCRYPTION_KEY_ID` defaulting to `"env"`) is still accepted, but
 * only when `AWTHAQ_ENCRYPTION_KEYS` is unset; it is a one-entry keyset and
 * cannot rotate.
 *
 * A missing value surfaces as a `Config.ConfigError`, the same way a
 * missing config value does anywhere else in this codebase
 * (`PasswordHasher.layerArgon2id`/`layerScrypt`); a *present but
 * malformed* keyset (bad JSON, bad base64, wrong length, duplicate kid,
 * current kid not in the set) dies instead, the same "fail loudly, don't
 * limp along misconfigured" choice `Mailer.layerNoop` makes for a missing
 * `Mailer`.
 */
export const layerEnv: Layer.Layer<KeyProvider, Config.ConfigError> = Layer.effect(
  KeyProvider,
  Effect.gen(function* () {
    const keyset = yield* Config.option(Config.Redacted("AWTHAQ_ENCRYPTION_KEYS"));
    const { entries, currentKid } = yield* Option.match(keyset, {
      onSome: (json) =>
        Effect.gen(function* () {
          const parsed = yield* Schema.decodeUnknownEffect(KeysetJson)(Redacted.value(json)).pipe(
            Effect.mapError(
              (error) =>
                new Error(
                  `awthaq: AWTHAQ_ENCRYPTION_KEYS must be a non-empty JSON array of { kid, key } (${error.message}).`,
                ),
            ),
            Effect.orDie,
          );
          const kids = new Set<string>();
          for (const { kid } of parsed) {
            if (kids.has(kid)) {
              return yield* Defects.invalidConfiguration("AWTHAQ_ENCRYPTION_KEYS", `awthaq: AWTHAQ_ENCRYPTION_KEYS has a duplicate kid "${kid}".`);
            }
            kids.add(kid);
          }
          const entries = yield* Effect.forEach(parsed, ({ kid, key }) =>
            decodeKey(`AWTHAQ_ENCRYPTION_KEYS["${kid}"]`, key).pipe(
              Effect.map((bytes): KeyMaterial => ({ kid, key: Redacted.make(bytes) })),
            ),
          );
          // With a keyset the current kid must be named explicitly: silently
          // picking one on misconfiguration is exactly the limp-along
          // behaviour this module rejects.
          const currentKid = yield* Config.String("AWTHAQ_ENCRYPTION_KEY_ID");
          return { entries, currentKid };
        }),
      onNone: () =>
        Effect.gen(function* () {
          const kid = yield* Config.String("AWTHAQ_ENCRYPTION_KEY_ID").pipe(
            Config.withDefault(DEFAULT_KID),
          );
          const encoded = yield* Config.Redacted("AWTHAQ_ENCRYPTION_KEY");
          const bytes = yield* decodeKey("AWTHAQ_ENCRYPTION_KEY", Redacted.value(encoded));
          const entries = [{ kid, key: Redacted.make(bytes) }];
          return { entries, currentKid: kid };
        }),
    });
    const byKid = new Map(entries.map((material) => [material.kid, material]));
    const current = byKid.get(currentKid);
    if (current === undefined) {
      return yield* Defects.invalidConfiguration("AWTHAQ_ENCRYPTION_KEY_ID", `awthaq: AWTHAQ_ENCRYPTION_KEY_ID "${currentKid}" does not name a kid in AWTHAQ_ENCRYPTION_KEYS.`);
    }
    const getKey: KeyProviderShape["getKey"] = (requestedKid) => {
      const material = byKid.get(requestedKid);
      return material === undefined
        ? Effect.fail(new UnknownKeyId({ kid: requestedKid }))
        : Effect.succeed(material);
    };
    return KeyProvider.of({ currentKey: Effect.succeed(current), getKey });
  }),
);
