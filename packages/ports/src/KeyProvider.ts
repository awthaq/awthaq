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
// after `currentKey` has moved on to a newer one. `layerEnv` itself only
// ever knows one key, so `getKey` on any other `kid` fails with
// `UnknownKeyId` — real rotation support (multiple simultaneously live
// keys) is a property of a future multi-key implementation of this
// interface, not of this dev/test layer.
//
// Matches the `PasswordHasher`/`Mailer`/`RateLimiter`/`SqlTransaction`
// port convention: a plugin (ticket 18/19's encryption service) depends
// on this port, never a concrete implementation.

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

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

/**
 * Dev/test seam: one key, read once from the environment at layer
 * construction. `AWTHAQ_ENCRYPTION_KEY` (required, base64-encoded,
 * must decode to exactly 32 bytes for AES-256) and
 * `AWTHAQ_ENCRYPTION_KEY_ID` (optional, defaults to `"env"`) —
 * a missing key surfaces as a `Config.ConfigError`, the same way a
 * missing config value does anywhere else in this codebase
 * (`PasswordHasher.layerArgon2id`/`layerScrypt`); a *present but
 * malformed* key (bad base64, wrong length) dies instead, the same
 * "fail loudly, don't limp along misconfigured" choice `Mailer.layerNoop`
 * makes for a missing `Mailer`.
 */
export const layerEnv: Layer.Layer<KeyProvider, Config.ConfigError> = Layer.effect(
  KeyProvider,
  Effect.gen(function* () {
    const kid = yield* Config.String("AWTHAQ_ENCRYPTION_KEY_ID").pipe(
      Config.withDefault(DEFAULT_KID),
    );
    const encoded = yield* Config.Redacted("AWTHAQ_ENCRYPTION_KEY");
    const decoded = Encoding.decodeBase64(Redacted.value(encoded));
    if (decoded._tag === "Failure") {
      return yield* Effect.die(
        new Error(
          `awthaq: AWTHAQ_ENCRYPTION_KEY must be valid base64 (${decoded.failure.message}).`,
        ),
      );
    }
    if (decoded.success.length !== AES_256_KEY_LENGTH) {
      return yield* Effect.die(
        new Error(
          `awthaq: AWTHAQ_ENCRYPTION_KEY must decode to exactly ${AES_256_KEY_LENGTH} bytes for AES-256, got ${decoded.success.length}.`,
        ),
      );
    }
    const material: KeyMaterial = { kid, key: Redacted.make(decoded.success) };
    const getKey: KeyProviderShape["getKey"] = (requestedKid) =>
      requestedKid === kid
        ? Effect.succeed(material)
        : Effect.fail(new UnknownKeyId({ kid: requestedKid }));
    return KeyProvider.of({ currentKey: Effect.succeed(material), getKey });
  }),
);
