// M0's own definition of done (spec/roadmap.md): "A toy plugin that compiles,
// and a missing dependency that demonstrably fails to compile — the first
// concrete, if manually-reviewed, proof that the type-level invariants of
// spec/invariants.md §1 hold." The `@ts-expect-error` lines below are that
// proof: `pnpm typecheck` fails if `Validate<P>` stops catching either case,
// and fails just as loudly if a fix makes one of them compile when it
// shouldn't (an unused `@ts-expect-error` is itself a `tsc` error).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";

// --- Ping: a toy plugin with no dependencies -------------------------------

const PingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("ping").add(HttpApiEndpoint.get("ping", "/ping", { success: Schema.String })),
);

interface PingShape {
  readonly ping: () => Effect.Effect<string>;
}

class Ping extends AuthPlugin.Service<Ping, PingShape>()("ping", {
  apiVersion: 1,
  contract: PingApi,
  tables: ["ping_state"],
  migrations: [{ name: "create_ping_state", up: Effect.void }],
}) {
  static readonly layer = AuthPlugin.layer(Ping, {
    make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
    handlers: HttpApiBuilder.group(PingApi, "ping", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("pong")),
    ),
  });
}

// --- Pong: a toy plugin that depends on Ping --------------------------------

const PongApi = HttpApi.make("auth").add(
  HttpApiGroup.make("pong").add(HttpApiEndpoint.get("pong", "/pong", { success: Schema.String })),
);

interface PongShape {
  readonly pong: () => Effect.Effect<string>;
}

class Pong extends AuthPlugin.Service<Pong, PongShape>()("pong", {
  apiVersion: 1,
  contract: PongApi,
  migrations: [{ name: "create_pong_state", up: Effect.void }],
}) {
  static readonly layer = AuthPlugin.layer(Pong, {
    dependsOn: [Ping],
    make: Effect.gen(function* () {
      const ping = yield* Ping;
      return { pong: () => ping.ping() };
    }),
    handlers: HttpApiBuilder.group(PongApi, "pong", (handlers) =>
      handlers.handle("pong", () => Effect.succeed("pong")),
    ),
  });
}

// --- BEH-EA-032: two different plugins colliding via a dotted sub-group ---

// BEH-EA-004 confines a plugin's own contract groups to its own id or a
// dotted sub-id of it (`GroupsFor<Id>`), so two DIFFERENT top-level plugin
// ids can never contribute a group with the exact same *top-level* name —
// that shape is already refused at compile time. The one collision
// `GroupsFor<Id>` cannot see coming, and BEH-EA-032's own runtime check
// exists for, is a dotted sub-group: `Alpha` (id "alpha") is entitled to
// contribute "alpha.beta" as its own sub-group, but a wholly separate,
// independently-valid plugin literally *id*'d "alpha.beta" is entitled to
// contribute a top-level group of that same name — neither plugin's own
// `GroupsFor<Id>` constraint, nor `Validate<P>`'s `DuplicateId` check
// (which only compares full plugin ids), catches this; only `composeApi`'s
// own runtime check does.
const AlphaApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("alpha").add(
      HttpApiEndpoint.get("alpha", "/alpha", { success: Schema.String }),
    ),
  )
  .add(
    HttpApiGroup.make("alpha.beta").add(
      HttpApiEndpoint.get("alphaBeta", "/alpha/beta", { success: Schema.String }),
    ),
  );

interface AlphaShape {
  readonly alpha: () => Effect.Effect<string>;
}

class Alpha extends AuthPlugin.Service<Alpha, AlphaShape>()("alpha", {
  apiVersion: 1,
  contract: AlphaApi,
}) {
  static readonly layer = AuthPlugin.layer(Alpha, {
    make: Effect.succeed({ alpha: () => Effect.succeed("alpha") }),
    handlers: Layer.mergeAll(
      HttpApiBuilder.group(AlphaApi, "alpha", (handlers) =>
        handlers.handle("alpha", () => Effect.succeed("alpha")),
      ),
      HttpApiBuilder.group(AlphaApi, "alpha.beta", (handlers) =>
        handlers.handle("alphaBeta", () => Effect.succeed("beta")),
      ),
    ),
  });
}

