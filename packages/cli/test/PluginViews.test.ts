// BEH-EA-202/225: pins every `plugin list` view's output per mode before and after the views
// module; written against the pre-refactor code. One generated case per view x mode x fixture,
// asserted on whole captured arrays (stdout, stderr, documents), so the equality is exact string
// equality and never a substring or line-count check.
//
// Contract pinned here (`--format` is per command, `--json` is the global flag):
//   - dot beats `--json`, but only where a view has a dot branch (graph and the default view);
//   - `--format json` and `--json` each produce the JSON document, and both together produce ONE;
//   - hooks / rules / events have no dot branch: dot prints their text, dot + `--json` their document.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Config from "../src/Config.ts";
import * as Output from "../src/Output.ts";
import * as Plugin from "../src/Plugin.ts";
import { hookedApp } from "./support/HookedApp.ts";
import { runCli } from "./support/RunCli.ts";
import { configOf, passwordAndRoles } from "./support/TestApp.ts";

type FixtureName = "hookedApp" | "passwordAndRoles";

const fixtures: ReadonlyArray<{ readonly name: FixtureName; readonly app: Config.LoadedAuth }> = [
  { name: "hookedApp", app: hookedApp },
  { name: "passwordAndRoles", app: passwordAndRoles },
];

const modes: ReadonlyArray<{
  readonly name: string;
  readonly format: Plugin.Format;
  readonly json: boolean;
}> = [
  { name: "text", format: "text", json: false },
  { name: "--format json", format: "json", json: false },
  { name: "--json", format: "text", json: true },
  { name: "--format json + --json", format: "json", json: true },
  { name: "--format dot", format: "dot", json: false },
  { name: "--format dot + --json", format: "dot", json: true },
];

/** `Plugin.show` under `Output.capture(json)`: everything a command wrote, in all three channels. */
const run = (app: Config.LoadedAuth, options: Parameters<typeof Plugin.show>[1], json: boolean) =>
  Effect.gen(function* () {
    const { captured, layer } = yield* Output.capture(json);
    yield* Plugin.show(app, options).pipe(Effect.provide(layer));
    return {
      stdout: yield* Ref.get(captured.stdout),
      stderr: yield* Ref.get(captured.stderr),
      documents: yield* Ref.get(captured.documents),
    };
  });

interface View {
  readonly name: string;
  /** The selector flags (`--hooks`, ...) the view is reached through. */
  readonly selector: Omit<Parameters<typeof Plugin.show>[1], "format">;
  /** Only the graph and the default view have a dot branch. */
  readonly dot: boolean;
  readonly rows: (app: Config.LoadedAuth) => unknown;
  /** The lines the view prints when it resolves to text (or to dot, where it has none). */
  readonly text: Record<FixtureName, ReadonlyArray<string>>;
  /** The lines the view prints when it resolves to dot. */
  readonly dotLines?: Record<FixtureName, ReadonlyArray<string>>;
}

const hooksView: View = {
  name: "--hooks",
  selector: { graph: false, hooks: true },
  dot: false,
  rows: Plugin.hooks,
  text: {
    hookedApp: [
      "cli.test.normalize",
      "  1. alpha (order 5)",
      "  2. beta (order 0)",
      "(application taps registered in the host run after every entry listed here)",
    ],
    passwordAndRoles: [
      "no installed plugin declares a hook tap (application taps are registered when the app runs)",
    ],
  },
};

const views: ReadonlyArray<View> = [hooksView];

/** What a mode resolves to for a view: the one place the precedence contract is written down. */
const resolve = (view: View, mode: (typeof modes)[number]) =>
  view.dot && mode.format === "dot" ? "dot" : mode.format === "json" || mode.json ? "json" : "text";

describe("plugin list views: mode x view matrix", () => {
  for (const view of views) {
    for (const fixture of fixtures) {
      for (const mode of modes) {
        const resolved = resolve(view, mode);
        it.effect(
          `${view.name} on ${fixture.name} under ${mode.name} resolves to ${resolved}`,
          () =>
            Effect.gen(function* () {
              const out = yield* run(
                fixture.app,
                { ...view.selector, format: mode.format },
                mode.json,
              );
              assert.deepStrictEqual(out.stderr, []);
              if (resolved === "json") {
                const rows = view.rows(fixture.app);
                assert.strictEqual(out.documents.length, 1);
                assert.deepStrictEqual(out.documents[0], rows);
                assert.strictEqual(out.stdout.length, 1);
                assert.strictEqual(out.stdout[0], JSON.stringify(rows, null, 2));
              } else {
                assert.deepStrictEqual(out.documents, []);
                const lines =
                  resolved === "dot" ? view.dotLines?.[fixture.name] : view.text[fixture.name];
                assert.isDefined(lines);
                assert.deepStrictEqual(out.stdout, lines);
              }
            }),
        );
      }
    }
  }
});

describe("plugin list --hooks: pinned values", () => {
  it("hookedApp declares one chain, alpha then beta", () => {
    assert.deepStrictEqual(Plugin.hooks(hookedApp), [
      {
        point: "cli.test.normalize",
        taps: [
          { position: 1, plugin: "alpha", order: 5 },
          { position: 2, plugin: "beta", order: 0 },
        ],
      },
    ]);
  });

  it("passwordAndRoles declares no tap: the empty document is []", () => {
    assert.deepStrictEqual(Plugin.hooks(passwordAndRoles), []);
  });
});

describe("plugin list --hooks: real argv", () => {
  const document = JSON.stringify(Plugin.hooks(hookedApp), null, 2);

  it.effect("--json plugin list --hooks prints exactly one document", () =>
    Effect.gen(function* () {
      const r = yield* runCli(["--json", "plugin", "list", "--hooks"], configOf(hookedApp));
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(r.stderr, []);
      assert.deepStrictEqual(r.stdout, [document]);
    }),
  );

  it.effect("plugin list --hooks --format json prints exactly one document", () =>
    Effect.gen(function* () {
      const r = yield* runCli(
        ["plugin", "list", "--hooks", "--format", "json"],
        configOf(hookedApp),
      );
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(r.stderr, []);
      assert.deepStrictEqual(r.stdout, [document]);
    }),
  );

  it.effect("plugin list --hooks --format dot prints the hooks text", () =>
    Effect.gen(function* () {
      const r = yield* runCli(
        ["plugin", "list", "--hooks", "--format", "dot"],
        configOf(hookedApp),
      );
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(r.stderr, []);
      assert.deepStrictEqual(r.stdout, hooksView.text.hookedApp);
    }),
  );
});
