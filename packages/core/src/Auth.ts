// @awthaq/core — Auth
//
// spec/behaviors/02-plugin-composition-validate.md, BEH-EA-009 through
// BEH-EA-016. `Auth.make` composes real `AuthPlugin` values: `Validate<P>`'s
// `DuplicateId`, `MissingDep` and `OutOfOrderDep` checks (BEH-EA-010,
// BEH-EA-011, JH-006), `api` and `layer` computed from the same tuple
// (BEH-EA-009, BEH-EA-013), core's own `session`/`account` groups seeded into
// `api` (MW-002), one `SlotsRegistry` per composition so `SlotConflict` is
// always checked (BEH-EA-012, MA-005), and the runtime cycle detection and
// migration ordering (BEH-EA-016) — all exercised by `test/AuthPlugin.test.ts`.

import { AuthCore } from "@awthaq/api";
import type * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuthPlugin from "./AuthPlugin.ts";
import * as HookPoint from "./HookPoint.ts";
import type { ConfigDescriptor } from "./ConfigDescriptor.ts";
import type { Migrations } from "./Migrations.ts";
import * as Slots from "./Slots.ts";

// ---------------------------------------------------------------------------
// Errors — catchable by class instead of by string-matching a plain `Error`
// ---------------------------------------------------------------------------

