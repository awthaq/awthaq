// ADR-EA-027 §4: the CLI imports the application's own composition from `awthaq.config.ts`. These
// tests import real fixture modules through the real loader (`Config.layerFile`) — a bare
// composition, an Effect producing one, `defineConfig({...})`, a module whose `Auth.make` refuses the
// plugin set, and a module that exports nothing usable.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import * as CliConfig from "../src/Config.ts";
import { passwordAndRoles } from "./support/TestApp.ts";

const fixture = (name: string) =>
  Path.join(Path.dirname(fileURLToPath(import.meta.url)), "fixtures", name);

const load = (name: string) =>
  CliConfig.ConfigSource.use((source) => source.load(fixture(name))).pipe(
    Effect.provide(CliConfig.layerFile.pipe(Layer.provideMerge(NodeServices.layer))),
  );

describe("Config.layerFile", () => {
  it.effect("loads a bare composition as the default export", () =>
    Effect.gen(function* () {
      const config = yield* load("bare.config.ts");
      assert.deepStrictEqual(
        config.auth.manifest.plugins.map((plugin) => plugin.id),
        ["password"],
      );
      assert.isUndefined(config.app);
      assert.isUndefined(config.production);
    }),
  );

  it.effect("loads an Effect that produces the composition", () =>
    Effect.gen(function* () {
      const config = yield* load("effect.config.ts");
      assert.deepStrictEqual(
        config.auth.manifest.plugins.map((plugin) => plugin.id),
        ["password"],
      );
    }),
  );

  it.effect("loads defineConfig({ auth, production })", () =>
    Effect.gen(function* () {
      const config = yield* load("basic.config.ts");
      assert.deepStrictEqual(
        config.auth.manifest.plugins.map((plugin) => plugin.id),
        passwordAndRoles.manifest.plugins.map((plugin) => plugin.id),
      );
      assert.strictEqual(config.production, true);
    }),
  );

  it.effect("hands an Auth.make refusal over as a LinkProblem naming the code", () =>
    Effect.gen(function* () {
      const error = yield* load("conflict.config.ts").pipe(Effect.flip);
      assert.strictEqual(error._tag, "LinkProblem");
      if (error._tag === "LinkProblem") assert.strictEqual(error.code, "RouteConflict");
    }),
  );

  it.effect("fails ConfigUnavailable saying what a module has to export", () =>
    Effect.gen(function* () {
      const error = yield* load("empty.config.ts").pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConfigUnavailable");
      assert.include(error.message, "default-export");
    }),
  );

  it.effect("fails ConfigUnavailable for a path that does not exist", () =>
    Effect.gen(function* () {
      const error = yield* load("nope.config.ts").pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConfigUnavailable");
      assert.include(error.message, "no configuration module at");
    }),
  );
});

describe("Config.fromModule", () => {
  it.effect("rejects a module whose `auth` is not a composition", () =>
    Effect.gen(function* () {
      const error = yield* CliConfig.fromModule({
        default: { auth: { not: "a composition" } },
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConfigUnavailable");
    }),
  );

  it.effect("rejects an optional slot that is not a Layer", () =>
    Effect.gen(function* () {
      const error = yield* CliConfig.fromModule({
        default: { auth: passwordAndRoles, app: "not a layer" },
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ConfigUnavailable");
      assert.include(error.message, "`app`");
    }),
  );
});
