// BEH-EA-202/225: pins every `plugin list` view's output per mode before and after the views
// module; written against the pre-refactor code. One generated case per view x mode x fixture,
// asserted on whole captured arrays (stdout, stderr, documents), so the equality is exact string
// equality and never a substring check.
//
// Contract pinned here (`--format` is per command, `--json` is the global flag):
//   - dot beats `--json`, but only where a view has a dot branch (graph and the default view);
//   - `--format json` and `--json` each produce the JSON document, and both together produce ONE;
//   - hooks / rules / events have no dot branch: dot prints their text, dot + `--json` their document;
//   - selector precedence is --hooks > --rules > --events > --graph / default;
//   - a failure renders as `awthaq: <message>` on stderr; only the global `--json` makes it a document.
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
  /**
   * For views whose `text` is the renderer applied to the builder (so a later core event or rule
   * does not break the pin, but a renderer swap does): the literal first lines and the line count.
   */
  readonly pinned?: Record<
    FixtureName,
    { readonly head: ReadonlyArray<string>; readonly count: number }
  >;
}

const DEFAULT_DOT: Record<FixtureName, ReadonlyArray<string>> = {
  hookedApp: ["digraph awthaq {", '  "alpha";', '  "beta";', '  "alpha" -> "beta";', "}"],
  passwordAndRoles: ["digraph awthaq {", '  "password";', '  "roles";', "}"],
};

const defaultView: View = {
  name: "default",
  selector: { graph: false },
  dot: true,
  rows: Plugin.graph,
  text: {
    hookedApp: ["1. alpha", "2. beta"],
    passwordAndRoles: ["1. password", "2. roles"],
  },
  dotLines: DEFAULT_DOT,
};

const graphView: View = {
  name: "--graph",
  selector: { graph: true },
  dot: true,
  rows: Plugin.graph,
  text: {
    hookedApp: [
      "1. alpha",
      "     depends on: -",
      "     groups:     alpha",
      "     tables:     -",
      "     ports:      awthaq/ports/Mailer, awthaq/ports/RateLimiter",
      "     exposes:    awthaq/plugin/alpha/Lamp",
      "     hook taps:  cli.test.normalize #1 (order 5)",
      "2. beta",
      "     depends on: alpha",
      "     groups:     beta",
      "     tables:     -",
      "     ports:      -",
      "     exposes:    -",
      "     hook taps:  cli.test.normalize #2 (order 0)",
      "(ports and taps are the plugins' static declarations; application taps registered in the host run after every declared tap)",
    ],
    passwordAndRoles: Plugin.renderText(Plugin.graph(passwordAndRoles)),
  },
  dotLines: DEFAULT_DOT,
  pinned: {
    hookedApp: { head: ["1. alpha", "     depends on: -"], count: 15 },
    passwordAndRoles: {
      head: [
        "1. password",
        "     depends on: -",
        "     groups:     password, password.account",
        "     tables:     -",
        "     ports:      awthaq/ports/Mailer, awthaq/ports/PasswordHasher, awthaq/ports/RateLimiter, awthaq/ports/SqlTransaction",
        "     exposes:    awthaq/plugin/password/Credential",
        "     hook taps:  -",
        "2. roles",
      ],
      count: 15,
    },
  },
};

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

const rulesView: View = {
  name: "--rules",
  selector: { graph: false, rules: true },
  dot: false,
  rows: Plugin.rules,
  text: {
    hookedApp: ["no installed plugin declares a rate-limit rule"],
    passwordAndRoles: Plugin.renderRules(Plugin.rules(passwordAndRoles)),
  },
  pinned: {
    hookedApp: { head: ["no installed plugin declares a rate-limit rule"], count: 1 },
    passwordAndRoles: {
      head: [
        "PLUGIN    RULE                    ENDPOINT                         DIMENSION  KEY         MODE      LIMIT",
        "password  signUp                  password.signUp                  identity   email       attempts  5 per 1h",
      ],
      count: 19,
    },
  },
};

const eventsView: View = {
  name: "--events",
  selector: { graph: false, events: true },
  dot: false,
  rows: Plugin.events,
  text: {
    hookedApp: Plugin.renderEvents(Plugin.events(hookedApp)),
    passwordAndRoles: Plugin.renderEvents(Plugin.events(passwordAndRoles)),
  },
  pinned: {
    hookedApp: {
      head: [
        "TAG                             OWNER  ACTOR              PII  ATTEMPT",
        "auth.token.replay               core   -                  -    yes",
      ],
      count: 25,
    },
    passwordAndRoles: {
      head: [
        "TAG                             OWNER     ACTOR              PII  ATTEMPT",
        "auth.token.replay               core      -                  -    yes",
      ],
      count: 31,
    },
  },
};

const views: ReadonlyArray<View> = [defaultView, graphView, hooksView, rulesView, eventsView];

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