/** BEH-EA-016: `Auth.make` refuses a `dependsOn` cycle at runtime, naming the full path. */
export class CircularPluginDependency extends Data.TaggedError("CircularPluginDependency")<{
  readonly cycle: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * `composeApi`/`composeLayer` require at least one plugin (see `composeApi`'s
 * own comment for why zero plugins has no well-typed `api`/`layer` at all).
 * `Auth.make`'s own parameter type (`NonEmptyPlugins`, below) refuses an
 * empty tuple at compile time already, so this is unreachable through a
 * well-typed call — it stays as a defensive backstop for a caller that
 * bypasses the type check (plain JS, an unsafe cast) rather than the
 * primary way this gets refused.
 */
export class EmptyPluginTuple extends Data.TaggedError("EmptyPluginTuple")<{
  readonly message: string;
}> {}

/**
 * BEH-EA-032: the installed `HttpApi.add` stores groups by identifier with
 * last-wins `assignProperty` semantics and no collision check of its own —
 * two plugins contributing a group with the same identifier would
 * otherwise resolve to whichever was added last, silently dropping the
 * loser's endpoints from the served surface while its handlers layer
 * still merges underneath. `composeApi` checks for this itself and
 * refuses it, matching `archive/design/usage-examples-v4.md` §2.2's own
 * `E_GROUP_CONFLICT` failure shape (there phrased with a `package@version`
 * pair; `AuthPlugin`'s own identity is `id`/`apiVersion`, used here
 * instead of a fabricated semver).
 */
export class GroupIdConflict extends Data.TaggedError("GroupIdConflict")<{
  readonly groupId: string;
  readonly firstPluginId: string;
  readonly secondPluginId: string;
  readonly message: string;
}> {}

/**
 * AVS-004: two contributed endpoints, in the same or different groups, claim
 * the same method and path. The router would silently serve whichever
 * registered first, shadowing the other plugin's endpoint, so composition
 * refuses it instead of relying on a hand-kept list of reserved paths — which
 * also covers a plugin's deliberate root-level routes (`@awthaq/password`
 * owns `/verify-email`, `/resend-verification`, `/change-password`) the same
 * way it covers namespaced ones.
 */
export class RouteConflict extends Data.TaggedError("RouteConflict")<{
  readonly method: string;
  readonly path: string;
  readonly firstPluginId: string;
  readonly secondPluginId: string;
  readonly message: string;
}> {}

/**
 * JH-007: a plugin declared (`readsTables`) that it reads a table another installed
 * plugin owns, without listing that plugin in `dependsOn`. `dependsOn` is the sole
 * source of migration order, so without it the reader's migrations could run before
 * the table exists; composition refuses it instead of relying on a convention.
 */
export class UndeclaredTableDependency extends Data.TaggedError("UndeclaredTableDependency")<{
  readonly pluginId: string;
  readonly ownerId: string;
  readonly table: string;
  readonly message: string;
}> {}

/**
 * A loop invariant `linkPlugins`/`findCycle` rely on (e.g. "a queue drained
 * one non-undefined element at a time never returns undefined while
 * non-empty") did not hold. Reachable only if one of those invariants is
 * broken by a future edit — a real bug, not a user input problem — but still
 * a typed, catchable failure instead of an unchecked `!` that would otherwise
 * turn the same broken invariant into a silent `undefined` dereference.
 */
export class LinkerInvariantViolation extends Data.TaggedError("LinkerInvariantViolation")<{
  readonly message: string;
}> {}

/** Replaces a postfix `!`: the invariant is checked for real, and a broken one is a catchable `LinkerInvariantViolation`, not a silent `undefined` dereference. */
const assertDefined = <A>(value: A | undefined, detail: string): A => {
  if (value === undefined) {
    throw new LinkerInvariantViolation({ message: `awthaq: internal error — ${detail}` });
  }
  return value;
};

// ---------------------------------------------------------------------------
// Validate<P> — BEH-EA-010, BEH-EA-011
// ---------------------------------------------------------------------------

type Ids<P extends ReadonlyArray<AuthPlugin.Any>> = P[number]["id"];

/** BEH-EA-010: the first plugin id that appears more than once in the tuple, or `never`. */
type DuplicateId<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Seen extends string = never,
> = P extends readonly [infer Head, ...infer Rest]
  ? Head extends AuthPlugin.Any
    ? Head["id"] extends Seen
      ? Head["id"]
      : Rest extends ReadonlyArray<AuthPlugin.Any>
        ? DuplicateId<Rest, Seen | Head["id"]>
        : never
    : never
  : never;

/**
 * The other plugins a plugin's own `layer` requires — read off `layer`'s
 * `RIn` (BEH-EA-008: every class `dependsOn` lists joins `RIn`), not off the
 * `dependsOn` value-level field. `Class.dependsOn` (`AuthPlugin.ts`) is
 * deliberately typed `ReadonlyArray<AuthPlugin.Any>` (BEH-EA-001's own code
 * block), so it cannot carry which *specific* classes a plugin depends on at
 * the type level — only a real value can, and that value only exists once
 * `AuthPlugin.layer` runs (see that module's `dependsOn` getter comment).
 * `layer`'s `RIn`, in contrast, is exact at the type level from the moment
 * `AuthPlugin.layer(Plugin, { dependsOn: [...] })` is written, because
 * `dependsOn`'s classes are spliced directly into `RIn` there. Every plugin's
 * compiled key is `` `awthaq/plugin/${id}` `` (BEH-EA-002), so filtering
 * `RIn`'s services by that `key` shape separates plugin dependencies from
 * ports (`Mailer`, `PasswordHasher`, ...), which have no such key.
 */
type PluginDeps<X extends AuthPlugin.Any> = Extract<
  Layer.Services<X["layer"]>,
  { readonly key: `awthaq/plugin/${string}` }
>;

/**
 * `PluginDeps` extracts the *service instance* type (`Ping`, what `yield*
 * Ping` requires — `Context.ServiceClass` makes the class itself
 * `Effect<Shape, never, Self>`, so `RIn` carries `Self`, not `typeof Ping`),
 * which — unlike the class — has no `id` static to read. Its compiled `key`
 * (BEH-EA-002: `` `awthaq/plugin/${id}` ``) still names the id, in the
 * string itself.
 */
type IdOf<Dep> = Dep extends { readonly key: `awthaq/plugin/${infer Id}` } ? Id : never;

/** BEH-EA-011: the first `[missingDepId, requiringPluginId]` pair not present in the tuple, or `never`. */
type MissingDep<
  P extends ReadonlyArray<AuthPlugin.Any>,
  AllIds extends string = Ids<P>,
> = P[number] extends infer Plugin
  ? Plugin extends AuthPlugin.Any
    ? PluginDeps<Plugin> extends infer Dep
      ? IdOf<Dep> extends AllIds
        ? never
        : readonly [IdOf<Dep>, Plugin["id"]]
      : never
    : never
  : never;

/**
 * JH-006: the first `[dependencyId, dependentId]` pair where a plugin is listed
 * before a plugin its `layer` requires, or `never`. `FoldLayer<P>` folds the tuple
 * left to right while `composeLayer` folds the topologically sorted order, so the
 * two are the same layer only when the tuple already lists dependencies first —
 * refusing anything else makes that agreement a checked invariant, not a convention.
 */
type OutOfOrderDep<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Seen extends string = never,
> = P extends readonly [infer Head, ...infer Rest]
  ? Head extends AuthPlugin.Any
    ? [IdOf<PluginDeps<Head>>] extends [Seen]
      ? Rest extends ReadonlyArray<AuthPlugin.Any>
        ? OutOfOrderDep<Rest, Seen | Head["id"]>
        : never
      : readonly [Exclude<IdOf<PluginDeps<Head>>, Seen>, Head["id"]]
    : never
  : never;

/**
 * JH-008 / BEH-EA-020: the ports a plugin's layer must only ever *require*. Every
 * awthaq port's service key is `awthaq/ports/<Name>` (`PasswordHasher`, `Mailer`,
 * `RateLimiter`, `WebAuthn`, `KeyProvider`, `Encryption`, `SqlTransaction`,
 * `ClientAddress`, ...), so the key prefix names them all without a hand-kept
 * list that a new port could be missing from; `SqlClient` and `Crypto` are
 * Effect's own, listed by type.
 */
type ReservedPort =
  | { readonly key: `awthaq/ports/${string}` }
  | Crypto.Crypto
  | SqlClient.SqlClient;

type PortName<Port> = Port extends { readonly key: infer Key extends string }
  ? Key
  : "Crypto or SqlClient";

/** JH-008: the first `[portName, pluginId]` where a plugin's layer provides a port in its `ROut`, or `never`. */
type PortProvidedByPlugin<P extends ReadonlyArray<AuthPlugin.Any>> = P[number] extends infer Plugin
  ? Plugin extends AuthPlugin.Any
    ? [Extract<Layer.Success<Plugin["layer"]>, ReservedPort>] extends [never]
      ? never
      : readonly [PortName<Extract<Layer.Success<Plugin["layer"]>, ReservedPort>>, Plugin["id"]]
    : never
  : never;

/** The one problem `Validate<P>` reports for `P`, in a fixed order (duplicate id, missing dependency, order, port), or `never`. */
type FirstProblem<P extends ReadonlyArray<AuthPlugin.Any>> = [DuplicateId<P>] extends [never]
  ? [MissingDep<P>] extends [never]
    ? [OutOfOrderDep<P>] extends [never]
      ? [PortProvidedByPlugin<P>] extends [never]
        ? never
        : PortProvidedByPlugin<P> extends readonly [
              infer Port extends string,
              infer By extends string,
            ]
          ? {
              readonly awthaq: `plugin "${By}" provides port "${Port}" — a plugin may only require ports, never provide them`;
            }
          : never
      : OutOfOrderDep<P> extends readonly [infer Dep extends string, infer By extends string]
        ? {
            readonly awthaq: `plugin "${By}" depends on plugin "${Dep}", which must be listed before it`;
          }
        : never
    : MissingDep<P> extends readonly [infer Dep extends string, infer By extends string]
      ? {
          readonly awthaq: `plugin "${By}" depends on plugin "${Dep}", which is not in the list`;
        }
      : never
  : { readonly awthaq: `plugin id "${DuplicateId<P>}" appears more than once` };

/**
 * BEH-EA-009/010/011/020: a plugin tuple is accepted as-is only once it has no
 * duplicate id, no dependency missing from the same tuple, every dependency
 * listed before its dependent (JH-006), and no plugin providing a port (JH-008);
 * otherwise the argument type narrows to a literal object naming the problem, so
 * passing the tuple to `Auth.make` fails to type-check with a readable message
 * (`archive/design/plugins-as-layers.md` §4.3) instead of an opaque mismatch.
 */
export type Validate<P extends ReadonlyArray<AuthPlugin.Any>> = [FirstProblem<P>] extends [never]
  ? P
  : FirstProblem<P>;

// ---------------------------------------------------------------------------
// Built<P> — BEH-EA-009, BEH-EA-013
// ---------------------------------------------------------------------------

export interface ManifestPlugin {
  readonly id: string;
  readonly apiVersion: 1;
  readonly tables: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
  /** BEH-EA-203: the contract groups this plugin owns, so `routes` can name the owning plugin of an endpoint. */
  readonly groups: ReadonlyArray<string>;
}

/** ECS-008/BEH-EA-229: one configuration descriptor, tagged with the plugin that declared it. */
export interface ManifestConfig {
  readonly pluginId: string;
  readonly descriptor: ConfigDescriptor;
}

/** PERS-003: one statically declared tap in a point's resolved chain. */
export interface ManifestTap {
  readonly plugin: string;
  readonly order: number;
}

/** BEH-EA-016: read off the composed classes, never authored (`archive/design/plugins-as-layers.md` §7). */
export interface Manifest {
  readonly plugins: ReadonlyArray<ManifestPlugin>;
  /**
   * PERS-003/BEH-EA-096: every plugin-declared tap (`AuthPlugin.layer`'s `taps`
   * option), per hook point key, in the order the runtime chain runs them —
   * derived with `HookPoint.compareTaps`, the same comparator the runtime uses,
   * without building any layer. Application taps (`Point.tap` in the host) are
   * not declared statically and run after every entry listed here.
   */
  readonly hooks: Readonly<Record<string, ReadonlyArray<ManifestTap>>>;
  /** ECS-008: every installed plugin's configuration descriptors, in link order — static, no Layer evaluated. */
  readonly config: ReadonlyArray<ManifestConfig>;
}

/**
 * Extracts a plugin's real, literal `HttpApiGroup` union from its `contract`.
 * `AuthPlugin.Any["contract"]` is only `ContractData` (identifier and groups
 * data, no methods — see that interface's own doc comment for why), so this
 * conditional type carries no constraint on `Plugin` at all: at a concrete
 * call site, where `P`, and so `P[number]`, is the real plugin class rather
 * than the widened `Any`, it still reads the real, method-bearing `contract`
 * type off it, per plugin.
 */
type GroupsOf<Plugin> = Plugin extends { readonly contract: HttpApi.HttpApi<string, infer Groups> }
  ? Groups
  : never;

/**
 * MW-002 (wayfinder ticket 26): core's own `session`/`account` groups, read off
 * `AuthCore.AuthCoreApi` the way `GroupsOf` reads a plugin's.
 */
type CoreGroups = GroupsOf<{ readonly contract: typeof AuthCore.AuthCoreApi }>;

/** MW-002: every group of the one served `api`: core's, the host's `extraGroups`, then each plugin's. */
type AllGroups<P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint> =
  | CoreGroups
  | Extra
  | GroupsOf<P[number]>;

/**
 * `Layer.provideMerge(self, that)`'s own type, restated so `FoldLayer` can
 * apply it under `infer`. Bounded by `Layer.Layer<never, unknown, unknown>`,
 * matching `AuthPlugin.Any["layer"]`'s own declared type exactly (not a
 * wildcard `any`): `Head["layer"]` and `Acc`, when `FoldLayer`/`FoldLayerFrom`
 * are checked generically against `P`'s own declared constraint
 * (`ReadonlyArray<AuthPlugin.Any>`), are exactly that type — `Layer`'s `ROut`
 * is contravariant, so `never` there is what actually accepts every
 * concrete plugin's `Layer<Self, ...>` (`never` is assignable to any `Self`),
 * not `any` or `unknown`.
 */
type ProvideMerged<
  Self extends Layer.Layer<never, unknown, unknown>,
  That extends Layer.Layer<never, unknown, unknown>,
> = Layer.Layer<
  Layer.Success<Self> | Layer.Success<That>,
  Layer.Error<Self> | Layer.Error<That>,
  Layer.Services<That> | Exclude<Layer.Services<Self>, Layer.Success<That>>
>;

/**
 * The type-level mirror of `composeLayer`'s runtime fold
 * (`rest.reduce((acc, plugin) => Layer.provideMerge(plugin.layer, acc), first.layer)`):
 * walks `P` left to right with an accumulator, each next plugin's `layer`
 * provided everything folded in so far, so a later plugin's requirement on
 * an earlier one nets out of the result instead of staying in `RIn` next to
 * what already provides it. `composeLayer`'s *runtime* fold runs on
 * `linkPlugins`' topologically sorted order; `Validate<P>`'s `OutOfOrderDep`
 * (JH-006) refuses any tuple whose own order differs from it, so for every
 * accepted `P` the two folds are the same.
 */
type FoldLayer<P extends ReadonlyArray<AuthPlugin.Any>> = P extends readonly [
  infer Head,
  ...infer Rest,
]
  ? Head extends AuthPlugin.Any
    ? Rest extends ReadonlyArray<AuthPlugin.Any>
      ? FoldLayerFrom<Rest, Head["layer"]>
      : never
    : never
  : never;

type FoldLayerFrom<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Acc extends Layer.Layer<never, unknown, unknown>,
> = P extends readonly [infer Head, ...infer Rest]
  ? Head extends AuthPlugin.Any
    ? Rest extends ReadonlyArray<AuthPlugin.Any>
      ? FoldLayerFrom<Rest, ProvideMerged<Head["layer"], Acc>>
      : Acc
    : Acc
  : Acc;

/**
 * BEH-EA-009: `api` and `layer` are both computed from `P`'s `contract`s and
 * `layer`s — a contract cannot exist without its handlers (`layer`'s `ROut`
 * carries `HttpApiGroup.ToService` for every group `AuthPlugin.layer` itself
 * required at each plugin's own definition site, BEH-EA-013), and handlers
 * cannot exist for a group no plugin's `contract` declares.
 */
export interface Built<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint = never,
> {
  readonly api: HttpApi.HttpApi<"auth", AllGroups<P, Extra>>;
  /**
   * AR-003: `api` minus the admin-tier groups (`AuthPlugin.isAdminTier`) — what a host
   * serves on its public listener when it firewalls the admin surface separately.
   * Handlers still come from the one composed `layer`; serving fewer groups needs no more.
   */
  readonly publicApi: HttpApi.HttpApi<"auth", Exclude<AllGroups<P, Extra>, AuthPlugin.AdminTierGroup>>;
  /** AR-003: only the admin-tier groups, for a separate listener/port (empty when no plugin has one). */
  readonly adminApi: HttpApi.HttpApi<"auth", Extract<AllGroups<P, Extra>, AuthPlugin.AdminTierGroup>>;
  /**
   * MA-005: the folded plugin layers with the composition's one `SlotsRegistry`
   * provided (and exposed in `ROut`, for introspection) — `Slots.override` requires it.
   */
  readonly layer: ProvideMerged<FoldLayer<P>, typeof Slots.layer>;
  readonly migrations: Migrations;
  readonly manifest: Manifest;
}

// ---------------------------------------------------------------------------
// make — BEH-EA-009, BEH-EA-016
// ---------------------------------------------------------------------------

/**
 * BEH-EA-016: topological order over `dependsOn` (Kahn's algorithm), so
 * migrations run dependencies-first; a leftover, non-empty remainder after
 * the pass means a cycle, reported with the full path via a DFS restricted to
 * that remainder.
 */
const linkPlugins = (plugins: ReadonlyArray<AuthPlugin.Any>): ReadonlyArray<AuthPlugin.Any> => {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin] as const));
  const indegree = new Map<string, number>(plugins.map((plugin) => [plugin.id, 0]));
  const dependents = new Map<string, Array<string>>(plugins.map((plugin) => [plugin.id, []]));

  for (const plugin of plugins) {
    for (const dep of plugin.dependsOn) {
      if (!byId.has(dep.id)) continue; // refused by `Validate<P>`'s `MissingDep` check already
      indegree.set(plugin.id, (indegree.get(plugin.id) ?? 0) + 1);
      dependents.get(dep.id)?.push(plugin.id);
    }
  }

  const queue = plugins
    .filter((plugin) => indegree.get(plugin.id) === 0)
    .map((plugin) => plugin.id);
  const order: Array<string> = [];
  while (queue.length > 0) {
    const id = assertDefined(
      queue.shift(),
      "queue.shift() returned undefined inside a length-checked loop",
    );
    order.push(id);
    for (const dependentId of dependents.get(id) ?? []) {
      const next = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) queue.push(dependentId);
    }
  }

  if (order.length !== plugins.length) {
    const remaining = new Set(
      plugins.map((plugin) => plugin.id).filter((id) => !order.includes(id)),
    );
    const cycle = findCycle(remaining, byId);
    throw new CircularPluginDependency({
      cycle,
      message: `awthaq: circular plugin dependency: ${cycle.join(" -> ")}`,
    });
  }

  return order.map((id) =>
    assertDefined(byId.get(id), `byId is missing plugin "${id}" from its own key set`),
  );
};

