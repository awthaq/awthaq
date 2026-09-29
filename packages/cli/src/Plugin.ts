// @awthaq/cli — Plugin
//
// spec/behaviors/26-cli.md BEH-EA-202 (ELC-008): the installed plugins in the order the
// linker actually uses — `manifest.plugins` *is* `linkPlugins`' topological order, the same
// one migrations are re-keyed by — with each plugin's `dependsOn` edges, contract groups and
// tables. A manifest-only command (BEH-EA-208): no Layer is evaluated.
//
// What is not printed, and why: a plugin's *required ports* are the requirements (`RIn`) of its
// layer, a type-level fact with no runtime trace short of building the layer. It is not derivable
// from the manifest without evaluating layers, which class 1 of BEH-EA-208 forbids; the report says
// so rather than printing a guess.
//
// PV-241/BEH-EA-096: `--hooks` prints `manifest.hooks`, the taps plugins declare statically
// (`AuthPlugin.layer`'s `taps`) in the order the runtime chain runs them (`HookPoint.compareTaps`).
// Application taps (`Point.tap` in the host) are registered when a layer is built, so they are not
// listed; they run after every entry shown. Rate-limit rules register at layer build too and have no
// static declaration yet, so they are not listed (PV-241).

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
}

export const graph = (auth: LoadedAuth): ReadonlyArray<GraphNode> =>
  auth.manifest.plugins.map((plugin, index) => ({
    order: index + 1,
    id: plugin.id,
    dependsOn: plugin.dependsOn,
    groups: plugin.groups,
    tables: plugin.tables,
  }));

/** PV-241: one hook point's statically declared taps, in resolved order. */
export interface HookChain {
  /** The point's id, without the registry's `awthaq/hook/` key prefix. */
  readonly point: string;
  readonly taps: ReadonlyArray<{
    /** 1-based position in the chain. */
    readonly position: number;
    readonly plugin: string;
    readonly order: number;
  }>;
}

const HOOK_KEY_PREFIX = "awthaq/hook/";

export const hooks = (auth: LoadedAuth): ReadonlyArray<HookChain> =>
  Object.entries(auth.manifest.hooks).map(([key, taps]) => ({
    point: key.startsWith(HOOK_KEY_PREFIX) ? key.slice(HOOK_KEY_PREFIX.length) : key,
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
  ]),
  "(required ports and hook-tap chains are not derivable without building the layers; see BEH-EA-202)",
];

/** Graphviz: one node per plugin, one edge per `dependsOn` (dependency -> dependent), in link order. */
export const renderDot = (nodes: ReadonlyArray<GraphNode>) => [
  "digraph awthaq {",
  ...nodes.map((node) => `  "${node.id}";`),
  ...nodes.flatMap((node) => node.dependsOn.map((dep) => `  "${dep}" -> "${node.id}";`)),
  "}",
];

/** `plugin list` (ids in link order), `--graph` with edges, or `--hooks` with the resolved tap chains, as text, JSON or DOT. */
export const show = (
  auth: LoadedAuth,
  options: {
    readonly graph: boolean;
    readonly hooks?: boolean | undefined;
    readonly format: Format;
  },
) =>
  Effect.gen(function* () {
    const out = yield* Output.Output;
    if (options.hooks === true) {
      if (options.format === "json" || out.json) return yield* out.document(hooks(auth));
      return yield* Effect.forEach(renderHooks(hooks(auth)), out.line, { discard: true });
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
