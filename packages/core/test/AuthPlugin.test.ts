// M0's own definition of done (spec/roadmap.md): "A toy plugin that compiles,
// and a missing dependency that demonstrably fails to compile — the first
// concrete, if manually-reviewed, proof that the type-level invariants of
// spec/invariants.md §1 hold." The `@ts-expect-error` lines below are that
// proof: `pnpm typecheck` fails if `Validate<P>` stops catching either case,
// and fails just as loudly if a fix makes one of them compile when it
// shouldn't (an unused `@ts-expect-error` is itself a `tsc` error).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Auth, AuthPlugin } from "../src/index.ts";

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

// --- BEH-EA-010: two plugins sharing an id refuses to type-check -----------

class PingDuplicate extends AuthPlugin.Service<PingDuplicate, PingShape>()("ping", {
  apiVersion: 1,
  contract: PingApi,
}) {
  static readonly layer = AuthPlugin.layer(PingDuplicate, {
    make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
  });
}

// @ts-expect-error - plugin id "ping" appears more than once
Auth.make([Ping, PingDuplicate]);

// --- BEH-EA-011: a dependency missing from the tuple refuses to type-check --

// @ts-expect-error - plugin "pong" depends on plugin "ping", which is not in the list
Auth.make([Pong]);

// --- BEH-EA-009/013/016: a valid tuple composes and actually runs -----------

describe("Auth.make", () => {
  it.effect("composes api, layer, migrations, and manifest from one plugin tuple", () =>
    Effect.gen(function* () {
      const auth = Auth.make([Ping, Pong]);

      assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), ["ping", "pong"]);

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
      assert.match(error.message, /effect-auth: circular plugin dependency: ping -> pong -> ping/);
    } finally {
      const restoredPingLayer = AuthPlugin.layer(Ping, {
        make: Effect.succeed({ ping: () => Effect.succeed("pong") }),
      });
      assert.isDefined(restoredPingLayer);
    }
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
    }, /effect-auth: Auth.make requires at least one plugin/);
  });
});
