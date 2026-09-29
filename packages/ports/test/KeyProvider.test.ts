// See src/KeyProvider.ts's own header comment for what this port is
// grounded in — .scratch/shipping-gaps, ticket 17.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as KeyProvider from "../src/KeyProvider.ts";

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

// KRS-002 (wayfinder ticket 22): AWTHAQ_ENCRYPTION_KEYS is a real keyset.
describe("KeyProvider.layerEnv keyset (KRS-002)", () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
  const keysetEnv = (keys: unknown, keyId?: string) =>
    envLayer({
      AWTHAQ_ENCRYPTION_KEYS: JSON.stringify(keys),
      ...(keyId === undefined ? {} : { AWTHAQ_ENCRYPTION_KEY_ID: keyId }),
    });
  const build = (env: Layer.Layer<never>) => KeyProvider.layerEnv.pipe(Layer.provide(env));
  const dieMessage = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";

  it.effect("getKey returns a retired key listed in AWTHAQ_ENCRYPTION_KEYS", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const current = yield* provider.currentKey;
      assert.strictEqual(current.kid, "new");
      const retired = yield* provider.getKey("old");
      assert.strictEqual(retired.kid, "old");
      assert.deepStrictEqual(Redacted.value(retired.key), Buffer.alloc(32, 1));
      const failure = yield* provider.getKey("gone").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UnknownKeyId");
    }).pipe(
      Effect.provide(
        build(
          keysetEnv(
            [
              { kid: "old", key: key(1) },
              { kid: "new", key: key(2) },
            ],
            "new",
          ),
        ),
      ),
    ),
  );

  it.effect("dies when AWTHAQ_ENCRYPTION_KEY_ID is not in the keyset", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(Effect.void, build(keysetEnv([{ kid: "a", key: key(1) }], "b"))),
      );
      assert.include(dieMessage(exit), "AWTHAQ_ENCRYPTION_KEY_ID");
    }),
  );

  it.effect("requires AWTHAQ_ENCRYPTION_KEY_ID once a keyset is supplied", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(Effect.void, build(keysetEnv([{ kid: "a", key: key(1) }]))),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("dies on duplicate kid", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          Effect.void,
          build(
            keysetEnv(
              [
                { kid: "a", key: key(1) },
                { kid: "a", key: key(2) },
              ],
              "a",
            ),
          ),
        ),
      );
      assert.include(dieMessage(exit), "duplicate");
    }),
  );

  it.effect("dies on a 31-byte key", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.provide(
          Effect.void,
          build(keysetEnv([{ kid: "a", key: Buffer.alloc(31).toString("base64") }], "a")),
        ),
      );
      assert.include(dieMessage(exit), "32 bytes");
    }),
  );

  it.effect("dies on an empty keyset and on malformed JSON", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.exit(Effect.provide(Effect.void, build(keysetEnv([], "a"))));
      assert.isTrue(Exit.isFailure(empty));
      const malformed = yield* Effect.exit(
        Effect.provide(
          Effect.void,
          build(envLayer({ AWTHAQ_ENCRYPTION_KEYS: "not json", AWTHAQ_ENCRYPTION_KEY_ID: "a" })),
        ),
      );
      assert.isTrue(Exit.isFailure(malformed));
    }),
  );

  it.effect("the keyset wins over the legacy single-key variable", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const current = yield* provider.currentKey;
      assert.strictEqual(current.kid, "a");
    }).pipe(
      Effect.provide(
        build(
          envLayer({
            AWTHAQ_ENCRYPTION_KEYS: JSON.stringify([{ kid: "a", key: key(1) }]),
            AWTHAQ_ENCRYPTION_KEY_ID: "a",
            AWTHAQ_ENCRYPTION_KEY: key(5),
          }),
        ),
      ),
    ),
  );
});
