// @awthaq/cli — Plugin
//
// spec/behaviors/26-cli.md BEH-EA-202 (ELC-008): the installed plugins in the order the
// linker actually uses — `manifest.plugins` *is* `linkPlugins`' topological order, the same
// one migrations are re-keyed by — with each plugin's `dependsOn` edges, contract groups and
// tables. A manifest-only command (BEH-EA-208): no Layer is evaluated.
//
// What is not printed, and why: a plugin's *required ports* are the requirements (`RIn`) of its
// layer, a type-level fact with no runtime trace short of building the layer, and its *hook-tap
// chain* is registered into a process-global registry only when the layer is built (BEH-EA-024).
// Neither is derivable from the manifest without evaluating layers, which class 1 of BEH-EA-208
// forbids; the report says so rather than printing a guess.

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

/** `plugin list` (ids in link order) or `plugin list --graph` with edges, as text, JSON or DOT. */
export const show = (auth: LoadedAuth, options: { readonly graph: boolean; readonly format: Format }) =>
  Effect.gen(function* () {
    const out = yield* Output.Output;
    const nodes = graph(auth);
    if (options.format === "dot") {
      return yield* Effect.forEach(renderDot(nodes), out.line, { discard: true });
    }
    if (options.format === "json" || out.json) return yield* out.document(nodes);
    if (options.graph) return yield* Effect.forEach(renderText(nodes), out.line, { discard: true });
    yield* Effect.forEach(nodes, (node) => out.line(`${node.order}. ${node.id}`), { discard: true });
  });