describe("plugin list views: literal text pins", () => {
  for (const view of views) {
    for (const fixture of fixtures) {
      const pinned = view.pinned?.[fixture.name];
      if (pinned === undefined) continue;
      it.effect(
        `${view.name} on ${fixture.name} prints ${pinned.count} lines starting with the pinned head`,
        () =>
          Effect.gen(function* () {
            const out = yield* run(fixture.app, { ...view.selector, format: "text" }, false);
            assert.strictEqual(out.stdout.length, pinned.count);
            assert.deepStrictEqual(out.stdout.slice(0, pinned.head.length), pinned.head);
          }),
      );
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

  it("hookedApp declares no rule: the empty document is []", () => {
    assert.deepStrictEqual(Plugin.rules(hookedApp), []);
  });
});

describe("plugin list: selector precedence (--hooks > --rules > --events > --graph / default)", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly selector: Omit<Parameters<typeof Plugin.show>[1], "format">;
    readonly wins: View;
  }> = [
    {
      name: "--hooks and --rules print hooks",
      selector: { graph: false, hooks: true, rules: true },
      wins: hooksView,
    },
    {
      name: "--rules and --events print rules",
      selector: { graph: false, rules: true, events: true },
      wins: rulesView,
    },
    {
      name: "--graph and --events print events",
      selector: { graph: true, events: true },
      wins: eventsView,
    },
    {
      name: "--graph, --hooks, --rules and --events print hooks",
      selector: { graph: true, hooks: true, rules: true, events: true },
      wins: hooksView,
    },
  ];
  for (const fixture of fixtures) {
    for (const c of cases) {
      it.effect(`${c.name} on ${fixture.name}`, () =>
        Effect.gen(function* () {
          const out = yield* run(fixture.app, { ...c.selector, format: "text" }, false);
          assert.deepStrictEqual(out.stderr, []);
          assert.deepStrictEqual(out.documents, []);
          assert.deepStrictEqual(out.stdout, c.wins.text[fixture.name]);
        }),
      );
    }
  }
});

describe("plugin list: real argv", () => {
  const hooksDocument = JSON.stringify(Plugin.hooks(hookedApp), null, 2);
  const graphDocument = JSON.stringify(Plugin.graph(hookedApp), null, 2);

  const cases: ReadonlyArray<{
    readonly argv: ReadonlyArray<string>;
    readonly stdout: ReadonlyArray<string>;
  }> = [
    { argv: ["plugin", "list"], stdout: defaultView.text.hookedApp },
    { argv: ["plugin", "list", "--format", "json", "--json"], stdout: [graphDocument] },
    { argv: ["--json", "plugin", "list", "--format", "json"], stdout: [graphDocument] },
    {
      argv: ["plugin", "list", "--graph", "--format", "dot", "--json"],
      stdout: DEFAULT_DOT.hookedApp,
    },
    { argv: ["--json", "plugin", "list", "--hooks"], stdout: [hooksDocument] },
    { argv: ["plugin", "list", "--hooks", "--format", "json"], stdout: [hooksDocument] },
    { argv: ["plugin", "list", "--hooks", "--format", "dot"], stdout: hooksView.text.hookedApp },
    { argv: ["plugin", "list", "--hooks", "--rules"], stdout: hooksView.text.hookedApp },
    { argv: ["plugin", "list", "--rules", "--events"], stdout: rulesView.text.hookedApp },
  ];
  for (const c of cases) {
    it.effect(`awthaq ${c.argv.join(" ")} exits 0 and prints the pinned stdout`, () =>
      Effect.gen(function* () {
        const r = yield* runCli(c.argv, configOf(hookedApp));
        assert.strictEqual(r.code, 0);
        assert.deepStrictEqual(r.stderr, []);
        assert.deepStrictEqual(r.stdout, c.stdout);
      }),
    );
  }
});

describe("plugin list: failure rendering stays on the global --json only (BEH-EA-225)", () => {
  it.effect("--format json alone renders the failure as one `awthaq: <message>` stderr line", () =>
    Effect.gen(function* () {
      const r = yield* runCli(["plugin", "list", "--format", "json"]);
      assert.strictEqual(r.code, 9);
      assert.deepStrictEqual(r.stdout, []);
      assert.deepStrictEqual(r.stderr, ["awthaq: no configuration module in this test"]);
    }),
  );

  it.effect("the global --json renders the same failure as one JSON failure document", () =>
    Effect.gen(function* () {
      const r = yield* runCli(["--json", "plugin", "list", "--format", "json"]);
      assert.strictEqual(r.code, 9);
      assert.deepStrictEqual(r.stdout, []);
      assert.strictEqual(r.stderr.length, 1);
      assert.deepStrictEqual(JSON.parse(r.stderr[0] ?? ""), {
        _tag: "ConfigUnavailable",
        code: 9,
        message: "no configuration module in this test",
      });
    }),
  );
});