/** JH-007: every `readsTables` entry owned by an installed plugin needs that plugin in the reader's `dependsOn`. */
const checkTableDependencies = (plugins: ReadonlyArray<AuthPlugin.Any>): void => {
  const ownerOf = new Map<string, AuthPlugin.Any>();
  for (const plugin of plugins) {
    for (const table of plugin.tables) ownerOf.set(table, plugin);
  }
  for (const plugin of plugins) {
    for (const table of plugin.readsTables ?? []) {
      const owner = ownerOf.get(table);
      if (owner === undefined || owner.id === plugin.id) continue;
      if (plugin.dependsOn.some((dep) => dep.id === owner.id)) continue;
      throw new UndeclaredTableDependency({
        pluginId: plugin.id,
        ownerId: owner.id,
        table,
        message: `awthaq: plugin "${plugin.id}" reads table "${table}" owned by plugin "${owner.id}" but does not list it in dependsOn`,
      });
    }
  }
};

const findCycle = (
  remaining: Set<string>,
  byId: Map<string, AuthPlugin.Any>,
): ReadonlyArray<string> => {
  const [start] = remaining;
  if (start === undefined) {
    throw new LinkerInvariantViolation({
      message: "awthaq: internal error — findCycle called with no remaining plugins",
    });
  }
  const path: Array<string> = [];
  const seenAt = new Map<string, number>();
  let current = start;
  while (!seenAt.has(current)) {
    seenAt.set(current, path.length);
    path.push(current);
    const plugin = assertDefined(
      byId.get(current),
      `byId is missing plugin "${current}" from its own key set`,
    );
    const next = plugin.dependsOn.find((dep) => remaining.has(dep.id));
    current = assertDefined(
      next,
      `plugin "${current}" has no dependency left in the remaining cycle set`,
    ).id;
  }
  return [
    ...path.slice(assertDefined(seenAt.get(current), `seenAt never recorded "${current}"`)),
    current,
  ];
};

