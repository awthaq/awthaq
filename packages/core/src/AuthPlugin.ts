// @awthaq/core — AuthPlugin
//
// spec/behaviors/01-plugin-contract.md, BEH-EA-001 through BEH-EA-008.
// awthaq is pre-implementation (spec/README.md); this module is the
// first real piece of it — the signatures below are meant to run, not merely
// to type-check as design rationale the way archive/design/plugins-as-layers.md
// does.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Record from "effect/Record";
import type * as Scope from "effect/Scope";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as HookPoint from "./HookPoint.ts";
import type { ConfigDescriptor } from "./ConfigDescriptor.ts";
import type { Migrations } from "./Migrations.ts";
import * as UserFields from "./UserFields.ts";

/**
 * BEH-EA-004: a plugin's contract groups are confined to its own id or a
 * dotted sub-id of it, checked where the plugin's `contract` is declared.
 */
// `any, any` here — not `HttpApiEndpoint.Constraint, boolean` — matches
// `spec/behaviors/01-plugin-contract.md`'s BEH-EA-004 code block verbatim.
// `GroupsFor<Id>` is a *constraint*: `Groups extends GroupsFor<Id>` must
// accept every real, concrete `HttpApiGroup<Id, ConcreteEndpoints, ...>` a
// plugin author writes, and `HttpApiGroup`'s `Endpoints` parameter is
// invariant (`in out`) — the same reason `AuthPlugin.Any`'s own `contract`
// cannot be typed via `HttpApiGroup.Constraint` (see that interface's own
// comment): a concrete plugin's group is never assignable to one built from
// the widened `Constraint` bound instead of `any`.
/* oxlint-disable no-explicit-any */
export type GroupsFor<Id extends string> = HttpApiGroup.HttpApiGroup<
  Id | `${Id}.${string}`,
  any,
  any
>;
/* oxlint-enable no-explicit-any */

/**
 * AR-003: a contract group is *admin-tier* when any dot-separated segment of
 * its identifier is `admin` (`admin`, `admin.tenants`, `billing.admin`). BEH-EA-004
 * already confines a group id to its plugin's id or a dotted sub-id, so the
 * tier needs no extra declaration — it is read off the id, at the type level
 * (`AdminTierId`, what `Auth.make`'s `Built<P>` splits `publicApi`/`adminApi`
 * with) and at runtime (`isAdminTier`, what it composes them with), and the
 * two definitions agree by construction.
 */
export type AdminTierId =
  | "admin"
  | `admin.${string}`
  | `${string}.admin`
  | `${string}.admin.${string}`;

export const isAdminTier = (identifier: string): boolean => identifier.split(".").includes("admin");

/* oxlint-disable no-explicit-any */
/** AR-003: the admin-tier groups of a contract's group union (the `any, any` is `GroupsFor`'s own, for the same invariance reason). */
export type AdminTierGroup = HttpApiGroup.HttpApiGroup<AdminTierId, any, any>;
/* oxlint-enable no-explicit-any */

/** BEH-EA-002: the compiled service key embeds the plugin's own `id`. */
export type Key<Id extends string> = `awthaq/plugin/${Id}`;

/**
 * BEH-EA-001/002: what `AuthPlugin.Service<Self, Shape>()(id, options)`
 * returns — a normal `Context.ServiceClass` (so a plugin is usable everywhere
 * any other Effect service is: `yield* Plugin`, `Layer.provide`) plus the
 * typed statics `archive/design/plugins-as-layers.md` §2.2 fixes: `id`,
 * `apiVersion`, `contract`, `tables`, `migrations`, `dependsOn`.
 */
