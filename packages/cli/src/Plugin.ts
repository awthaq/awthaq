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
//
// ADR-EA-049: `--events` prints `manifest.events`, every event of the composition (core's, then each
// plugin's declared `events` in link order) with its owner, who acts, its personal-data fields and its
// lane (an attempt is recorded whether or not its unit of work commits).

import type { TenantScoped } from "@awthaq/sql";
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
  /** Plan 05: each table's declared tenancy, as `awthaq plugin list` prints it. */
  readonly tenancy: Readonly<Record<string, string>>;
  /** PV-241: the ports the plugin's layer requires (service keys), as it declares them. */
  readonly ports: ReadonlyArray<string>;
  /** ADR-EA-040: the namespaced domain services the plugin's layer exposes beside its own service (service keys). */
  readonly exposes: ReadonlyArray<string>;
  /** PV-241: where the plugin's declared taps sit in each point's resolved chain. */
  readonly hooks: ReadonlyArray<{
    readonly point: string;
    /** 1-based position in the point's chain. */
    readonly position: number;
    readonly order: number;
  }>;
}

/** `partitioned "tenantId"`, `derived via "endpointId" of webhooks_endpoint`, `global: <reason>`. */
const describeTenancy = (declaration: TenantScoped.TableDeclaration) => {
  const tenancy = declaration.tenancy;
  switch (tenancy._tag) {
    case "Partitioned":
      return `partitioned "${tenancy.column}"`;
    case "Keyed":
      return `keyed "${tenancy.column}"`;
    case "Derived":
      return `derived via "${tenancy.via}" of ${tenancy.parent}`;
    case "Global":
      return `global: ${tenancy.reason}`;
  }
};

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
    tenancy: Object.fromEntries(
      Object.entries(plugin.tenancy).map(([table, declaration]) => [
        table,
        describeTenancy(declaration),
      ]),
    ),
    ports: auth.manifest.ports.filter((port) => port.plugin === plugin.id).map((port) => port.key),
    exposes: auth.manifest.exposes
      .filter((exposed) => exposed.plugin === plugin.id)
      .map((exposed) => exposed.key),
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
    `     tables:     ${list(node.tables.map((table) => (node.tenancy[table] === undefined ? table : `${table} (${node.tenancy[table]})`)))}`,
    `     ports:      ${list(node.ports)}`,
    `     exposes:    ${list(node.exposes)}`,
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
  /** The bucket-key strategy (`ip`, `email`, `user`, ...). */
  readonly key: string;
  /** `attempts` (every call spends one unit) or `failures` (guarded before, charged on a failure). */
  readonly mode: string;
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
    key: rule.key,
    mode: rule.mode,
    limit: rule.limit,
    window: Duration.format(Duration.fromInputUnsafe(rule.window)),
  }));

const RULE_HEADER = ["PLUGIN", "RULE", "ENDPOINT", "DIMENSION", "KEY", "MODE", "LIMIT"];

export const renderRules = (rows: ReadonlyArray<RuleRow>) => {
  if (rows.length === 0) return ["no installed plugin declares a rate-limit rule"];
  const cells = rows.map((row) => [
    row.plugin,
    row.name,
    `${row.group}.${row.endpoint}`,
    row.dimension,
    row.key,
    row.mode,
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

/** ADR-EA-049: one event of the composition, its actor rendered (`userId`, `subjectId (user:)`, `-` for none). */
export interface EventRow {
  readonly tag: string;
  readonly owner: string;
  readonly actor: string;
  readonly pii: ReadonlyArray<string>;
  readonly attempt: boolean;
}

export const events = (auth: LoadedAuth): ReadonlyArray<EventRow> =>
  auth.manifest.events.map((event) => ({
    tag: event.tag,
    owner: event.owner,
    actor:
      event.actor._tag === "None"
        ? "-"
        : event.actor._tag === "Field"
          ? event.actor.field
          : `${event.actor.field} (${event.actor.prefix})`,
    pii: event.pii,
    attempt: event.attempt,
  }));

const EVENT_HEADER = ["TAG", "OWNER", "ACTOR", "PII", "ATTEMPT"];

export const renderEvents = (rows: ReadonlyArray<EventRow>) => {
  const cells = rows.map((row) => [
    row.tag,
    row.owner,
    row.actor,
    row.pii.length === 0 ? "-" : row.pii.join(","),
    row.attempt ? "yes" : "no",
  ]);
  const widths = EVENT_HEADER.map((title, column) =>
    Math.max(title.length, ...cells.map((cell) => (cell[column] ?? "").length)),
  );
  return [EVENT_HEADER, ...cells].map((cell) =>
    cell
      .map((text, column) => (column === cell.length - 1 ? text : text.padEnd(widths[column] ?? 0)))
      .join("  "),
  );
};

/** `plugin list` (ids in link order), `--graph` with edges, ports and taps, `--hooks` with the resolved tap chains, `--rules` with the declared rate limits, or `--events` with the composition's events, as text, JSON or DOT. */
export const show = (
  auth: LoadedAuth,
  options: {
    readonly graph: boolean;
    readonly hooks?: boolean | undefined;
    readonly rules?: boolean | undefined;
    readonly events?: boolean | undefined;
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
    if (options.events === true) {
      if (options.format === "json" || out.json) return yield* out.document(events(auth));
      return yield* Effect.forEach(renderEvents(events(auth)), out.line, { discard: true });
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
