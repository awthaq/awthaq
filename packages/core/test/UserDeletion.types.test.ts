// ADR-EA-031 (rev 1.2), BEH-EA-046 (rev 1.3): a committed user is deleted only by
// `AccountErasure.eraseAccount`. Each `@ts-expect-error` line below must fail to compile; nothing
// executes, the assertions are the directives, checked by `tsc -p tsconfig.test.json`. The file
// imports the modules the barrel re-exports as `Erasure` and `Users` (the lint forbids the barrel itself),
// so it checks the public surface.
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { expectTypeOf } from "vitest";
import * as Erasure from "../src/Erasure.ts";
import type * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

declare const users: Users.UsersShape;
declare const removal: Users.UserRemovalShape;
declare const erasure: Erasure.AccountErasureShape;
declare const id: Users.UserId;

// Never called: the `declare`d values have no runtime existence, only types.
const gates = () => {
  // @ts-expect-error — `Users` has no `delete`: erasure is the only way to remove a user
  void users.delete(id);
  // @ts-expect-error — a user id is not a clearance
  void removal.remove(id);
  // @ts-expect-error — nor is a look-alike object: the clearance's private field makes it nominal
  void removal.remove({ userId: id });
  // @ts-expect-error — the clearance is exported as a type only; there is no value to construct
  void new Erasure.ErasureClearance(id);
  // @ts-expect-error — and no minting function on the public surface
  void Erasure.ErasureClearance.afterVeto(id, Effect.void);
  // @ts-expect-error — the initiator is required: no erasure is silently attributed to the user
  void erasure.eraseAccount(id);
};

describe("user deletion is sealed behind AccountErasure (BEH-EA-046)", () => {
  it("Users has no delete; UserRemoval needs a clearance nobody outside core can make", () => {
    // The assertions are the `@ts-expect-error` lines above.
    void gates;
  });

  it("both Users layers provide Users and UserRemoval and no longer require the delete veto", () => {
    expectTypeOf<Layer.Success<typeof Users.layerMemory>>().toEqualTypeOf<
      Users.Users | Users.UserRemoval
    >();
    expectTypeOf<Layer.Success<typeof Users.layerSql>>().toEqualTypeOf<
      Users.Users | Users.UserRemoval
    >();
    expectTypeOf<Hooks.BeforeUserDelete>().not.toExtend<Layer.Services<typeof Users.layerMemory>>();
    expectTypeOf<Hooks.BeforeUserDelete>().not.toExtend<Layer.Services<typeof Users.layerSql>>();
  });
});
