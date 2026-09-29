// CSG-001/DRS-002 (.issues/high): `PasskeyCredentials.deleteAllByUser` and
// `Passkey.passkeyErasure` (the plugin's `Erasure` contribution, CSG-001).
import { Erasure, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import * as PasskeyUserHandles from "../src/PasskeyUserHandles.ts";

const credentialInput = (id: string, userId: Users.UserId) => ({
  id,
  userId,
  webauthnUserId: `wau-${id}`,
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  deviceType: "singleDevice" as const,
  backedUp: false,
  transports: ["internal"],
  aaguid: "00000000-0000-0000-0000-000000000000",
  name: "My Passkey",
});

const suiteDeleteAllByUser = (
  name: string,
  layer: Layer.Layer<PasskeyCredentials.PasskeyCredentials, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("removes every credential for the given user, leaving others untouched", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const userA = Users.UserId("user-a");
        const userB = Users.UserId("user-b");
        yield* credentials.create(credentialInput("cred-a1", userA));
        yield* credentials.create(credentialInput("cred-a2", userA));
        yield* credentials.create(credentialInput("cred-b1", userB));

        yield* credentials.deleteAllByUser(userA);

        assert.deepStrictEqual(yield* credentials.listByUser(userA), []);
        const remaining = yield* credentials.listByUser(userB);
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0]?.id, "cred-b1");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suiteDeleteAllByUser(
  "PasskeyCredentials.deleteAllByUser — layerMemory",
  PasskeyCredentials.layerMemory,
);

describe("Passkey erasure contribution", () => {
  const TestLayer = PasskeyCredentials.layerMemory.pipe(
    Layer.provideMerge(PasskeyUserHandles.layerMemory),
    Layer.provideMerge(Erasure.registryLayer),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect(
    "registers itself as `passkey` and sweeps credentials and the WebAuthn user handle",
    () =>
      Effect.gen(function* () {
        const registry = yield* Erasure.ErasureRegistry;
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
        const erased = Users.UserId("user-erase");
        const kept = Users.UserId("user-keep");
        yield* credentials.create(credentialInput("cred-erase-1", erased));
        yield* credentials.create(credentialInput("cred-erase-2", erased));
        yield* credentials.create(credentialInput("cred-keep", kept));
        const handleBefore = yield* handles.getOrCreate(erased);
        const keptHandle = yield* handles.getOrCreate(kept);

        yield* Layer.build(Passkey.passkeyErasure);
        const contributions = yield* registry.contributions;
        assert.deepStrictEqual(
          contributions.map((c) => c.id),
          ["passkey"],
        );
        for (const c of contributions)
          yield* c.erase({ userId: erased, email: "erase@example.com" });

        assert.deepStrictEqual(yield* credentials.listByUser(erased), []);
        assert.strictEqual((yield* credentials.listByUser(kept)).length, 1);
        // BPAS-003: the user's stable WebAuthn handle goes with the account, so one
        // minted afterwards is a fresh value.
        assert.notStrictEqual(yield* handles.getOrCreate(erased), handleBefore);
        assert.strictEqual(yield* handles.getOrCreate(kept), keptHandle);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
