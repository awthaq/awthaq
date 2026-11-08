// ADR-EA-047 (plan 26 ticket 12): `withRequest`/`withoutRequest` remove exactly `Api.AuthRequestContext` from `R`.
// Compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with a token runtime test.
import { Api } from "@awthaq/api";
import { Sessions } from "@awthaq/core";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestAuth from "../src/TestAuth.ts";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RequirementsOf<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const needsBoth = Effect.asVoid(
  Effect.flatMap(Effect.service(Api.AuthRequestContext), () => Effect.service(Sessions.Sessions)),
);

const answered = TestAuth.withRequest({ ip: "203.0.113.1" })(needsBoth);
export const withRequestLeavesTheRest: Equals<
  RequirementsOf<typeof answered>,
  Sessions.Sessions
> = true;
const unanswered = TestAuth.withoutRequest(needsBoth);
export const withoutRequestLeavesTheRest: Equals<
  RequirementsOf<typeof unanswered>,
  Sessions.Sessions
> = true;

it("the guarantees above are checked by the compiler", () => {
  void Api.AuthRequestContext.noRequest;
});
