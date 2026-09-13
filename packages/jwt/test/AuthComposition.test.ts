// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes a real `jwt` plugin the same way `@effect-auth/roles`'s own
// `AuthComposition.test.ts` proves.
//
// `jwt` now carries a real group (the `jwks` endpoint, ticket 09), so
// `Auth.make([Jwt.Jwt])` alone composes fine — unlike Phase A's own
// discovery, when the plugin still contributed an empty `HttpApi.make("auth")`
// and tripped `Auth.ts`'s `EmptyPluginTuple` guard the same way `Roles`'s
// own test still documents for a plugin with genuinely zero endpoints. A
// minimal companion plugin is still composed alongside `Jwt` in the second
// test, to prove its manifest entry composes correctly next to another
// plugin too, not only alone.
import { Auth, AuthPlugin } from "@effect-auth/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Jwt } from "../src/index.ts";

const PingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("ping").add(HttpApiEndpoint.get("get", "/ping", { success: Schema.Void })),
);

class Ping extends AuthPlugin.Service<Ping, Record<string, never>>()("ping", {
  apiVersion: 1,
  contract: PingApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(Ping, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(PingApi, "ping", (handlers) =>
      handlers.handle("get", () => Effect.void),
    ),
  });
}

describe("Auth.make([Jwt])", () => {
  it("composes alone — the jwks endpoint gives it a real group", () => {
    const auth = Auth.make([Jwt.Jwt]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "jwt", apiVersion: 1, tables: ["jwt_signing_key"], dependsOn: [] },
    ]);
  });

  it("composes alongside another plugin", () => {
    const auth = Auth.make([Ping, Jwt.Jwt]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "ping", apiVersion: 1, tables: [], dependsOn: [] },
      { id: "jwt", apiVersion: 1, tables: ["jwt_signing_key"], dependsOn: [] },
    ]);
  });
});