export interface Class<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations = {},
> extends Context.ServiceClass<Self, Key<Id>, Shape> {
  readonly id: Id;
  readonly apiVersion: 1;
  readonly contract: HttpApi.HttpApi<"auth", Groups>;
  readonly tables: ReadonlyArray<`${Id}_${string}`>;
  readonly migrations: Migrations;
  readonly dependsOn: ReadonlyArray<Any>;
  /** PERS-003: the taps this plugin declared statically (`AuthPlugin.layer`'s `taps` option), readable without building any layer. */
  readonly taps: ReadonlyArray<DeclaredTap>;
  /** JH-007: tables owned by *other* plugins this one reads; `Auth.make` requires the owner in `dependsOn`. */
  readonly readsTables: ReadonlyArray<string>;
  /** PV-241/BEH-EA-111: the rate-limit rules this plugin declares statically (defaults; config may tune them), readable without building any layer. */
  readonly rateLimits: ReadonlyArray<RateLimitDeclaration>;
  /** PV-241/BEH-EA-202: the keys of the ports this plugin's layer requires (`AuthPlugin.layer`'s `ports` option), readable without building any layer. */
  readonly ports: ReadonlyArray<string>;
  /** ECS-008/BEH-EA-229: the configuration inputs this plugin reads, declared statically (none when it has no policy knobs). */
  readonly config: ReadonlyArray<ConfigDescriptor>;
  /**
   * SAM-004 (BEH-EA-040/048): the typed scalar fields this plugin adds to `users`, declared statically
   * (none when it adds none). The linker generates their columns; see `UserFields`.
   */
  readonly userFields: UserFields.Declarations;
  /**
   * Type-only: the declared fields' own type, which `Auth.UserFieldsOf` folds over a plugin tuple.
   * Never assigned (a plain `userFields` value cannot carry per-key types through a class static
   * without an assertion), so it reads `undefined`.
   */
  readonly "~userFields"?: Fields;
}

/** PV-241: what a rate-limit rule is keyed on, as a label a listing can print (the same set as `RateLimits.EnforceMeta["dimension"]`). */
export type RateLimitDimension = "identity" | "ip" | "principal" | "custom";

/**
 * PV-241/BEH-EA-111: one rate-limit rule declared statically on a plugin (`Service`'s `rateLimits`
 * option), so `awthaq plugin list --rules` can print it without building a layer. The numbers are the
 * plugin's defaults; a configurable plugin may register tuned values at build. `group` is confined at the
 * type level to the plugin's own contract groups (BEH-EA-107 as a compile error, not only a build-time
 * `RateLimitScopeViolation`). The registry stays the source of truth for what is enforced; a plugin's test
 * checks it against this declaration (`RateLimits.declarationDrift`).
 */
export interface RateLimitDeclaration<Group extends string = string> {
  readonly group: Group;
  readonly endpoint: string;
  /** The rule's own name, unique within its group and endpoint (`requestByIp`), as `EnforceMeta.rule` reports it. */
  readonly name: string;
  readonly dimension: RateLimitDimension;
  readonly limit: number;
  readonly window: Duration.Input;
}

/**
 * PV-241: builds a `rateLimits` declaration from a rule table a plugin already keeps for its own
 * enforcement (`PasswordRateLimits.makeRules`, `MagicLink`'s `rules`), so the numbers have one source.
 * `groups` names the plugin's own contract groups; a rule outside them is a definition-time defect
 * (the same refusal `RateLimits.rule` gives at build, raised earlier), and narrowing each rule's `group`
 * to that union needs no type assertion.
 */
export const declareRateLimits = <const Group extends string>(
  groups: ReadonlyArray<Group>,
  rules: Iterable<RateLimitDeclaration>,
): ReadonlyArray<RateLimitDeclaration<Group>> => {
  const declared: Array<RateLimitDeclaration<Group>> = [];
  for (const rule of rules) {
    const group = groups.find((candidate) => candidate === rule.group);
    if (group === undefined) {
      throw new Error(
        `awthaq: rate-limit rule "${rule.name}" names group "${rule.group}", which is not one of [${groups.join(", ")}]`,
      );
    }
    declared.push({
      group,
      endpoint: rule.endpoint,
      name: rule.name,
      dimension: rule.dimension,
      limit: rule.limit,
      window: rule.window,
    });
  }
  return declared;
};

/** PV-241: the group ids of a plugin's contract, the only groups a declared rule may name. */
export type GroupIdOf<Groups> =
  Groups extends HttpApiGroup.HttpApiGroup<infer Id, infer _Endpoints, infer _Error> ? Id : never;

/** PERS-003: a statically declared tap, as far as `Auth.make`'s manifest needs it. */
export interface DeclaredTap {
  readonly point: string;
  readonly order: number;
}

