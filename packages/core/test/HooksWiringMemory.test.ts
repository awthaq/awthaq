// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high, wayfinder ticket 03):
// proves `Users.layerMemory`'s own `delete_` genuinely consults
// `Hooks.BeforeUserDelete`. The SQL twin is `HooksWiringSql.test.ts`.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

const TestLayer = Users.layerMemory.pipe(
  Layer.provide(
    Hooks.BeforeUserDelete.tap((input) =>
      input.email === "keep@example.com"
        ? Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }))
        : Effect.succeed(input),
    ).pipe(Layer.provideMerge(Hooks.BeforeUserDelete.layer)),
  ),
  Layer.provide(NodeCrypto.layer),
);

describe("Users.layerMemory delete hook (BEH-EA-095)", () => {
  it.effect("a veto tap can abort a delete outright, surfaced as HookAborted", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* users.create({ email: "keep@example.com", name: "Keep" });

      // JH-001/PERS-001: BEH-EA-090's own MUST — the veto abort reaches
      // the caller as the typed `HookAborted`, naming this point's own id
      // and the tap's own code.
      const aborted = yield* users.delete(created.id).pipe(
        Effect.flip,
        Effect.flatMap((error) =>
          error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
        ),
      );
      assert.strictEqual(aborted.point, "auth.user.beforeDelete");
      assert.strictEqual(aborted.code, "LEGAL_HOLD");

      // The row must still exist — the veto blocked the delete outright.
      const still = yield* users.findById(created.id);
      assert.strictEqual(still.id, created.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});