/** BEH-EA-016: core first (none yet, see the module header), then plugins in dependency order, keys re-written `NNNN_<plugin>_<name>`. */
const renumberMigrations = (order: ReadonlyArray<AuthPlugin.Any>): Migrations => {
  const out: Array<Migrations[number]> = [];
  let index = 0;
  for (const plugin of order) {
    for (const migration of plugin.migrations) {
      index += 1;
      out.push({
        ...migration,
        name: `${String(index).padStart(4, "0")}_${plugin.id}_${migration.name}`,
      });
    }
  }
  return out;
};

const buildHooks = (
  order: ReadonlyArray<AuthPlugin.Any>,
): Readonly<Record<string, ReadonlyArray<ManifestTap>>> => {
  const byPoint = new Map<
    string,
    Array<{ readonly owner: AuthPlugin.Any; readonly order: number }>
  >();
  for (const plugin of order) {
    for (const tap of plugin.taps ?? []) {
      const entries = byPoint.get(tap.point) ?? [];
      entries.push({ owner: plugin, order: tap.order });
      byPoint.set(tap.point, entries);
    }
  }
  return Object.fromEntries(
    [...byPoint].map(([point, entries]) => [
      point,
      entries
        .toSorted(HookPoint.compareTaps)
        .map((entry) => ({ plugin: entry.owner.id, order: entry.order })),
    ]),
  );
};