/**
 * Everything `Auth.make` (`../Auth.ts`) reads off an arbitrary, heterogeneous
 * plugin. Deliberately its own interface, not `Class<any, string, any, X>`
 * for any choice of `X`: `HttpApi`'s `Groups` parameter is invariant and
 * self-referential through `prefix`/`middleware`/etc., so there is no single
 * `X` a concrete `HttpApi<"auth", ConcreteGroups>` is ever assignable to or
 * from (tried `HttpApiGroup.Constraint`, `any`, and `HttpApiGroup.Top` in
 * turn — all three fail for a real, non-empty contract). `Auth.make` never
 * calls a fluent method on a plugin's `contract`, only reads its data
 * (`identifier`, `groups`) to fold into the composed `api`, so `contract`
 * here is typed as exactly that data, which a concrete `HttpApi` value
 * satisfies structurally without needing its methods to unify with anything.
 */
export interface ContractData {
  readonly identifier: "auth";
  readonly groups: Record.ReadonlyRecord<string, HttpApiGroup.Constraint>;
}

export interface Any {
  readonly id: string;
  readonly apiVersion: 1;
  readonly contract: ContractData;
  readonly tables: ReadonlyArray<string>;
  readonly migrations: Migrations;
  readonly dependsOn: ReadonlyArray<Any>;
  /** PERS-003: optional so a hand-built plugin value (a test fixture) need not declare any. */
  readonly taps?: ReadonlyArray<DeclaredTap>;
  /** JH-007: optional here so a hand-built plugin value need not name it. */
  readonly readsTables?: ReadonlyArray<string>;
  /** PV-241: optional so a hand-built plugin value need not declare any. */
  readonly rateLimits?: ReadonlyArray<RateLimitDeclaration>;
  /** PV-241: optional so a hand-built plugin value need not declare any. */
  readonly ports?: ReadonlyArray<string>;
  /** Optional here (a hand-built `Any` may have none); every plugin made with `Service` carries the list. */
  readonly config?: ReadonlyArray<ConfigDescriptor>;
  /** SAM-004: optional so a hand-built plugin value need not declare any; every plugin made with `Service` carries the record. */
  readonly userFields?: UserFields.Declarations;
  readonly layer: Layer.Layer<never, unknown, unknown>;
}

/**
 * A plugin *class* (`typeof Ping`, what `dependsOn: [Ping]` actually holds as
 * a value) and the *service instance* type a `yield* Ping` requires (`Ping`,
 * the bare class name used as a type) are different types in TypeScript.
 * `Context.ServiceClass` makes the class itself `Effect<Shape, never, Self>`
 * (`Self` being that instance type), so recovering `Self` from a class VALUE
 * is a matter of reading it back off that `Effect` shape — needed so
 * `dependsOn`'s classes join a layer's `RIn` as the same type `make`'s own
 * `yield* Ping` would produce, not as the unrelated constructor type.
 */
export type InstanceOf<P> = P extends Effect.Effect<unknown, unknown, infer Self> ? Self : never;

/**
 * `dependsOn` is declared `readonly` on `Class` (BEH-EA-007: static members are
 * frozen) but is only known once `AuthPlugin.layer` runs, after `Service` has
 * already returned the class. A side table plus a getter gives every plugin a
 * real, readonly-from-the-outside `dependsOn` without ever assigning through
 * the readonly field or asserting a type onto it.
 */
const dependsOnByPlugin = new WeakMap<object, ReadonlyArray<Any>>();

const noDependencies: ReadonlyArray<Any> = [];

/** PERS-003: same side-table-plus-getter arrangement as `dependsOn`, for the same reason — the taps are only known once `AuthPlugin.layer` runs. */
const tapsByPlugin = new WeakMap<object, ReadonlyArray<DeclaredTap>>();

const noTaps: ReadonlyArray<DeclaredTap> = [];

/** PV-241: the declared port keys, kept the same way (known only once `AuthPlugin.layer` runs). */
const portsByPlugin = new WeakMap<object, ReadonlyArray<string>>();

const noPorts: ReadonlyArray<string> = [];

