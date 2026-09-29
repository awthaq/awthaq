// See src/Encryption.ts's own header comment for what this port is
// grounded in — .scratch/shipping-gaps, ticket 18.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { vi } from "vitest";
import * as Encryption from "../src/Encryption.ts";
import * as KeyProvider from "../src/KeyProvider.ts";

const VALID_KEY_B64 = Buffer.alloc(32).toString("base64");

const keyB64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");

const keysetLayer = (keys: ReadonlyArray<{ kid: string; key: string }>, current: string) =>
  Encryption.layer.pipe(
    Layer.provide(
      KeyProvider.layerEnv.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                AWTHAQ_ENCRYPTION_KEYS: JSON.stringify(keys),
                AWTHAQ_ENCRYPTION_KEY_ID: current,
              },
            }),
          ),
        ),
      ),
    ),
    Layer.provide(NodeCrypto.layer),
  );

// Rewrites fields of a serialized envelope (v/kid/ciphertext...) — the attack
// surface the AAD binding has to cover.
const editEnvelope = (envelope: string, patch: Record<string, unknown>) =>
  Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")),
      ...patch,
    }),
    "utf8",
  ).toString("base64url");

const TestLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { AWTHAQ_ENCRYPTION_KEY: VALID_KEY_B64 } }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

describe("Encryption.layer (ticket 18)", () => {
  it.effect("round-trips: decrypting what was encrypted returns the original plaintext", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const plaintext = Redacted.make("super-secret-oauth-token");
      const envelope = yield* encryption.encrypt(plaintext, "provider:user");
      const decrypted = yield* encryption.decrypt(envelope, "provider:user");
      assert.strictEqual(Redacted.value(decrypted.plaintext), Redacted.value(plaintext));
    }).pipe(Effect.provide(TestLive)),
  );

  it.effect("the envelope never contains the plaintext as a literal substring", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(
        Redacted.make("super-secret-oauth-token"),
        "provider:user",
      );
      assert.isFalse(envelope.includes("super-secret-oauth-token"));
    }).pipe(Effect.provide(TestLive)),
  );

  it.effect("decrypting with a different AAD than was used to encrypt fails", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("token"), "provider:alice");
      const failure = yield* encryption.decrypt(envelope, "provider:bob").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DecryptionFailed");
    }).pipe(Effect.provide(TestLive)),
  );

  it.effect("decrypting tampered ciphertext fails rather than returning garbage", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("token"), "aad");
      const tampered = editEnvelope(envelope, {
        ciphertext: Buffer.from("not-the-real-ciphertext").toString("base64"),
      });
      const failure = yield* encryption.decrypt(tampered, "aad").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DecryptionFailed");
    }).pipe(Effect.provide(TestLive)),
  );

  it.effect("decrypting a malformed envelope fails with DecryptionFailed", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const failure = yield* encryption.decrypt("not-a-real-envelope", "aad").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DecryptionFailed");
    }).pipe(Effect.provide(TestLive)),
  );

  it.effect("decrypting an envelope carrying an unknown kid fails with UnknownKeyId", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("token"), "aad");
      const rekeyed = editEnvelope(envelope, { kid: "not-a-real-kid" });
      const failure = yield* encryption.decrypt(rekeyed, "aad").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UnknownKeyId");
    }).pipe(Effect.provide(TestLive)),
  );
});

// KRS-002 — multi-key keyset and staleKid signal.
describe("Encryption.layer key rotation (KRS-002)", () => {
  const twoKeys = [
    { kid: "k1", key: keyB64(1) },
    { kid: "k2", key: keyB64(2) },
  ];

  it.effect(
    "decrypt of an envelope written under a retired key reports staleKid Some(oldKid)",
    () =>
      Effect.gen(function* () {
        const written = yield* Effect.gen(function* () {
          const encryption = yield* Encryption.Encryption;
          return yield* encryption.encrypt(Redacted.make("tok"), "aad");
        }).pipe(Effect.provide(keysetLayer(twoKeys, "k1")));
        const read = yield* Effect.gen(function* () {
          const encryption = yield* Encryption.Encryption;
          return yield* encryption.decrypt(written, "aad");
        }).pipe(Effect.provide(keysetLayer(twoKeys, "k2")));
        assert.strictEqual(Redacted.value(read.plaintext), "tok");
        assert.deepStrictEqual(read.staleKid, Option.some("k1"));
      }),
  );

  it.effect("a current-key envelope reports staleKid None", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("tok"), "aad");
      const read = yield* encryption.decrypt(envelope, "aad");
      assert.isTrue(Option.isNone(read.staleKid));
    }).pipe(Effect.provide(keysetLayer(twoKeys, "k2"))),
  );

  it.effect("re-encrypting a stale read under the new current key clears the stale signal", () =>
    Effect.gen(function* () {
      const written = yield* Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        return yield* encryption.encrypt(Redacted.make("tok"), "aad");
      }).pipe(Effect.provide(keysetLayer(twoKeys, "k1")));
      yield* Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        const stale = yield* encryption.decrypt(written, "aad");
        const rewritten = yield* encryption.encrypt(stale.plaintext, "aad");
        const again = yield* encryption.decrypt(rewritten, "aad");
        assert.isTrue(Option.isNone(again.staleKid));
      }).pipe(Effect.provide(keysetLayer(twoKeys, "k2")));
    }),
  );
});

