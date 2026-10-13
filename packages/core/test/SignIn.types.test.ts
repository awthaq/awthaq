// ADR-EA-038, BEH-EA-322: a session for a proven credential needs a clearance. Each
// `@ts-expect-error` below must fail to compile; nothing executes, the assertions are the
// directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import type * as Hooks from "../src/Hooks.ts";
import type * as SignIn from "../src/SignIn.ts";
import type * as Users from "../src/Users.ts";

declare const signIn: SignIn.SignInShape;
declare const user: Users.UserRecord;
declare const beforeIssue: Hooks.BeforeSessionIssue["Service"];

// Never called: the `declare`d values have no runtime existence, only types.
const gates = () => {
  // @ts-expect-error - a structurally identical object is not a Clearance: only `clear`/`resume` mint one
  void signIn.issue({
    user,
    strategy: "x",
    amr: [],
    tenantId: Option.none(),
    continuation: Option.none(),
  });
  // @ts-expect-error - the divert context requires `amr`: the very value the session records
  void beforeIssue.run({ userId: "u", strategy: "x" });
};

describe("a session is minted only from a clearance (BEH-EA-322)", () => {
  it("issue refuses a look-alike, and BeforeSessionIssue requires amr", () => {
    // The assertions are the `@ts-expect-error` lines above.
    void gates;
  });
});