/**
 * ELC-006: `AuthPlugin.layer` was called a second time for one plugin class with a
 * different `dependsOn` set. The side table above is keyed by class identity, so the
 * second call would silently replace the first's ordering and typed requirements —
 * `Auth.make` would then sort and check against whichever registration ran last.
 * Thrown at definition time (module load), like `Auth.ts`'s `LinkerInvariantViolation`:
 * it is a plugin-authoring defect, not a runtime condition.
 */
export class ConflictingDependsOn extends Data.TaggedError("ConflictingDependsOn")<{
  readonly pluginId: string;
  readonly first: ReadonlyArray<string>;
  readonly second: ReadonlyArray<string>;
  readonly message: string;
}> {}

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * BEH-EA-001 through BEH-EA-007: builds the plugin's compiled service key and
 * freezes its static, declarative members. `options.tables`/`migrations` are
 * read off the class alone — no `Layer` is evaluated to produce them (BEH-EA-006).
 */
export const Service =
  <Self, Shape>() =>
  <
    const Id extends string,
    Groups extends GroupsFor<Id>,
    const Fields extends UserFields.Declarations = {},
  >(
    id: Id,
    options: {
      readonly apiVersion: 1;
      readonly contract: HttpApi.HttpApi<"auth", Groups>;
      readonly tables?: ReadonlyArray<`${NoInfer<Id>}_${string}`>;
      readonly migrations?: Migrations;
      readonly readsTables?: ReadonlyArray<string>;
      /**
       * PV-241/BEH-EA-111: the rate-limit rules this plugin enforces, declared statically so `plugin list
       * --rules` prints them without building a layer. Each rule's `group` must be one of this plugin's own
       * contract groups (a compile error otherwise); the numbers are the defaults a config may tune.
       */
      readonly rateLimits?: ReadonlyArray<RateLimitDeclaration<NoInfer<GroupIdOf<Groups>>>>;
      /** ECS-008/BEH-EA-229: descriptors of the `Context.Reference`s this plugin reads (`ConfigDescriptor.make`). */
      readonly config?: ReadonlyArray<ConfigDescriptor>;
      /**
       * SAM-004/BEH-EA-040/048: nullable scalar columns this plugin adds to `users`, `{ plan:
       * UserFields.serverOnly(Schema.Literals(["free", "pro"])) }` for a column `<id>_plan`. The linker
       * (`Auth.make`) generates the migration; a field is client-writable unless declared otherwise.
       * Validated here, at definition time: a schema that is not one scalar throws `InvalidDeclaration`.
       */
      readonly userFields?: Fields;
    },
  ): Class<Self, Id, Shape, Groups, Fields> => {
    const key: Key<Id> = `awthaq/plugin/${id}`;
    const userFields: UserFields.Declarations = options.userFields ?? {};
    UserFields.describePlugin(id, userFields);
    const serviceKey = Context.Service<Self, Shape>()(key);
    // `Object.assign`'s source is a plain-valued `dependsOn` (not a getter): a
    // getter here would be *invoked immediately* by `Object.assign` itself (it
    // copies property values, not accessors), reading `dependsOnByPlugin` before
    // `plugin` even exists to be its own key. `Object.assign` is what gives
    // `plugin` its precise `Class<Self, Id, Shape, Groups>` type (its signature
    // computes a real `T & U` intersection); `Object.defineProperty` below,
    // which does not widen a type this way, only needs to install the real,
    // live getter afterward, once `plugin` can be its own map key.
    const plugin = Object.assign(serviceKey, {
      id,
      apiVersion: options.apiVersion,
      contract: options.contract,
      tables: options.tables ?? [],
      migrations: options.migrations ?? [],
      readsTables: options.readsTables ?? [],
      rateLimits: options.rateLimits ?? [],
      config: options.config ?? [],
      userFields,
      dependsOn: noDependencies,
      taps: noTaps,
      ports: noPorts,
    });
    // A regular (not arrow) function, so `this` is whatever the getter is
    // actually read off — `Pong`, say, when a subclass reads `Pong.dependsOn` —
    // rather than the arrow-captured `plugin` above. `dependsOn` is inherited
    // through the subclass's static prototype chain from `plugin`, but static
    // property access still binds `this` to the original receiver (`Pong`),
    // which is also the identity `AuthPlugin.layer` keys `dependsOnByPlugin` by.
    const withLiveDependsOn = Object.defineProperty(plugin, "dependsOn", {
      enumerable: true,
      configurable: true,
      get(this: object): ReadonlyArray<Any> {
        return dependsOnByPlugin.get(this) ?? noDependencies;
      },
    });
    const withLiveTaps = Object.defineProperty(withLiveDependsOn, "taps", {
      enumerable: true,
      configurable: true,
      get(this: object): ReadonlyArray<DeclaredTap> {
        return tapsByPlugin.get(this) ?? noTaps;
      },
    });
    return Object.defineProperty(withLiveTaps, "ports", {
      enumerable: true,
      configurable: true,
      get(this: object): ReadonlyArray<string> {
        return portsByPlugin.get(this) ?? noPorts;
      },
    });
  };

