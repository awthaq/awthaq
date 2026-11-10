// Plan 13: the action/predicate pairing and the clearances are compile-time facts. Each
// `@ts-expect-error` below must fail to compile; nothing executes, the assertions are the
// directives, checked by `tsc -p tsconfig.test.json`.
import { type CurrentUser, Users } from "@awthaq/core";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Admin from "../src/Admin.ts";
import type * as AdminGate from "../src/internal/AdminGate.ts";

declare const gate: AdminGate.AdminGate;
declare const caller: CurrentUser.Caller;
declare const built: Admin.AdminConfigShape;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when `T` is `true`. */
type AssertTrue<T extends true> = T;

// The derived predicate unions are exactly these.
type Check1 = AssertTrue<
  Equal<
    AdminGate.UserGate,
    "canManageUsers" | "canBanUsers" | "canDeleteUsers" | "canManageCredentials"
  >
>;
type Check2 = AssertTrue<Equal<AdminGate.TenantGate, "canAdministerTenants">>;
type Check3 = AssertTrue<
  Equal<AdminGate.CollectionAction, "effectiveConfig" | "listUsers" | "listOrganizations">
>;

// Never called: the `declare`d values have no runtime existence, only types.
const gates = () => {
  const checks: [Check1, Check2, Check3] = [true, true, true];
  void checks;
  // @ts-expect-error - a collection action takes no target
  void gate.user(caller, "listUsers", Users.UserId("u"));
  // @ts-expect-error - a per-user action is not a collection call
  void gate.collection(caller, "deleteUser");
  // @ts-expect-error - an organization action is not a user action
  void gate.user(caller, "suspendOrganization", Users.UserId("u"));
  // @ts-expect-error - a structurally identical object is not a clearance: only the gate mints one
  const forged: AdminGate.UserClearance = {
    adminUserId: Users.UserId("a"),
    config: built,
    userId: Users.UserId("u"),
    target: Effect.die("x"),
  };
  void forged;
};

describe("AdminGate types", () => {
  it("compiles", () => {
    void gates;
  });
});
