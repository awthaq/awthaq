// @awthaq/cli — Plugin
//
// spec/behaviors/26-cli.md BEH-EA-202 (ELC-008): the installed plugins in the order the
// linker actually uses — `manifest.plugins` *is* `linkPlugins`' topological order, the same
// one migrations are re-keyed by — with each plugin's `dependsOn` edges, contract groups and
// tables. A manifest-only command (BEH-EA-208): no Layer is evaluated.
//
// PV-241/BEH-EA-202: `--graph` also prints each plugin's *required ports* and the taps it contributes
// to the resolved hook chains. A layer's requirements (`RIn`) have no runtime trace, so a plugin
// declares its ports statically (`AuthPlugin.layer`'s `ports`, checked complete at the type level) and
// the manifest carries them; the taps come from `manifest.hooks`. Nothing here builds a layer.
//
// PV-241/BEH-EA-096: `--hooks` prints `manifest.hooks`, the taps plugins declare statically
// (`AuthPlugin.layer`'s `taps`) in the order the runtime chain runs them (`HookPoint.compareTaps`).
// Application taps (`Point.tap` in the host) are registered when a layer is built, so they are not
// listed; they run after every entry shown.
//
// PV-241/BEH-EA-111: `--rules` prints `manifest.rateLimits`, the rate-limit rules plugins declare
// statically (`AuthPlugin.Service`'s `rateLimits`): the defaults, which a configurable plugin may
// tune at build.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { LoadedAuth } from "./Config.ts";
import * as Output from "./Output.ts";

export type Format = "text" | "json" | "dot";

export interface GraphNode {
  /** 1-based position in the linker's order. */
  readonly order: number;
  readonly id: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<string>;
  /** PV-241: the ports the plugin's layer requires (service keys), as it declares them. */
  readonly ports: ReadonlyArray<string>;
  /** PV-241: where the plugin's declared taps sit in each point's resolved chain. */
  readonly hooks: ReadonlyArray<{
    readonly point: string;
    /** 1-based position in the point's chain. */
    readonly position: number;
    readonly order: number;
  }>;
}

const HOOK_KEY_PREFIX = "awthaq/hook/";

/** The point's id, without the registry's `awthaq/hook/` key prefix. */
const pointName = (key: string) =>
  key.startsWith(HOOK_KEY_PREFIX) ? key.slice(HOOK_KEY_PREFIX.length) : key;

export const graph = (auth: LoadedAuth): ReadonlyArray<GraphNode> =>
  auth.manifest.plugins.map((plugin, index) => ({
    order: index + 1,
    id: plugin.id,
    dependsOn: plugin.dependsOn,
    groups: plugin.groups,
    tables: plugin.tables,
    ports: auth.manifest.ports.filter((port) => port.plugin === plugin.id).map((port) => port.key),
    hooks: Object.entries(auth.manifest.hooks).flatMap(([key, taps]) =>
      taps.flatMap((tap, position) =>
        tap.plugin === plugin.id
          ? [{ point: pointName(key), position: position + 1, order: tap.order }]
          : [],
      ),
    ),
  }));

/** PV-241: one hook point's statically declared taps, in resolved order. */
export interface HookChain {
  readonly point: string;
  readonly taps: ReadonlyArray<{
    /** 1-based position in the chain. */
    readonly position: number;
    readonly plugin: string;
    readonly order: number;
  }>;
}

export const hooks = (auth: LoadedAuth): ReadonlyArray<HookChain> =>
  Object.entries(auth.manifest.hooks).map(([key, taps]) => ({
    point: pointName(key),
    taps: taps.map((tap, index) => ({
      position: index + 1,
      plugin: tap.plugin,
      order: tap.order,
    })),
  }));

export const renderHooks = (chains: ReadonlyArray<HookChain>) =>
  chains.length === 0
    ? [
        "no installed plugin declares a hook tap (application taps are registered when the app runs)",
      ]
    : [
        ...chains.flatMap((chain) => [
          chain.point,
          ...chain.taps.map((tap) => `  ${tap.position}. ${tap.plugin} (order ${tap.order})`),
        ]),
        "(application taps registered in the host run after every entry listed here)",
      ];