/** PERS-003: the hook points a `taps` option's declarations tap — they join the plugin layer's `RIn`, exactly like a port. */
export type TapPoints<Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>>> =
  Taps[number] extends infer Declaration
    ? Declaration extends HookPoint.TapDeclaration<infer Point>
      ? Point
      : never
    : never;

/**
 * PV-241/BEH-EA-202: a port is a `Context.Service` class whose key names a `/ports/` service
 * (`awthaq/ports/Mailer`). `ports` declares the ones a plugin's layer requires: they join its `RIn`
 * exactly like `dependsOn`, and their keys are what the manifest and `plugin list --graph` print.
 */
export interface PortClass {
  readonly key: string;
}

/** PV-241: the keys of the port services among a requirement union (`awthaq/ports/...`, or any `.../ports/...` a third party defines). */
export type PortKeysOf<R> = R extends { readonly key: infer K extends string }
  ? K extends `${string}/ports/${string}`
    ? K
    : never
  : never;

/** PV-241: the ports `R` requires that `Ports` does not declare. */
export type MissingPorts<R, Ports extends ReadonlyArray<PortClass>> = Exclude<
  PortKeysOf<R>,
  Ports[number]["key"]
>;

/**
 * PV-241: completeness of the `ports` declaration, checked where `AuthPlugin.layer` is called. Nothing
 * when every port the layer requires is declared; otherwise `ports` becomes a required property whose
 * type names the missing keys, so the compiler's message says which port to add.
 */
export type PortsComplete<R, Ports extends ReadonlyArray<PortClass>> = [
  MissingPorts<R, Ports>,
] extends [never]
  ? unknown
  : { readonly ports: { readonly "declare these required ports": MissingPorts<R, Ports> } };

/**
 * BEH-EA-008: `dependsOn` declares both migration ordering and a typed
 * requirement in one array — every class it lists joins the returned layer's
 * `RIn`. `handlers` (when given) is provided the plugin's own service, so
 * handler implementations may depend on it; its `HttpApiGroup.ToService`
 * requirement joins this layer's `ROut`, which is what makes `auth.api` and
 * `auth.layer` (`../Auth.ts`) provably consistent (BEH-EA-013): a plugin's own
 * `contract` and its own `layer` are two views of the same `AuthPlugin.layer`
 * call, not independently authored facts that could disagree.
 *
 * Generic over `Self`/`Id`/`Shape`/`Groups` directly — matched against
 * `plugin`'s real `Class<Self, Id, Shape, Groups>` shape — rather than a
 * single `P extends Base` bound with those positions pre-widened to `any`.
 * `Context.ServiceClass`'s `Self`/`Shape` and `HttpApi`'s `Groups` are all
 * invariant type parameters (checked exactly both ways, not just "assignable
 * from"), so a *shared* widened bound can only ever be inhabited by using
 * `any` there in the first place; four free type parameters, solved
 * separately from the one concrete `plugin` argument, need no such widening
 * and carry no `any` at all. This also removes the circularity `Any` (which
 * requires `layer`) would create: a plugin's own
 * `static readonly layer = AuthPlugin.layer(Self, {...})` refers to `Self`
 * inside its own initializer (BEH-EA-008's own example does exactly this),
 * and none of `Self`/`Id`/`Shape`/`Groups` depend on `Self` already having a
 * `layer`.
 *
 * Declared as an overload, one signature per whether `handlers` is given:
 * `Layer`'s `ROut` is contravariant, so a function returning `own` alone
 * when there are no handlers is not assignable to a *single* signature
 * declaring `ROut` as `Self | ToService<...>` unconditionally — that union is
 * only ever true of the *other* branch. The implementation itself is typed
 * against the same real bounds as both public overloads, with no explicit
 * return type, so its own body is checked against whatever the ternary
 * naturally infers instead of against either overload's more precise,
 * branch-specific type.
 */
