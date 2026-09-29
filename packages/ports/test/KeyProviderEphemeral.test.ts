// IC-010: a dev-only keyset generated at layer build. It must never be a silent fallback: it is
// opt-in by naming the layer, it warns loudly, and a production process refuses it unless the
// operator says so explicitly.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as KeyProvider from "../src/KeyProvider.ts";

const warnings = (sink: Array<string>) =>
  Logger.layer([
    Logger.make((options) => {
      if (options.logLevel === "Warn") sink.push(String(options.message));
    }),
  ]);

const ephemeral = (env: Record<string, string>, sink: Array<string> = []) =>
  KeyProvider.layerEphemeral.pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(warnings(sink)),
  );

const currentKey = Effect.gen(function* () {
  const provider = yield* KeyProvider.KeyProvider;
  return yield* provider.currentKey;
});

describe("KeyProvider.layerEphemeral (IC-010)", () => {
  it.effect(
    "yields a usable 32-byte key with no environment at all, and a fresh one per build",
    () =>
      Effect.gen(function* () {
        const first = yield* currentKey.pipe(Effect.provide(ephemeral({})));
        const second = yield* currentKey.pipe(Effect.provide(ephemeral({})));
        assert.strictEqual(Redacted.value(first.key).length, 32);
        assert.notDeepEqual(Redacted.value(first.key), Redacted.value(second.key));
      }),
  );

  it.effect("getKey resolves the current kid and refuses any other", () =>
    Effect.gen(function* () {
      const provider = yield* KeyProvider.KeyProvider;
      const current = yield* provider.currentKey;
      const fetched = yield* provider.getKey(current.kid);
      assert.deepStrictEqual(Redacted.value(fetched.key), Redacted.value(current.key));
      const failure = yield* provider.getKey("other").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UnknownKeyId");
    }).pipe(Effect.provide(ephemeral({}))),
  );

  it.effect("logs a warning that ciphertext will not survive a restart", () =>
    Effect.gen(function* () {
      const sink: Array<string> = [];
      yield* Effect.void.pipe(Effect.provide(ephemeral({}, sink)));
      assert.isTrue(sink.some((m) => m.includes("ephemeral") && m.includes("restart")));
    }),
  );

  it.effect("dies under NODE_ENV=production unless AWTHAQ_ALLOW_EPHEMERAL_KEY=true", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.exit(
        Effect.void.pipe(Effect.provide(ephemeral({ NODE_ENV: "production" }))),
      );
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) {
        assert.include(String(Cause.squash(refused.cause)), "AWTHAQ_ALLOW_EPHEMERAL_KEY");
      }
      const allowed = yield* Effect.exit(
        Effect.void.pipe(
          Effect.provide(ephemeral({ NODE_ENV: "production", AWTHAQ_ALLOW_EPHEMERAL_KEY: "true" })),
        ),
      );
      assert.isTrue(Exit.isSuccess(allowed));
    }),
  );
});
