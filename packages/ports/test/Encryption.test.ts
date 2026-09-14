// See src/Encryption.ts's own header comment for what this port is
// grounded in — .scratch/shipping-gaps, ticket 18.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Encryption from "../src/Encryption.ts";
import * as KeyProvider from "../src/KeyProvider.ts";

const VALID_KEY_B64 = Buffer.alloc(32).toString("base64");

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
      assert.strictEqual(Redacted.value(decrypted), Redacted.value(plaintext));
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
      const decoded = JSON.parse(Buffer.from(envelope, "base64url").toString("utf8"));
      const tampered = Buffer.from(
        JSON.stringify({
          ...decoded,
          ciphertext: Buffer.from("not-the-real-ciphertext").toString("base64"),
        }),
        "utf8",
      ).toString("base64url");
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
      const decoded = JSON.parse(Buffer.from(envelope, "base64url").toString("utf8"));
      const rekeyed = Buffer.from(
        JSON.stringify({ ...decoded, kid: "not-a-real-kid" }),
        "utf8",
      ).toString("base64url");
      const failure = yield* encryption.decrypt(rekeyed, "aad").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UnknownKeyId");
    }).pipe(Effect.provide(TestLive)),
  );
});
