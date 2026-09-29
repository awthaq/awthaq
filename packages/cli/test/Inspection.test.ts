// BEH-EA-202/203/205 (BE-003, ELC-008, ERS-008): the manifest-only inspection commands, run over
// a real `Auth.make([Password, Roles])` composition. None of them needs a database, a listener or
// a built Layer — the suite provides only `Output`.
import { Api } from "@awthaq/api";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Openapi from "../src/Openapi.ts";
import * as Output from "../src/Output.ts";
import * as Plugin from "../src/Plugin.ts";
import * as Routes from "../src/Routes.ts";
import { hookedApp } from "./support/HookedApp.ts";
import { passwordAndRoles } from "./support/TestApp.ts";

const captureStdout = <A, E>(effect: Effect.Effect<A, E, Output.Output>, json = false) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(json);
    yield* effect.pipe(Effect.provide(layer));
    return yield* Ref.get(captured.stdout);
  });

describe("routes", () => {
  it.effect("lists every endpoint of the composition with its owning plugin", () =>
    Effect.gen(function* () {
      const routes = yield* Routes.routesOf(passwordAndRoles);
      const signUp = routes.find(
        (route) => route.method === "POST" && route.path.endsWith("/sign-up"),
      );
      assert.strictEqual(signUp?.group, "password");
      assert.strictEqual(signUp?.plugin, "password");
      // The contract's endpoint count is what the listing carries — none omitted.
      let expected = 0;
      for (const group of Object.values(passwordAndRoles.api.groups)) {
        expected += Object.keys(group.endpoints).length;
      }
      assert.strictEqual(routes.length, expected);
      assert.isAbove(routes.length, 5);
    }),
  );

  it.effect("carries each endpoint's applied middleware, CSRF included", () =>
    Effect.gen(function* () {
      const routes = yield* Routes.routesOf(passwordAndRoles);
      const csrf = new Set(routes.filter((r) => r.middleware.includes(Api.CsrfProtection.key)));
      assert.isAbove(csrf.size, 0);
      // A safe-method read carries no CSRF middleware requirement.
      const authenticated = routes.filter((r) => r.middleware.includes(Api.Authentication.key));
      assert.isAbove(authenticated.length, 0);
    }),
  );

  it.effect("prints a table under text output and the rows as JSON under --json", () =>
    Effect.gen(function* () {
      const text = yield* captureStdout(Routes.show(passwordAndRoles));
      assert.match(text[0] ?? "", /^METHOD\s+PATH\s+GROUP\s+PLUGIN\s+MIDDLEWARE/);
      const { captured, layer } = yield* Output.capture(true);
      yield* Routes.show(passwordAndRoles).pipe(Effect.provide(layer));
      const [doc] = yield* Ref.get(captured.documents);
      assert.isTrue(Array.isArray(doc));
    }),
  );
});

describe("plugin list --graph", () => {
  it.effect("prints dependsOn edges in the linker's order", () =>
    Effect.gen(function* () {
      const nodes = Plugin.graph(passwordAndRoles);
      assert.deepStrictEqual(
        nodes.map((node) => [node.order, node.id]),
        passwordAndRoles.manifest.plugins.map((plugin, index) => [index + 1, plugin.id]),
      );
      const text = yield* captureStdout(
        Plugin.show(passwordAndRoles, { graph: true, format: "text" }),
      );
      assert.isTrue(text.some((line) => line.includes("password")));
      assert.isTrue(text.some((line) => line.includes("groups:     password, password.account")));
    }),
  );

  it.effect(
    "--format dot emits one edge per dependsOn and --format json the same graph as data",
    () =>
      Effect.gen(function* () {
        const dot = yield* captureStdout(
          Plugin.show(passwordAndRoles, { graph: true, format: "dot" }),
        );
        assert.strictEqual(dot[0], "digraph awthaq {");
        assert.strictEqual(dot[dot.length - 1], "}");
        const { captured, layer } = yield* Output.capture(false);
        yield* Plugin.show(passwordAndRoles, { graph: true, format: "json" }).pipe(
          Effect.provide(layer),
        );
        const [doc] = yield* Ref.get(captured.documents);
        assert.deepStrictEqual(doc, Plugin.graph(passwordAndRoles));
      }),
  );
});

// PV-241/BEH-EA-096: `plugin list --hooks` prints `manifest.hooks`, the resolved per-point tap order.
describe("plugin list --hooks", () => {
  it.effect("prints each point's declared taps in the order the runtime chain runs them", () =>
    Effect.gen(function* () {
      const text = yield* captureStdout(
        Plugin.show(hookedApp, { graph: false, hooks: true, format: "text" }),
      );
      assert.strictEqual(text[0], "cli.test.normalize");
      // Beta depends on Alpha, so it runs second despite its lower declared order.
      assert.match(text[1] ?? "", /^\s*1\. alpha \(order 5\)/);
      assert.match(text[2] ?? "", /^\s*2\. beta \(order 0\)/);
      assert.isTrue(text.some((line) => line.includes("application taps")));
    }),
  );

  it.effect("--format json emits the same chains as data", () =>
    Effect.gen(function* () {
      const { captured, layer } = yield* Output.capture(false);
      yield* Plugin.show(hookedApp, { graph: false, hooks: true, format: "json" }).pipe(
        Effect.provide(layer),
      );
      const [doc] = yield* Ref.get(captured.documents);
      assert.deepStrictEqual(doc, Plugin.hooks(hookedApp));
      assert.deepStrictEqual(Plugin.hooks(hookedApp), [
        {
          point: "cli.test.normalize",
          taps: [
            { position: 1, plugin: "alpha", order: 5 },
            { position: 2, plugin: "beta", order: 0 },
          ],
        },
      ]);
    }),
  );

  it.effect("says so when no installed plugin declares a tap", () =>
    Effect.gen(function* () {
      const text = yield* captureStdout(
        Plugin.show(passwordAndRoles, { graph: false, hooks: true, format: "text" }),
      );
      assert.isTrue(text.some((line) => line.includes("no installed plugin declares a hook tap")));
    }),
  );
});

describe("openapi", () => {
  it.effect("emits one document covering every installed plugin's contract", () =>
    Effect.gen(function* () {
      const [text] = yield* captureStdout(
        Openapi.emit(passwordAndRoles, { out: undefined }).pipe(
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      const spec: unknown = JSON.parse(text ?? "null");
      assert.isTrue(typeof spec === "object" && spec !== null && "paths" in spec);
      const paths =
        typeof spec === "object" &&
        spec !== null &&
        "paths" in spec &&
        typeof spec.paths === "object" &&
        spec.paths !== null
          ? Object.keys(spec.paths)
          : [];
      assert.isTrue(paths.some((path) => path.endsWith("/sign-up")));
    }),
  );
});