const AlphaBetaApi = HttpApi.make("auth").add(
  HttpApiGroup.make("alpha.beta").add(
    HttpApiEndpoint.get("imposter", "/alpha-beta/imposter", { success: Schema.String }),
  ),
);

interface AlphaBetaShape {
  readonly imposter: () => Effect.Effect<string>;
}

class AlphaBeta extends AuthPlugin.Service<AlphaBeta, AlphaBetaShape>()("alpha.beta", {
  apiVersion: 1,
  contract: AlphaBetaApi,
}) {
  static readonly layer = AuthPlugin.layer(AlphaBeta, {
    make: Effect.succeed({ imposter: () => Effect.succeed("imposter") }),
    handlers: HttpApiBuilder.group(AlphaBetaApi, "alpha.beta", (handlers) =>
      handlers.handle("imposter", () => Effect.succeed("imposter")),
    ),
  });
}

// --- AR-003: an admin-tier group, split off by `Auth.make`'s `adminApi` -----

const OpsApi = HttpApi.make("auth").add(
  HttpApiGroup.make("ops.admin").add(
    HttpApiEndpoint.get("status", "/ops/status", { success: Schema.String }),
  ),
);

interface OpsShape {
  readonly status: () => Effect.Effect<string>;
}

class Ops extends AuthPlugin.Service<Ops, OpsShape>()("ops", {
  apiVersion: 1,
  contract: OpsApi,
}) {
  static readonly layer = AuthPlugin.layer(Ops, {
    make: Effect.succeed({ status: () => Effect.succeed("ok") }),
    handlers: HttpApiBuilder.group(OpsApi, "ops.admin", (handlers) =>
      handlers.handle("status", () => Effect.succeed("ok")),
    ),
  });
}

// --- MW-002: extra (non-plugin) group, and plugins colliding with core -----

const ExtraGroup = HttpApiGroup.make("extra").add(
  HttpApiEndpoint.get("extra", "/extra", { success: Schema.String }),
);

const SessionImposterApi = HttpApi.make("auth").add(
  HttpApiGroup.make("session").add(
    HttpApiEndpoint.get("imposter", "/imposter", { success: Schema.String }),
  ),
);

class SessionImposter extends AuthPlugin.Service<
  SessionImposter,
  { readonly imposter: () => Effect.Effect<string> }
>()("session", { apiVersion: 1, contract: SessionImposterApi }) {
  static readonly layer = AuthPlugin.layer(SessionImposter, {
    make: Effect.succeed({ imposter: () => Effect.succeed("x") }),
    handlers: HttpApiBuilder.group(SessionImposterApi, "session", (handlers) =>
      handlers.handle("imposter", () => Effect.succeed("x")),
    ),
  });
}

const RouteImposterApi = HttpApi.make("auth").add(
  HttpApiGroup.make("routeImposter").add(
    HttpApiEndpoint.get("list", "/session/list", { success: Schema.String }),
  ),
);

class RouteImposter extends AuthPlugin.Service<
  RouteImposter,
  { readonly list: () => Effect.Effect<string> }
>()("routeImposter", { apiVersion: 1, contract: RouteImposterApi }) {
  static readonly layer = AuthPlugin.layer(RouteImposter, {
    make: Effect.succeed({ list: () => Effect.succeed("x") }),
    handlers: HttpApiBuilder.group(RouteImposterApi, "routeImposter", (handlers) =>
      handlers.handle("list", () => Effect.succeed("x")),
    ),
  });
}

// --- BEH-EA-010: two plugins sharing an id refuses to type-check -----------

class PingDuplicate extends AuthPlugin.Service<PingDuplicate, PingShape>()("ping", {
  apiVersion: 1,
  contract: PingApi,
}) {
  static readonly layer = AuthPlugin.layer(PingDuplicate, {
    make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
  });
}

// --- BEH-EA-011: a dependency missing from the tuple refuses to type-check --

// @ts-expect-error - plugin "pong" depends on plugin "ping", which is not in the list
Auth.make([Pong]);

// --- BEH-EA-009/013/016: a valid tuple composes and actually runs -----------

