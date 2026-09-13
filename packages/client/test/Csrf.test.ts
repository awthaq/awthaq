// spec/behaviors/22-client-effect.md, BEH-EA-170.
// spec/invariants.md, INV-EA-011.
//
// A type-level check, real against `Api.CsrfProtection` itself (declared in
// `@effect-auth/api`) even though no real plugin group in this repository
// attaches it to an endpoint yet (see `AuthClient.ts`'s own header comment)
// — this small synthetic group is enough to prove the property BEH-EA-170
// actually requires: a client built over a `CsrfProtection`-middlewared
// group carries `HttpApiMiddleware.ForClient<Api.CsrfProtection>` in its own
// requirement type, and providing `CsrfClientLive` is what discharges it.
// Originally planned as `Csrf.test-d.ts`; this repository's tooling runs
// `test/**/*.test.ts` only, so the check lives here as an ordinary test
// whose real assertion is the two type aliases below, not the trivial
// runtime one.
import { Api } from "@effect-auth/api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";
import { AuthClient } from "../src/index.ts";

const TestApi = HttpApi.make("test").add(
  HttpApiGroup.make("g").add(HttpApiEndpoint.get("x", "/x")).middleware(Api.CsrfProtection),
);

const clientEffect = AuthClient.make(TestApi, { baseUrl: "http://localhost" });
const withCsrf = clientEffect.pipe(Effect.provide(AuthClient.CsrfClientLive));

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type CsrfMarker = HttpApiMiddleware.ForClient<Api.CsrfProtection>;

// BEH-EA-170: the client's own requirement really does carry the marker
// `Api.CsrfProtection`'s `requiredForClient: true` puts there.
type _RequiresCsrf = Expect<
  Equal<Extract<Effect.Services<typeof clientEffect>, CsrfMarker>, CsrfMarker>
>;

// Providing `CsrfClientLive` discharges exactly that requirement.
type _CsrfDischarged = Expect<Equal<Extract<Effect.Services<typeof withCsrf>, CsrfMarker>, never>>;

describe("CsrfClientLive (BEH-EA-170/INV-EA-011)", () => {
  it("a CsrfProtection-middlewared client requires the marker until CsrfClientLive is provided", () => {
    const requiresCsrf: _RequiresCsrf = true;
    const csrfDischarged: _CsrfDischarged = true;
    assert.isTrue(requiresCsrf);
    assert.isTrue(csrfDischarged);
  });
});
