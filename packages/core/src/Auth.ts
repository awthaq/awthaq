// @awthaq/core — Auth
//
// spec/behaviors/02-plugin-composition-validate.md, BEH-EA-009 through
// BEH-EA-016. awthaq is pre-implementation (spec/README.md); this module
// composes real `AuthPlugin` values, it does not merely type them.
//
// Scoped deliberately smaller than the full design in
// archive/design/plugins-as-layers.md §4: `AuthCore` (the fixed
// Users/Accounts/Sessions/Verification/Authentication/Csrf/SessionView tuple,
// §6) does not exist until M1 Core lands, so `Auth.make` does not yet prepend
// it; `AuthPlugin.Variant` (BEH-EA-019, spec/behaviors/03-ports-slots-hooks-registries.md)
// and the `SlotConflict<P>` check it would need do not exist until Slots
// (BEH-EA-017+) land either. What is implemented here — `Validate<P>`'s
// `DuplicateId` and `MissingDep` checks (BEH-EA-010, BEH-EA-011), computing
// `api` and `layer` from the same tuple (BEH-EA-009, BEH-EA-013), and the
// runtime cycle detection and migration ordering (BEH-EA-016) — is real and
// exercised by `test/Auth.test.ts`.

import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AuthPlugin from "./AuthPlugin.ts";
import type { Migrations } from "./Migrations.ts";

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
 * BEH-EA-009/010/011: a plugin tuple is accepted as-is only once it has no
 * duplicate id and no dependency missing from the same tuple; otherwise the
 * argument type narrows to a literal object naming the problem, so passing
 * the tuple to `Auth.make` fails to type-check with a readable message
 * (`archive/design/plugins-as-layers.md` §4.3) instead of an opaque mismatch.
 */
export type Validate<P extends ReadonlyArray<AuthPlugin.Any>> = [DuplicateId<P>] extends [never]
  ? [MissingDep<P>] extends [never]
    ? P
    : MissingDep<P> extends readonly [infer Dep extends string, infer By extends string]
      ? {
          readonly awthaq: `plugin "${By}" depends on plugin "${Dep}", which is not in the list`;
        }
      : never
  : { readonly awthaq: `plugin id "${DuplicateId<P>}" appears more than once` };

// ---------------------------------------------------------------------------
// Built<P> — BEH-EA-009, BEH-EA-013
// ---------------------------------------------------------------------------

export interface ManifestPlugin {
  readonly id: string;
  readonly apiVersion: 1;
  readonly tables: ReadonlyArray<string>;
  readonly dependsOn: ReadonlyArray<string>;
}

/** BEH-EA-016: read off the composed classes, never authored (`archive/design/plugins-as-layers.md` §7). */
export interface Manifest {
  readonly plugins: ReadonlyArray<ManifestPlugin>;
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
 * what already provides it. This only matches `composeLayer`'s *runtime*
 * fold — which runs on `linkPlugins`' topologically sorted order, so it is
 * correct regardless of the order plugins were passed in — when `P` itself
 * already lists dependencies before dependents; `Auth.make`'s own examples,
 * and `test/AuthPlugin.test.ts`, do exactly that.
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
export interface Built<P extends ReadonlyArray<AuthPlugin.Any>> {
  readonly api: HttpApi.HttpApi<"auth", GroupsOf<P[number]>>;
  /**
   * AR-003: `api` minus the admin-tier groups (`AuthPlugin.isAdminTier`) — what a host
   * serves on its public listener when it firewalls the admin surface separately.
   * Handlers still come from the one composed `layer`; serving fewer groups needs no more.
   */
  readonly publicApi: HttpApi.HttpApi<
    "auth",
    Exclude<GroupsOf<P[number]>, AuthPlugin.AdminTierGroup>
  >;
  /** AR-003: only the admin-tier groups, for a separate listener/port (empty when no plugin has one). */
  readonly adminApi: HttpApi.HttpApi<
    "auth",
    Extract<GroupsOf<P[number]>, AuthPlugin.AdminTierGroup>
  >;
  readonly layer: FoldLayer<P>;
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

const buildManifest = (order: ReadonlyArray<AuthPlugin.Any>): Manifest => ({
  plugins: order.map((plugin) => ({
    id: plugin.id,
    apiVersion: plugin.apiVersion,
    tables: plugin.tables,
    dependsOn: plugin.dependsOn.map((dep) => dep.id),
  })),
});

/**
 * Every group of every plugin's own `contract`, added in one call —
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
): HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
  const contributions = order.flatMap((plugin) =>
    Object.values(plugin.contract.groups).map((group) => ({ plugin, group })),
  );
  // BEH-EA-032: refuse a duplicate group id ourselves — `HttpApi.add`'s own
  // last-wins semantics would otherwise silently drop the first
  // contributor's endpoints.
  const ownerOf = new Map<string, AuthPlugin.Any>();
  for (const { plugin, group } of contributions) {
    const owner = ownerOf.get(group.identifier);
    if (owner !== undefined) {
      throw new GroupIdConflict({
        groupId: group.identifier,
        firstPluginId: owner.id,
        secondPluginId: plugin.id,
        message: `awthaq: E_GROUP_CONFLICT: group "${group.identifier}" contributed by plugin "${owner.id}" and plugin "${plugin.id}"`,
      });
    }
    ownerOf.set(group.identifier, plugin);
  }
  const groups = contributions.map((contribution) => contribution.group);
  const [firstGroup, ...restGroups] = groups;
  if (firstGroup === undefined) {
    throw new EmptyPluginTuple({ message: "awthaq: Auth.make requires at least one plugin" });
  }
  return HttpApi.make("auth").add(firstGroup, ...restGroups);
};

/**
 * AR-003: the groups of `order`'s contracts on one side of the admin tier, as its
 * own `HttpApi`. Unlike `composeApi`, an empty side is legitimate (a composition
 * with no admin group has nothing to firewall), hence the union with the
 * no-groups `HttpApi`; the precise per-tier type is `Built<P>`'s, as for `api`.
 */
const composeTier = (
  order: ReadonlyArray<AuthPlugin.Any>,
  admin: boolean,
): HttpApi.HttpApi<"auth", never> | HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
  const groups = order
    .flatMap((plugin) => Object.values(plugin.contract.groups))
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
  return rest.reduce((acc, plugin) => Layer.provideMerge(plugin.layer, acc), first.layer);
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
export function make<const P extends NonEmptyPlugins>(plugins: Validate<P>): Built<P>;
export function make(plugins: ReadonlyArray<AuthPlugin.Any>) {
  const order = linkPlugins(plugins);
  return {
    api: composeApi(order),
    publicApi: composeTier(order, false),
    adminApi: composeTier(order, true),
    layer: composeLayer(order),
    migrations: renumberMigrations(order),
    manifest: buildManifest(order),
  };
}
