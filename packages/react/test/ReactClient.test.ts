// BE-004 / NF-11-1 / FAMS-008: `makeReactClient` carries the CSRF client
// middleware and the transport options, so built-in and application-built
// clients alike send `x-csrf-token` on guarded mutations. (`AtomHttpApi`
// casts its client-service requirement away, so nothing but a runtime test
// would ever notice the header missing.)
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { afterEach, beforeEach, vi } from "vitest";
import { ReactAuthClient } from "../src/AuthClientAtom.ts";
import { makeReactClient } from "../src/ReactClient.ts";
import { installFetchStub, jsonResponse, restoreFetch } from "./support/stubFetch.ts";

const api = HttpApi.make("app")
  .add(HttpApiGroup.make("g1").add(HttpApiEndpoint.get("e", "/e", { success: Schema.String })))
  .add(HttpApiGroup.make("g2").add(HttpApiEndpoint.get("n", "/n", { success: Schema.Number })));

class AppClient extends makeReactClient<AppClient>()("test/AppClient", {
  api,
  baseUrl: "http://auth.test/api/auth",
}) {}

beforeEach(() => {
  // happy-dom enforces the `__Host-` prefix rules (Secure, https) that
  // `document.cookie = ...` cannot satisfy here, so the getter is stubbed.
  vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-csrf=token-1");
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreFetch();
});

describe("ReactAuthClient", () => {
  it("NF-11-1: a session-guarded mutation sends x-csrf-token from the cookie", async () => {
    const requests = installFetchStub({
      "POST /session/sign-out": () => new Response(null, { status: 204 }),
    });
    const registry = AtomRegistry.make();
    const signOut = ReactAuthClient.mutation("session", "signOut");
    registry.mount(signOut);
    registry.set(signOut, { reactivityKeys: [] });
    await vi.waitFor(() => assert.strictEqual(requests.length, 1));
    assert.strictEqual(requests[0]?.headers.get("x-csrf-token"), "token-1");
  });

  it("BE-004: a client over an arbitrary composed api is typed per group and honors baseUrl", async () => {
    const requests = installFetchStub({
      "GET /api/auth/e": () => jsonResponse("hello"),
    });
    const registry = AtomRegistry.make();
    const query = AppClient.query("g1", "e", {});
    registry.mount(query);
    await vi.waitFor(() => assert.isTrue(AsyncResult.isSuccess(registry.get(query))));
    const result = registry.get(query);
    assert.strictEqual(AsyncResult.isSuccess(result) ? result.value : undefined, "hello");
    assert.strictEqual(requests[0]?.url, "http://auth.test/api/auth/e");
    // Compile-time only: never invoked.
    const typeChecks = () => {
      // @ts-expect-error -- "nope" is not a group of the composed api
      AppClient.query("nope", "e", {});
      // @ts-expect-error -- "n" belongs to g2, not g1
      AppClient.query("g1", "n", {});
    };
    assert.isFunction(typeChecks);
  });
});
