// spec/behaviors/22-client-effect.md, BEH-EA-172.
//
// A type-level check: `AuthClient.ErrorCodes<App>` derives the exact set of
// `_tag` literals a small test contract's own errors and middleware declare
// — no more, no fewer. `Equal`/`Expect` is the standard assertion-free
// type-equality idiom (no `as`/cast anywhere): a mismatch fails `tsc`
// itself, which `pnpm typecheck` already runs, so the single runtime
// assertion below exists only so this file reports as a real test.
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";
import { AuthClient } from "../src/index.ts";

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}
class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}, { httpApiStatus: 403 }) {}
class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {},
  { httpApiStatus: 401 },
) {}

class RequiresAuth extends HttpApiMiddleware.Service<RequiresAuth>()("test/RequiresAuth", {
  error: Unauthenticated,
}) {}

const TestGroup = HttpApiGroup.make("widgets")
  .add(
    HttpApiEndpoint.get("byId", "/widgets/:id", {
      success: Schema.Void,
      error: [NotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/widgets", {
      success: Schema.Void,
      error: [Forbidden],
    }),
  )
  .middleware(RequiresAuth);

const TestApi = HttpApi.make("test").add(TestGroup);

type ActualCodes = AuthClient.ErrorCodes<typeof TestApi>;
type ExpectedCodes = "NotFound" | "Forbidden" | "Unauthenticated";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// A mismatch here is a compile error, caught by `pnpm typecheck`.
type _Check = Expect<Equal<ActualCodes, ExpectedCodes>>;

describe("AuthClient.ErrorCodes (BEH-EA-172)", () => {
  it("derives every declared error tag across a contract's endpoints and middleware", () => {
    // The real assertion is `_Check` above, verified by `tsc`; this exists
    // only so the file reports as a real, passing test.
    const check: _Check = true;
    assert.isTrue(check);
  });
});
