// BEH-EA-009 (spec/behaviors/02-plugin-composition-validate.md): `Auth.make`
// composes a real `roles` plugin the same way `@awthaq/password`'s and
// `@awthaq/oauth`'s own `AuthComposition.test.ts` files prove.
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
import { AuditLog, Auth, AuthEvents, AuthPlugin, Slots } from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Roles from "../src/Roles.ts";
import * as RolesAdmin from "../src/RolesAdmin.ts";

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

  it("Roles + RolesAdmin compose: the admin plugin depends on Roles and contributes the one group (YL-009)", () => {
    const auth = Auth.make([Roles.Roles, RolesAdmin.RolesAdmin]);
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "roles", apiVersion: 1, tables: ["role_assignments"], dependsOn: [] },
      { id: "rolesAdmin", apiVersion: 1, tables: [], dependsOn: ["roles"] },
    ]);
  });

  it("composes alongside another plugin, contributing no groups but a real table", () => {
    const auth = Auth.make([Ping, Roles.Roles]);
    assert.strictEqual(auth.api.identifier, "auth");
    assert.deepStrictEqual(auth.manifest.plugins, [
      { id: "ping", apiVersion: 1, tables: [], dependsOn: [] },
      { id: "roles", apiVersion: 1, tables: ["role_assignments"], dependsOn: [] },
    ]);
  });
});

// RRM-012: BEH-EA-138's exclusivity is enforced when the layers are *built*
// (through the opt-in `Slots.SlotsRegistry`), before any request is served —
// not by `Auth.make`'s type checker, which cannot observe a `Context.Reference`
// override (`Slots.ts`'s and `SubjectResolver.ts`'s own header comments give the
// structural reason).
describe("SubjectResolver slot exclusivity (BEH-EA-138)", () => {
  const otherPlugin: AuthPlugin.Any = {
    id: "organization",
    apiVersion: 1,
    contract: { identifier: "auth", groups: {} },
    tables: [],
    migrations: [],
    dependsOn: [],
    layer: Layer.empty,
  };

  const CoreLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));
  const RolesInstalled = Roles.Roles.layer.pipe(
    Layer.provide(Roles.config([])),
    Layer.provideMerge(CoreLive),
  );
  const OtherOverride = Slots.override(
    otherPlugin,
    QadiSubjectResolver.SubjectResolver,
    Effect.succeed({
      resolve: (principal) => Effect.succeed(QadiSubjectResolver.resolveIdentityOnly(principal)),
    }),
  );

  it.effect("two SubjectResolver overrides with Slots.layer fail with SlotConflict at build", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(RolesInstalled));
      const failure = yield* Effect.scoped(Layer.build(OtherOverride)).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SlotConflict");
      assert.strictEqual(failure.firstOwner, "roles");
      assert.strictEqual(failure.secondOwner, "organization");
    }).pipe(Effect.provide(Slots.layer)),
  );
});