const list = (values: ReadonlyArray<string>) => (values.length === 0 ? "-" : values.join(", "));

export const renderText = (nodes: ReadonlyArray<GraphNode>) => [
  ...nodes.flatMap((node) => [
    `${node.order}. ${node.id}`,
    `     depends on: ${list(node.dependsOn)}`,
    `     groups:     ${list(node.groups)}`,
    `     tables:     ${list(node.tables)}`,
    `     ports:      ${list(node.ports)}`,
    `     hook taps:  ${list(node.hooks.map((tap) => `${tap.point} #${tap.position} (order ${tap.order})`))}`,
  ]),
  "(ports and taps are the plugins' static declarations; application taps registered in the host run after every declared tap)",
];

/** Graphviz: one node per plugin, one edge per `dependsOn` (dependency -> dependent), in link order. */
export const renderDot = (nodes: ReadonlyArray<GraphNode>) => [
  "digraph awthaq {",
  ...nodes.map((node) => `  "${node.id}";`),
  ...nodes.flatMap((node) => node.dependsOn.map((dep) => `  "${dep}" -> "${node.id}";`)),
  "}",
];

/** PV-241: one declared rate-limit rule, its window rendered as `Duration.format` does (`15m`). */
export interface RuleRow {
  readonly plugin: string;
  readonly group: string;
  readonly endpoint: string;
  readonly name: string;
  readonly dimension: string;
  readonly limit: number;
  readonly window: string;
}

export const rules = (auth: LoadedAuth): ReadonlyArray<RuleRow> =>
  auth.manifest.rateLimits.map((rule) => ({
    plugin: rule.plugin,
    group: rule.group,
    endpoint: rule.endpoint,
    name: rule.name,
    dimension: rule.dimension,
    limit: rule.limit,
    window: Duration.format(Duration.fromInputUnsafe(rule.window)),
  }));

const RULE_HEADER = ["PLUGIN", "RULE", "ENDPOINT", "DIMENSION", "LIMIT"];

export const renderRules = (rows: ReadonlyArray<RuleRow>) => {
  if (rows.length === 0) return ["no installed plugin declares a rate-limit rule"];
  const cells = rows.map((row) => [
    row.plugin,
    row.name,
    `${row.group}.${row.endpoint}`,
    row.dimension,
    `${row.limit} per ${row.window}`,
  ]);
  const widths = RULE_HEADER.map((title, column) =>
    Math.max(title.length, ...cells.map((cell) => (cell[column] ?? "").length)),
  );
  return [RULE_HEADER, ...cells].map((cell) =>
    cell
      .map((text, column) => (column === cell.length - 1 ? text : text.padEnd(widths[column] ?? 0)))
      .join("  "),
  );
};

/** `plugin list` (ids in link order), `--graph` with edges, ports and taps, `--hooks` with the resolved tap chains, or `--rules` with the declared rate limits, as text, JSON or DOT. */
export const show = (
  auth: LoadedAuth,
  options: {
    readonly graph: boolean;
    readonly hooks?: boolean | undefined;
    readonly rules?: boolean | undefined;
    readonly format: Format;
  },
) =>
  Effect.gen(function* () {
    const out = yield* Output.Output;
    if (options.hooks === true) {
      if (options.format === "json" || out.json) return yield* out.document(hooks(auth));
      return yield* Effect.forEach(renderHooks(hooks(auth)), out.line, { discard: true });
    }
    if (options.rules === true) {
      if (options.format === "json" || out.json) return yield* out.document(rules(auth));
      return yield* Effect.forEach(renderRules(rules(auth)), out.line, { discard: true });
    }
    const nodes = graph(auth);
    if (options.format === "dot") {
      return yield* Effect.forEach(renderDot(nodes), out.line, { discard: true });
    }
    if (options.format === "json" || out.json) return yield* out.document(nodes);
    if (options.graph) return yield* Effect.forEach(renderText(nodes), out.line, { discard: true });
    yield* Effect.forEach(nodes, (node) => out.line(`${node.order}. ${node.id}`), {
      discard: true,
    });
  });
