// AVS-004: composition refuses two plugins claiming the same (method, path),
// in different groups, instead of letting the router shadow one silently.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";

const FirstApi = HttpApi.make("auth").add(
  HttpApiGroup.make("first").add(
    HttpApiEndpoint.post("firstRoute", "/verify-email", { success: Schema.String }),
  ),
);
class First extends AuthPlugin.Service<First, { readonly id: string }>()("first", {
  apiVersion: 1,
  contract: FirstApi,
}) {
  static readonly layer = AuthPlugin.layer(First, {
    make: Effect.succeed({ id: "first" }),
    handlers: HttpApiBuilder.group(FirstApi, "first", (handlers) =>
      handlers.handle("firstRoute", () => Effect.succeed("first")),
    ),
  });
}

const SecondApi = HttpApi.make("auth").add(
  HttpApiGroup.make("second").add(
    HttpApiEndpoint.post("secondRoute", "/verify-email", { success: Schema.String }),
  ),
);
class Second extends AuthPlugin.Service<Second, { readonly id: string }>()("second", {
  apiVersion: 1,
  contract: SecondApi,
}) {
  static readonly layer = AuthPlugin.layer(Second, {
    make: Effect.succeed({ id: "second" }),
    handlers: HttpApiBuilder.group(SecondApi, "second", (handlers) =>
      handlers.handle("secondRoute", () => Effect.succeed("second")),
    ),
  });
}

// Same path, different method: not a conflict.
const ThirdApi = HttpApi.make("auth").add(
  HttpApiGroup.make("third").add(
    HttpApiEndpoint.get("thirdRoute", "/verify-email", { success: Schema.String }),
  ),
);
class Third extends AuthPlugin.Service<Third, { readonly id: string }>()("third", {
  apiVersion: 1,
  contract: ThirdApi,
}) {
  static readonly layer = AuthPlugin.layer(Third, {
    make: Effect.succeed({ id: "third" }),
    handlers: HttpApiBuilder.group(ThirdApi, "third", (handlers) =>
      handlers.handle("thirdRoute", () => Effect.succeed("third")),
    ),
  });
}

describe("Auth.make route ownership", () => {
  it("two plugins contributing POST /verify-email in different groups fail with RouteConflict", () => {
    let thrown: unknown;
    try {
      Auth.make([First, Second]);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Auth.RouteConflict);
    if (thrown instanceof Auth.RouteConflict) {
      assert.strictEqual(thrown.method, "POST");
      assert.strictEqual(thrown.path, "/verify-email");
      assert.strictEqual(thrown.firstPluginId, "first");
      assert.strictEqual(thrown.secondPluginId, "second");
      assert.match(thrown.message, /E_ROUTE_CONFLICT: POST \/verify-email .* "first" .* "second"/);
    }
  });

  it("the same path under another method composes", () => {
    assert.doesNotThrow(() => Auth.make([First, Third]));
  });
});
