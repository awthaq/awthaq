// CSG-001/DRS-002 (.issues/high): `PasskeyCredentials.deleteAllByUser` and
// `Passkey.beforeUserDeleteErasure`'s own tap wiring, mirroring
// `@awthaq/core`'s own `HooksWiringMemory.test.ts`.
import { Hooks, Users } from "@awthaq/core";
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

describe("Passkey.beforeUserDeleteErasure", () => {
  const TestLayer = Users.layerMemory.pipe(
    Layer.provide(Passkey.beforeUserDeleteErasure),
    Layer.provideMerge(PasskeyCredentials.layerMemory),
    Layer.provideMerge(PasskeyUserHandles.layerMemory),
    Layer.provideMerge(Hooks.BeforeUserDelete.layer),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect("Users.delete sweeps every passkey_credential row for that user", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;
      const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
      const user = yield* users.create({ email: "erase@example.com", name: "Erase" });
      yield* credentials.create(credentialInput("cred-erase-1", user.id));
      yield* credentials.create(credentialInput("cred-erase-2", user.id));
      const handleBefore = yield* handles.getOrCreate(user.id);

      yield* users.delete(user.id);

      assert.deepStrictEqual(yield* credentials.listByUser(user.id), []);
      // BPAS-003: the user's stable WebAuthn handle goes with the account — one
      // minted afterwards is a fresh value, the old one is gone.
      assert.notStrictEqual(yield* handles.getOrCreate(user.id), handleBefore);
    }).pipe(Effect.provide(TestLayer)),
  );
});
