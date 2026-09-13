// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes a real `roles` plugin the same way `@effect-auth/password`'s and
// `@effect-auth/oauth`'s own `AuthComposition.test.ts` files prove.
//
// `roles` contributes an empty `HttpApi.make("auth")` (no groups of its own,
// per this plugin's own header comment) — `Auth.make([Roles.Roles])` alone
// therefore has *zero* groups across the whole tuple, which `Auth.ts`'s own
// `composeApi` refuses with `EmptyPluginTuple` (its own comment: "there is
// no such thing as an `Auth` with no plugins as a product matter either" —
// the same reasoning applies once no plugin in the tuple contributes any
// group at all). A minimal companion plugin with one real endpoint is
// composed alongside `Roles` to prove its own manifest entry composes
// correctly without a real HTTP dependency between the two packages.
import { Auth, AuthPlugin } from "@effect-auth/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Roles } from "../src/index.ts";

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

describe("Auth.make([Roles])", () => {
  it("a Roles-only tuple fails — it contributes zero HTTP groups", () => {
    assert.throws(() => Auth.make([Roles.Roles]), /Auth.make requires at least one plugin/);
  });

  it("composes alongside another plugin, contributing no groups and no tables", () => {
    const auth = Auth.make([Ping, Roles.Roles]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "ping", apiVersion: 1, tables: [], dependsOn: [] },
      { id: "roles", apiVersion: 1, tables: [], dependsOn: [] },
    ]);
  });
});