const buildManifest = (order: ReadonlyArray<AuthPlugin.Any>): Manifest => ({
  plugins: order.map((plugin) => ({
    id: plugin.id,
    apiVersion: plugin.apiVersion,
    tables: plugin.tables,
    dependsOn: plugin.dependsOn.map((dep) => dep.id),
    groups: Object.values(plugin.contract.groups).map((group) => group.identifier),
  })),
  hooks: buildHooks(order),
  config: order.flatMap((plugin) =>
    (plugin.config ?? []).map((descriptor) => ({ pluginId: plugin.id, descriptor })),
  ),
});

const hasRoute = (endpoint: object): endpoint is { readonly method: string; readonly path: string } =>
  "method" in endpoint &&
  typeof endpoint.method === "string" &&
  "path" in endpoint &&
  typeof endpoint.path === "string";

/** MW-002: the pseudo-owner id core's own groups are attributed to in a conflict message. */
const CORE_OWNER = "core";

/** MW-002: the host's own non-plugin groups (qadi's subject group), attributed to this id. */
const HOST_OWNER = "host";

interface Contribution {
  readonly ownerId: string;
  readonly group: HttpApiGroup.Constraint;
}

/**
 * MW-002 (wayfinder ticket 26): every group `Auth.make` serves, in one list —
 * core's own `session`/`account` groups first, then the host's `extraGroups`,
 * then each plugin's from its own `contract`. One served document, so a plugin
 * cannot shadow a core route: the duplicate-id and duplicate-route refusals
 * below cover core exactly as they cover any two plugins.
 */
