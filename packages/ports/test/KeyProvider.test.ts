// See src/KeyProvider.ts's own header comment for what this port is
// grounded in — .scratch/shipping-gaps, ticket 17.
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { KeyProvider } from "../src/index.ts";

// 32 zero bytes, base64-encoded — a valid AES-256 key length for these
// contract tests; the actual bytes carry no meaning here.
const VALID_KEY_B64 = Buffer.alloc(32).toString("base64");

const envLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

describe("KeyProvider.layerEnv (ticket 17)", () => {
  it.effect("currentKey returns key material under the configured kid", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const material = yield* provider.currentKey;
      assert.strictEqual(material.kid, "env");
      assert.strictEqual(Redacted.value(material.key).length, 32);
    }).pipe(
      Effect.provide(
        KeyProvider.layerEnv.pipe(
          Layer.provide(envLayer({ AWTHAQ_ENCRYPTION_KEY: VALID_KEY_B64 })),
        ),
      ),
    ),
  );

  it.effect("getKey by the current kid succeeds with the same material", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const current = yield* provider.currentKey;
      const fetched = yield* provider.getKey(current.kid);
      assert.strictEqual(fetched.kid, current.kid);
      assert.deepStrictEqual(Redacted.value(fetched.key), Redacted.value(current.key));
    }).pipe(
      Effect.provide(
        KeyProvider.layerEnv.pipe(
          Layer.provide(
            envLayer({
              AWTHAQ_ENCRYPTION_KEY: VALID_KEY_B64,
              AWTHAQ_ENCRYPTION_KEY_ID: "test-kid-1",
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("getKey by an unknown kid fails with UnknownKeyId", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const failure = yield* provider.getKey("not-a-real-kid").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UnknownKeyId");
      assert.strictEqual(failure.kid, "not-a-real-kid");
    }).pipe(
      Effect.provide(
        KeyProvider.layerEnv.pipe(
          Layer.provide(envLayer({ AWTHAQ_ENCRYPTION_KEY: VALID_KEY_B64 })),
        ),
      ),
    ),
  );

  it.effect("a missing AWTHAQ_ENCRYPTION_KEY surfaces as a ConfigError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(Effect.void, KeyProvider.layerEnv.pipe(Layer.provide(envLayer({})))),
      );
      assert.isTrue(exit._tag === "Failure");
    }),
  );
});