describe("Auth.make", () => {
  it.effect("composes api, layer, migrations, and manifest from one plugin tuple", () =>
    Effect.gen(function* () {
      const auth = Auth.make([Ping, Pong]);

      // MW-002: core's own groups ride along with the plugins'.
      assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), [
        "account",
        "ping",
        "pong",
        "session",
      ]);

      const result = yield* Effect.gen(function* () {
        const pong = yield* Pong;
        return yield* pong.pong();
      }).pipe(Effect.provide(auth.layer));
      assert.strictEqual(result, "pong");

      assert.deepStrictEqual(
        auth.migrations.map((m) => m.name),
        ["0001_ping_create_ping_state", "0002_pong_create_pong_state"],
      );

      assert.deepStrictEqual(auth.manifest, {
        plugins: [
          { id: "ping", apiVersion: 1, tables: ["ping_state"], dependsOn: [] },
          { id: "pong", apiVersion: 1, tables: [], dependsOn: ["ping"] },
        ],
      });
    }),
  );

  it("AR-003: admin-tier groups are split into adminApi, the rest into publicApi, api keeps all", () => {
    const auth = Auth.make([Ping, Ops]);
    assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), [
      "account",
      "ops.admin",
      "ping",
      "session",
    ]);
    assert.deepStrictEqual(Object.keys(auth.publicApi.groups).sort(), [
      "account",
      "ping",
      "session",
    ]);
    assert.deepStrictEqual(Object.keys(auth.adminApi.groups), ["ops.admin"]);

    // The split is typed, not just runtime: only the tier's own groups are in each type.
    type AdminGroupIds = keyof typeof auth.adminApi.groups;
    type PublicGroupIds = keyof typeof auth.publicApi.groups;
    const admin: AdminGroupIds = "ops.admin";
    const pub: PublicGroupIds = "ping";
    // @ts-expect-error - "ping" is public-tier, so it is not a group of the admin api
    const notAdmin: AdminGroupIds = "ping";
    // @ts-expect-error - "ops.admin" is admin-tier, so it is not a group of the public api
    const notPublic: PublicGroupIds = "ops.admin";
    assert.deepStrictEqual(
      [admin, pub, notAdmin, notPublic],
      ["ops.admin", "ping", "ping", "ops.admin"],
    );

    // A composition with no admin group has an empty admin tier (nothing to firewall).
    assert.deepStrictEqual(Object.keys(Auth.make([Ping]).adminApi.groups), []);
    // ...and the public tier is never empty: core's groups live there.
    assert.deepStrictEqual(Object.keys(Auth.make([Ops]).publicApi.groups).sort(), [
      "account",
      "session",
    ]);
  });

  it("MW-002 / BEH-EA-031/032: the composed api always carries core's session and account groups", () => {
    const auth = Auth.make([Ping]);
    assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), ["account", "ping", "session"]);
    // The public tier keeps them (they are not admin-tier); the admin tier stays plugin-only.
    assert.deepStrictEqual(Object.keys(auth.publicApi.groups).sort(), ["account", "ping", "session"]);
    assert.deepStrictEqual(Object.keys(auth.adminApi.groups), []);
    // Typed, not just runtime: `session` is a group id of `api`.
    const ids: keyof typeof auth.api.groups = "session";
    assert.strictEqual(ids, "session");
  });

  it("MW-002: extraGroups joins the composed api, typed", () => {
    const auth = Auth.make([Ping], { extraGroups: [ExtraGroup] });
    assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), [
      "account",
      "extra",
      "ping",
      "session",
    ]);
    const id: keyof typeof auth.api.groups = "extra";
    assert.strictEqual(id, "extra");
  });

  it("MW-002: a plugin contributing a group named session is refused with GroupIdConflict naming core", () => {
    let thrown: unknown;
    try {
      Auth.make([SessionImposter]);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Auth.GroupIdConflict);
    assert.strictEqual(thrown.groupId, "session");
    assert.strictEqual(thrown.firstPluginId, "core");
    assert.strictEqual(thrown.secondPluginId, "session");
  });

  it("MW-002: a plugin route colliding with a core route is refused with RouteConflict naming core", () => {
    assert.throws(() => Auth.make([RouteImposter]), /E_ROUTE_CONFLICT: GET \/session\/list contributed by plugin "core"/);
  });

  it("BEH-EA-016: a circular dependsOn is refused at runtime with the full cycle path", () => {
    // `dependsOn` is read-only from the outside (BEH-EA-007) — there is no
    // backdoor to force a cycle by mutating it directly. A real circular
    // dependency only ever arises from a circular import between two
    // plugins' own modules, which is why this instead reuses `AuthPlugin.layer`
    // itself, the same public call each plugin's own `static readonly layer`
    // makes: calling it again for `Ping` re-keys `dependsOnByPlugin` for it,
    // making `Ping -> Pong -> Ping` real without touching any private state.
    const cyclicPingLayer = AuthPlugin.layer(Ping, {
      dependsOn: [Pong],
      make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
    });
    assert.isDefined(cyclicPingLayer);
    try {
      let thrown: unknown;
      try {
        Auth.make([Ping, Pong]);
      } catch (error) {
        thrown = error;
      }
      assert.instanceOf(thrown, Auth.CircularPluginDependency);
      const error = thrown as Auth.CircularPluginDependency;
      assert.strictEqual(error._tag, "CircularPluginDependency");
      assert.deepStrictEqual(error.cycle, ["ping", "pong", "ping"]);
      assert.match(error.message, /awthaq: circular plugin dependency: ping -> pong -> ping/);
    } finally {
      const restoredPingLayer = AuthPlugin.layer(Ping, {
        make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
      });
      assert.isDefined(restoredPingLayer);
    }
  });

  it("BEH-EA-032: two plugins contributing the same group id refuses at runtime with a typed GroupIdConflict, naming both plugins", () => {
    let thrown: unknown;
    try {
      Auth.make([Alpha, AlphaBeta]);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Auth.GroupIdConflict);
    const error = thrown as Auth.GroupIdConflict;
    assert.strictEqual(error._tag, "GroupIdConflict");
    assert.strictEqual(error.groupId, "alpha.beta");
    assert.strictEqual(error.firstPluginId, "alpha");
    assert.strictEqual(error.secondPluginId, "alpha.beta");
    assert.match(
      error.message,
      /awthaq: E_GROUP_CONFLICT: group "alpha\.beta" contributed by plugin "alpha" and plugin "alpha\.beta"/,
    );
  });

  it("BEH-EA-010: a duplicate plugin id also trips composeApi's own GroupIdConflict at runtime", () => {
    // `Validate<P>`'s `DuplicateId` check (BEH-EA-010) refuses this at the
    // type level (`@ts-expect-error` below). Bypassing that, `Ping` and
    // `PingDuplicate` both name their own group "ping" too (they share a
    // `contract`), so this doubles as a second, independent proof that
    // `composeApi`'s BEH-EA-032 check is a real runtime backstop, not only
    // reachable through the dotted-sub-id shape above — previously this
    // line silently produced a broken `Built<P>` (the topological sort
    // itself collapses "ping" to one plugin, `HttpApiGroup`'s own overwrite
    // masking the loss), which BEH-EA-032's fix now surfaces as a throw
    // instead.
    assert.throws(() => {
      // @ts-expect-error - plugin id "ping" appears more than once
      Auth.make([Ping, PingDuplicate]);
    }, /awthaq: E_GROUP_CONFLICT: group "ping"/);
  });

  it("BEH-EA-009: an empty plugin tuple refuses to type-check, and its runtime backstop is a catchable EmptyPluginTuple", () => {
    // `Auth.make`'s own parameter type (`NonEmptyPlugins`) refuses `[]` the
    // same way `Validate<P>` refuses a duplicate id or a missing dependency —
    // as a type error, not a thrown one. `@ts-expect-error` proves that; the
    // `assert.throws` around it proves the defensive runtime backstop
    // (`EmptyPluginTuple`, for a caller that bypasses the type check) still
    // holds once the type error is suppressed to actually run this line.
    assert.throws(() => {
      // @ts-expect-error - Auth.make requires at least one plugin
      Auth.make([]);
    }, /awthaq: Auth.make requires at least one plugin/);
  });
});