const contributionsOf = (
  order: ReadonlyArray<AuthPlugin.Any>,
  extraGroups: ReadonlyArray<HttpApiGroup.Constraint>,
): ReadonlyArray<Contribution> => [
  ...Object.values(AuthCore.AuthCoreApi.groups).map((group) => ({ ownerId: CORE_OWNER, group })),
  ...extraGroups.map((group) => ({ ownerId: HOST_OWNER, group })),
  ...order.flatMap((plugin) =>
    Object.values(plugin.contract.groups).map((group) => ({ ownerId: plugin.id, group })),
  ),
];

/**
 * Every contributed group, added in one call —
 * `HttpApiGroup.Constraint` values, read straight off each `HttpApi`, prove
 * `.add`'s non-empty-tuple parameter through the `firstGroup === undefined`
 * check below rather than an assertion. `HttpApi`'s `Groups` parameter is
 * invariant, so `HttpApi.make("auth")` alone (`Groups = never`) is not a
 * `HttpApi<"auth", HttpApiGroup.Constraint>` no matter how it is produced —
 * meaning composing zero plugins has no well-typed value to return, which is
 * also true as a product matter (there is no such thing as an `Auth` with no
 * plugins), so it is refused for real, not worked around.
 */
const composeApi = (
  order: ReadonlyArray<AuthPlugin.Any>,
  extraGroups: ReadonlyArray<HttpApiGroup.Constraint>,
): HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
  // Core's groups are always present now, so the empty-tuple refusal is explicit.
  if (order.length === 0) {
    throw new EmptyPluginTuple({ message: "awthaq: Auth.make requires at least one plugin" });
  }
  const contributions = contributionsOf(order, extraGroups);
  // BEH-EA-032: refuse a duplicate group id ourselves — `HttpApi.add`'s own
  // last-wins semantics would otherwise silently drop the first
  // contributor's endpoints.
  const ownerOf = new Map<string, string>();
  for (const { ownerId, group } of contributions) {
    const owner = ownerOf.get(group.identifier);
    if (owner !== undefined) {
      throw new GroupIdConflict({
        groupId: group.identifier,
        firstPluginId: owner,
        secondPluginId: ownerId,
        message: `awthaq: E_GROUP_CONFLICT: group "${group.identifier}" contributed by plugin "${owner}" and plugin "${ownerId}"`,
      });
    }
    ownerOf.set(group.identifier, ownerId);
  }
  // AVS-004: a group id is not the only thing two plugins can collide on —
  // refuse a duplicate (method, path) across every contributed endpoint.
  const routeOwner = new Map<string, string>();
  for (const { ownerId, group } of contributions) {
    for (const endpoint of Object.values(group.endpoints)) {
      // `HttpApiGroup.Constraint` widens each endpoint past its method/path.
      if (!hasRoute(endpoint)) continue;
      const route = `${endpoint.method} ${endpoint.path}`;
      const owner = routeOwner.get(route);
      if (owner !== undefined) {
        throw new RouteConflict({
          method: endpoint.method,
          path: endpoint.path,
          firstPluginId: owner,
          secondPluginId: ownerId,
          message: `awthaq: E_ROUTE_CONFLICT: ${route} contributed by plugin "${owner}" and plugin "${ownerId}"`,
        });
      }
      routeOwner.set(route, ownerId);
    }
  }
  const [firstGroup, ...restGroups] = contributions.map((contribution) => contribution.group);
  if (firstGroup === undefined) {
    throw new EmptyPluginTuple({ message: "awthaq: Auth.make requires at least one plugin" });
  }
  return HttpApi.make("auth").add(firstGroup, ...restGroups);
};