export function layer<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  E,
  R,
  HE,
  HR,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
>(
  plugin: Class<Self, Id, Shape, Groups>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly make: Effect.Effect<Shape, E, R>;
    readonly handlers: Layer.Layer<HttpApiGroup.ToService<"auth", Groups>, HE, HR>;
  } & PortsComplete<R | HR | CR, Ports>,
): Layer.Layer<
  Self | HttpApiGroup.ToService<"auth", Groups>,
  E | HE | CE,
  | Exclude<R, Scope.Scope>
  | Exclude<HR, Self>
  | InstanceOf<Deps[number]>
  | InstanceOf<Ports[number]>
  | TapPoints<Taps>
  | Exclude<CR, Self | HttpApiGroup.ToService<"auth", Groups>>
>;
export function layer<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  E,
  R,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
>(
  plugin: Class<Self, Id, Shape, Groups>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly make: Effect.Effect<Shape, E, R>;
  } & PortsComplete<R | CR, Ports>,
): Layer.Layer<
  Self,
  E | CE,
  | Exclude<R, Scope.Scope>
  | InstanceOf<Deps[number]>
  | InstanceOf<Ports[number]>
  | TapPoints<Taps>
  | Exclude<CR, Self>
>;
export function layer<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  E,
  R,
  HE = never,
  HR = never,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
>(
  plugin: Class<Self, Id, Shape, Groups>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly make: Effect.Effect<Shape, E, R>;
    readonly handlers?: Layer.Layer<HttpApiGroup.ToService<"auth", Groups>, HE, HR>;
  },
) {
  const dependsOn = options.dependsOn ?? noDependencies;
  const registered = dependsOnByPlugin.get(plugin);
  if (registered !== undefined) {
    // Order-insensitive: `[A, B]` and `[B, A]` are the same dependency set.
    const first = registered.map((dep) => dep.id).sort();
    const second = dependsOn.map((dep) => dep.id).sort();
    if (!sameIds(first, second)) {
      throw new ConflictingDependsOn({
        pluginId: plugin.id,
        first,
        second,
        message: `awthaq: plugin "${plugin.id}" registered a second AuthPlugin.layer with dependsOn [${second.join(", ")}], but its first registration had [${first.join(", ")}]`,
      });
    }
  }
  dependsOnByPlugin.set(plugin, dependsOn);
  const taps = options.taps ?? [];
  tapsByPlugin.set(
    plugin,
    taps.map((declaration) => ({ point: declaration.point, order: declaration.order })),
  );
  // A variant layer that names no `ports` (BEH-EA-019's second `layer` of one class) leaves the first declaration alone.
  if (options.ports !== undefined) {
    portsByPlugin.set(
      plugin,
      options.ports.map((port) => port.key),
    );
  }
  const own = Layer.effect<Self, Shape, E, R>(plugin, options.make);
  const withHandlers = options.handlers ? Layer.provideMerge(options.handlers, own) : own;
  // A plugin's other registry contributions (its erasure/export sections, rate-limit
  // rules, ...): built over the plugin's own service, and what else they require joins
  // this layer's `RIn`.
  const withContributions =
    options.contributes === undefined
      ? withHandlers
      : Layer.provideMerge(options.contributes, withHandlers);
  if (taps.length === 0) return withContributions;
  // PERS-003: the plugin installs its own taps as its own owner, so the
  // runtime chain orders them by this plugin's place in the composition.
  const installed = taps.reduce<Layer.Layer<never, never, unknown>>(
    (acc, declaration) => Layer.merge(acc, declaration.install(plugin)),
    Layer.empty,
  );
  return Layer.merge(withContributions, installed);
}
