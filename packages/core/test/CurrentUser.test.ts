// spec/behaviors/04-contract-stratum.md, GC-003 (BEH-EA-211 for actingAs).
//
// `CurrentUser.of` is the one re-brand of a verified user principal; `current` is `of` plus the
// non-User defect.
import { Api } from "@awthaq/api";
import { Defects } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as CurrentUser from "../src/CurrentUser.ts";

const user = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "u1" }),
  sessionId: "s1",
});
const impersonated = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "u1" }),
  sessionId: "s1",
  actingAs: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
});

describe("CurrentUser (GC-003)", () => {
  it("of brands userId and sessionId, and has no actingAs for a plain session", () => {
    const caller = CurrentUser.of(user);
    assert.strictEqual(caller.userId, "u1");
    assert.strictEqual(caller.sessionId, "s1");
    assert.isTrue(Option.isNone(caller.actingAs));
  });

  it("of carries actingAs as Some({ type, id })", () => {
    assert.deepStrictEqual(
      CurrentUser.of(impersonated).actingAs,
      Option.some({ type: "user", id: "admin-1" }),
    );
  });

  it.effect("current yields exactly of(principal): a Caller and no wire principal", () =>
    Effect.gen(function* () {
      const caller = yield* CurrentUser.current.pipe(
        Effect.provideService(Api.CurrentPrincipal, impersonated),
      );
      assert.deepStrictEqual(caller, CurrentUser.of(impersonated));
      assert.deepStrictEqual(Object.keys(caller).sort(), ["actingAs", "sessionId", "userId"]);
    }),
  );

  it.effect(
    "a non-User principal reaching a required-auth group dies with Defects/InvariantViolation",
    () =>
      Effect.gen(function* () {
        const exit = yield* CurrentUser.current.pipe(
          Effect.provideService(
            Api.CurrentPrincipal,
            new Api.ApiKeyPrincipal({
              ref: new Api.PrincipalRef({ type: "apikey", id: "k1" }),
              scopes: [],
            }),
          ),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.isTrue(Cause.hasDies(exit.cause));
        const defect = Cause.squash(exit.cause);
        assert.instanceOf(defect, Defects.InvariantViolation);
        if (defect instanceof Defects.InvariantViolation) {
          assert.strictEqual(defect.invariant, "NonUserPrincipal");
        }
      }),
  );
});