/**
 * AR-003: the groups of the composed api on one side of the admin tier, as its
 * own `HttpApi`. Unlike `composeApi`, an empty side is legitimate (a composition
 * with no admin group has nothing to firewall), hence the union with the
 * no-groups `HttpApi`; the precise per-tier type is `Built<P>`'s, as for `api`.
 * Core's and the host's own groups are public-tier (their ids carry no `admin`).
 */
const composeTier = (
  order: ReadonlyArray<AuthPlugin.Any>,
  extraGroups: ReadonlyArray<HttpApiGroup.Constraint>,
  admin: boolean,
): HttpApi.HttpApi<"auth", never> | HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
  const groups = contributionsOf(order, extraGroups)
    .map((contribution) => contribution.group)
    .filter((group) => AuthPlugin.isAdminTier(group.identifier) === admin);
  const [firstGroup, ...restGroups] = groups;
  return firstGroup === undefined
    ? HttpApi.make("auth")
    : HttpApi.make("auth").add(firstGroup, ...restGroups);
};

/**
 * `Layer.provideMerge` folded left over the first plugin's own `layer`, in
 * `order`'s topological order (dependencies before dependents): each new
 * plugin is provided everything folded in so far, so a later plugin's
 * requirement on an earlier one is actually satisfied, not merely left
 * standing next to it — plain `Layer.merge` only unions `ROut`/`RIn` and
 * never lets one merged layer satisfy another's requirement, which would
 * leave every plugin's own dependencies in the composed `layer`'s `RIn`
 * instead of resolving them.
 *
 * Seeding the fold with `Layer.empty` (`Layer<never, never, never>`) instead
 * of the first plugin's own `layer` does not type-check: `never` is `Layer`'s
 * own "nothing provided/required" value, not a stand-in for "any
 * `ROut`/`E`/`RIn`", so it fails the same contravariant `ROut` check that
 * makes a zero-plugin `Auth.make` have no well-typed `layer` in the first
 * place (see `composeApi`'s own comment) — the fold starts from a real
 * plugin's layer instead, and requires at least one.
 */