// ACS-008 — version and kid are bound into the GCM additional data.
describe("Encryption.layer envelope v2 (ACS-008)", () => {
  // Two kids sharing the SAME key bytes: only the AAD binding can tell them apart.
  const sameBytes = [
    { kid: "a", key: keyB64(9) },
    { kid: "b", key: keyB64(9) },
  ];

  it.effect(
    "a v2 envelope whose kid is rewritten to another known kid fails DecryptionFailed",
    () =>
      Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        const envelope = yield* encryption.encrypt(Redacted.make("tok"), "aad");
        const failure = yield* encryption
          .decrypt(editEnvelope(envelope, { kid: "b" }), "aad")
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "DecryptionFailed");
      }).pipe(Effect.provide(keysetLayer(sameBytes, "a"))),
  );

  it.effect("a v2 envelope downgraded to v1 fails DecryptionFailed", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("tok"), "aad");
      const failure = yield* encryption
        .decrypt(editEnvelope(envelope, { v: 1 }), "aad")
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DecryptionFailed");
    }).pipe(Effect.provide(keysetLayer(sameBytes, "a"))),
  );

  it.effect("new envelopes are v2", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const envelope = yield* encryption.encrypt(Redacted.make("tok"), "aad");
      assert.strictEqual(JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")).v, 2);
    }).pipe(Effect.provide(keysetLayer(sameBytes, "a"))),
  );

  it.effect("a v1 envelope still decrypts and reports stale", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      // Hand-built legacy envelope: the GCM additional data is the caller's string verbatim.
      const iv = Buffer.alloc(12, 3);
      const key = yield* Effect.promise(() =>
        globalThis.crypto.subtle.importKey("raw", Buffer.alloc(32, 9), "AES-GCM", false, [
          "encrypt",
        ]),
      );
      const ciphertext = yield* Effect.promise(() =>
        globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("aad") },
          key,
          new TextEncoder().encode("legacy-token"),
        ),
      );
      const v1 = Buffer.from(
        JSON.stringify({
          v: 1,
          kid: "a",
          iv: iv.toString("base64"),
          ciphertext: Buffer.from(ciphertext).toString("base64"),
        }),
        "utf8",
      ).toString("base64url");
      const read = yield* encryption.decrypt(v1, "aad");
      assert.strictEqual(Redacted.value(read.plaintext), "legacy-token");
      assert.deepStrictEqual(read.staleKid, Option.some("a"));
    }).pipe(Effect.provide(keysetLayer(sameBytes, "a"))),
  );
});

// SMS-005 — raw key bytes are unwrapped once per kid, not per call.
describe("Encryption.layer key hygiene (SMS-005)", () => {
  it.effect("imports each (kid, usage) once across 10 encrypt+decrypt round trips", () =>
    Effect.gen(function* () {
      const encryption = yield* Encryption.Encryption;
      const spy = vi.spyOn(globalThis.crypto.subtle, "importKey");
      try {
        for (let i = 0; i < 10; i++) {
          const envelope = yield* encryption.encrypt(Redacted.make(`tok-${i}`), "aad");
          yield* encryption.decrypt(envelope, "aad");
        }
        // one encrypt import + one decrypt import for the single kid
        assert.strictEqual(spy.mock.calls.length, 2);
      } finally {
        spy.mockRestore();
      }
    }).pipe(Effect.provide(keysetLayer([{ kid: "k1", key: keyB64(1) }], "k1"))),
  );
});
