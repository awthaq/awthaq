// AAPS-005: `Users.updateProfile`/`Users.verifyEmail` fire
// `Hooks.AfterUserAttributesChanged` — but only when a policy-readable
// attribute really changed, so `@awthaq/qadi`'s `DecisionCacheInvalidationLive`
// can flush an application-scoped decision cache exactly when `UserAttributes`
// could answer differently. A dedicated file (the SQL twin is
// `UserAttributesHookSql.test.ts`): a `HookPoint`'s tap registry is a
// module-level singleton that freezes at its first `run()` (BEH-EA-024), so
// each backend gets its own module.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

const seen: Array<{ readonly userId: string; readonly attributes: ReadonlyArray<string> }> = [];

const TestLayer = Users.layerMemory.pipe(
  Layer.provide(Hooks.HooksLive),
  Layer.provide(
    Hooks.AfterUserAttributesChanged.tap((input) =>
      Effect.sync(() => {
        seen.push(input);
      }),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

describe("Users.layerMemory attribute-change hook (AAPS-005)", () => {
  it.effect("updateProfile announces name; verifyEmail announces emailVerified once", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({ email: "hook@example.com", name: "Hook" });
      assert.deepStrictEqual(seen, []);

      yield* users.updateProfile(user.id, { name: "Renamed" });
      assert.deepStrictEqual(seen, [{ userId: user.id, attributes: ["name"] }]);

      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(seen[1], { userId: user.id, attributes: ["emailVerified"] });

      // Already verified: nothing changed, nothing announced.
      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
    }).pipe(Effect.provide(TestLayer)),
  );
});