const composeLayer = (
  order: ReadonlyArray<AuthPlugin.Any>,
): Layer.Layer<never, unknown, unknown> => {
  const [first, ...rest] = order;
  if (first === undefined) {
    throw new EmptyPluginTuple({ message: "awthaq: Auth.make requires at least one plugin" });
  }
  const folded = rest.reduce((acc, plugin) => Layer.provideMerge(plugin.layer, acc), first.layer);
  // MA-005: one registry per composition, shared by every plugin's `Slots.override`,
  // so a second claim on a slot is always a `SlotConflict` — not only when a host
  // remembered to provide `Slots.layer` itself.
  return Layer.provideMerge(folded, Slots.layer);
};

/**
 * A tuple with at least one plugin. `composeApi`/`composeLayer` each have no
 * well-typed value to return for zero plugins (`HttpApi`'s `Groups` and
 * `Layer`'s `ROut` are both required to be *something*, and there is no such
 * thing as an `Auth` with no plugins as a product matter either) — rather
 * than let that surface only as `EmptyPluginTuple` at runtime, `Auth.make`'s
 * own parameter type refuses an empty array the same way `Validate<P>`
 * refuses a duplicate id or a missing dependency: as a type error, before
 * `Auth.make` is ever called.
 *
 * Exported (not module-private): `@awthaq/test`'s `TestAuth.layer`
 * forwards to `Auth.make` and needs the identical overload shape —
 * `Validate<P>`/`Built<P>`/`NonEmptyPlugins` together — to preserve the same
 * per-plugin literal type inference and the same `Validate<P>` compile-time
 * error messages, rather than declaring a second, structurally-equal-but-
 * separately-named copy of this type.
 */
export type NonEmptyPlugins = readonly [AuthPlugin.Any, ...ReadonlyArray<AuthPlugin.Any>];

/**
 * MW-002: groups the host serves in the same document that no plugin owns —
 * `@awthaq/qadi`'s `SubjectApi.SubjectGroup` is the shipped case. Typed, so
 * `Built<P, Extra>["api"]` names them (a client built over `api` sees them).
 * Their handlers are the host's to provide, like a plugin's are its own.
 */
export interface MakeOptions<Extra extends HttpApiGroup.Constraint> {
  readonly extraGroups?: ReadonlyArray<Extra>;
}

/**
 * BEH-EA-009: computes `api`, `layer`, `migrations`, and `manifest` from one
 * plugin tuple. `plugins` must already satisfy `Validate<P>` — a tuple with a
 * duplicate id, a missing dependency, or no plugins at all fails to
 * type-check before this function is ever called (BEH-EA-010, BEH-EA-011,
 * `NonEmptyPlugins`).
 *
 * Declared as an overload rather than one generic arrow function so the
 * *implementation* can be typed against a plain `ReadonlyArray<AuthPlugin.Any>`
 * — `Validate<P>` cannot be simplified back to `P` inside a still-generic
 * function body (P is abstract at that point), and bridging that gap with a
 * cast is exactly what this module does not do.
 */
export function make<
  const P extends NonEmptyPlugins,
  const Extra extends HttpApiGroup.Constraint = never,
>(plugins: Validate<P>, options?: MakeOptions<Extra>): Built<P, Extra>;
export function make(
  plugins: ReadonlyArray<AuthPlugin.Any>,
  options?: MakeOptions<HttpApiGroup.Constraint>,
) {
  const order = linkPlugins(plugins);
  checkTableDependencies(order);
  const extraGroups = options?.extraGroups ?? [];
  return {
    api: composeApi(order, extraGroups),
    publicApi: composeTier(order, extraGroups, false),
    adminApi: composeTier(order, extraGroups, true),
    layer: composeLayer(order),
    migrations: renumberMigrations(order),
    manifest: buildManifest(order),
  };
}
