// CSG-001/DRS-002 (.issues/high): `MembershipRecords.deleteAllByUser` and
// `Organization.beforeUserDeleteErasure`'s own tap wiring. A dedicated
// file — `Hooks.BeforeUserDelete`'s tap registry is a module-level
// singleton that freezes after its own first `run()` (BEH-EA-024), so
// this suite's own `Users.delete` call must be the only one to ever touch
// it in this module load, mirroring `@awthaq/core`'s own
// `HooksWiringMemory.test.ts`.
import { Hooks, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MembershipRecords from "../src/MembershipRecords.ts";
import * as Organization from "../src/Organization.ts";

const MemoryLayer = MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

describe("MembershipRecords.deleteAllByUser", () => {
  it.effect("removes every membership row for the given user, leaving others untouched", () =>
    Effect.gen(function* () {
      const members = yield* MembershipRecords.MembershipRecords;
      const userA = Users.UserId("user-a");
      const userB = Users.UserId("user-b");
      yield* members.create({ userId: userA, organizationId: "org-1", role: ["owner"] });
      yield* members.create({ userId: userA, organizationId: "org-2", role: ["member"] });
      yield* members.create({ userId: userB, organizationId: "org-1", role: ["member"] });

      yield* members.deleteAllByUser(userA);

      assert.deepStrictEqual(yield* members.listByUser(userA), []);
      const remaining = yield* members.listByUser(userB);
      assert.strictEqual(remaining.length, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );
});

describe("Organization.beforeUserDeleteErasure", () => {
  const TestLayer = Users.layerMemory.pipe(
    Layer.provide(Hooks.BeforeUserDelete.layer),
    Layer.provide(Organization.beforeUserDeleteErasure),
    Layer.provideMerge(MembershipRecords.layerMemory),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect("Users.delete sweeps every organization_membership row for that user", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const members = yield* MembershipRecords.MembershipRecords;
      const user = yield* users.create({ email: "erase@example.com", name: "Erase" });
      yield* members.create({ userId: user.id, organizationId: "org-1", role: ["owner"] });
      yield* members.create({ userId: user.id, organizationId: "org-2", role: ["member"] });

      yield* users.delete(user.id);

      assert.deepStrictEqual(yield* members.listByUser(user.id), []);
    }).pipe(Effect.provide(TestLayer)),
  );
});
