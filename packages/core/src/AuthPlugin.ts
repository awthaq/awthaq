// @awthaq/core — AuthPlugin
//
// spec/behaviors/01-plugin-contract.md, BEH-EA-001 through BEH-EA-008.
// awthaq is pre-implementation (spec/README.md); this module is the
// first real piece of it — the signatures below are meant to run, not merely
// to type-check as design rationale the way archive/design/plugins-as-layers.md
// does.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Record from "effect/Record";
import type * as Scope from "effect/Scope";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { TenantScoped } from "@awthaq/sql";
import type * as HookPoint from "./HookPoint.ts";
import type * as Hooks from "./Hooks.ts";
import type { ConfigDescriptor } from "./ConfigDescriptor.ts";
import type { Migrations } from "./Migrations.ts";
import * as RateLimitModel from "./RateLimitModel.ts";
import type { RateLimitDeclaration } from "./RateLimitModel.ts";
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
  Limits extends RateLimitModel.Table = {},
  Records extends AnyRecords = NoRecords,
  Points extends Layer.Layer<never, unknown, unknown> = Layer.Layer<never>,
> extends Context.ServiceClass<Self, Key<Id>, Shape> {
  readonly id: Id;
  readonly apiVersion: 1;
  readonly contract: HttpApi.HttpApi<"auth", Groups>;
  readonly tables: ReadonlyArray<`${Id}_${string}`>;
  /** Plan 05 (ADR-EA-018 decision 10): how each table in `tables` relates to the tenant, keyed by table name. */
  readonly tenancy: Readonly<Record<string, TenantScoped.TableDeclaration>>;
  readonly migrations: Migrations;
  readonly dependsOn: ReadonlyArray<Any>;
  /** PERS-003: the taps this plugin declared statically (`AuthPlugin.layer`'s `taps` option), readable without building any layer. */
  readonly taps: ReadonlyArray<DeclaredTap>;
  /** JH-007: tables owned by *other* plugins this one reads; `Auth.make` requires the owner in `dependsOn`. */
  readonly readsTables: ReadonlyArray<string>;
  /** PV-241/BEH-EA-111: the rate-limit rules this plugin declares statically (defaults; config may tune them), readable without building any layer. DERIVED from `rateLimitRules`. */
  readonly rateLimits: ReadonlyArray<RateLimitDeclaration>;
  /**
   * BEH-EA-105/107: the typed rule table this plugin declared (`Service`'s `rateLimitRules`), the one
   * source of the static `rateLimits` declaration AND of what `RateLimits.budget(Self)` registers.
   */
  readonly rateLimitRules: RateLimitModel.Table;
  /** PV-241/BEH-EA-202: the keys of the ports this plugin's layer requires (`AuthPlugin.layer`'s `ports` option), readable without building any layer. */
  readonly ports: ReadonlyArray<string>;
  /** ADR-EA-040: the keys of the namespaced domain services this plugin's layer exposes beside its own service (`AuthPlugin.layer`'s `exposes` option), readable without building any layer. */
  readonly exposes: ReadonlyArray<string>;
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
  /**
   * Type-only: the declared rule table's own type, which `RateLimits.budget(Self)` reads to type
   * `spend`'s names and inputs. Never assigned, for the reason `"~userFields"` is not.
   */
  readonly "~rateLimits"?: Limits;
  /**
   * Plan 08 (BEH-EA-T4): the plugin's record stores, one memory and one SQL implementation, matched. A
   * plugin that owns no tables declares nothing and reads `Layer.empty` for both.
   */
  readonly records: Records;
  /**
   * Plan 08 (BEH-EA-T5): the default (no-tap) layers of the hook points this plugin owns, provided once
   * per composition by the host. `Layer.empty` when it owns none.
   */
  readonly hookPoints: Points;
}

/**
 * Plan 08: a record store is a `Context.Service` whose key names a `/records/` service
 * (`awthaq/scim/records/ScimRecords`), the same mechanism `PortKeysOf` uses for `/ports/`. The
 * convention is what lets the compiler ask "does a bundle provide every record store the layer needs?".
 */
export type RecordKeysOf<R> = R extends { readonly key: infer K extends string }
  ? K extends `${string}/records/${string}`
    ? K
    : never
  : never;

/** Plan 08: the services among `S` that are record stores (the rest are what a bundle must not carry). */
type RecordServices<S> = S extends { readonly key: `${string}/records/${string}` } ? S : never;

/** Plan 08: a hook point's key (`HookPoint.veto/observe/divert` mint `awthaq/hook/<id>`). */
export type HookKeysOf<R> = R extends { readonly key: infer K extends string }
  ? K extends `awthaq/hook/${string}`
    ? K
    : never
  : never;

/**
 * Plan 08: the widest records declaration. `never` is the contravariant `ROut` slot's top (what it
 * accepts from any bundle); `unknown` is the covariant `RIn`/`E` slots' top.
 */
export interface AnyRecords {
  readonly memory: Layer.Layer<never, unknown, unknown>;
  readonly sql: Layer.Layer<never, unknown, unknown>;
}

/** Plan 08: a plugin that owns no record stores declares nothing; `Service` fills this in. */
export interface NoRecords {
  readonly memory: Layer.Layer<never>;
  readonly sql: Layer.Layer<never>;
}

/**
 * Plan 08 (BEH-EA-T4): `memory` and `sql` provide exactly the same stores, and nothing but stores.
 * `unknown` (no constraint) when legal; otherwise a property whose type names the offending keys.
 */
export type RecordsLegal<R extends AnyRecords> = [Layer.Success<R["memory"]>] extends [
  Layer.Success<R["sql"]>,
]
  ? [Layer.Success<R["sql"]>] extends [Layer.Success<R["memory"]>]
    ? [Exclude<Layer.Success<R["memory"]>, RecordServices<Layer.Success<R["memory"]>>>] extends [
        never,
      ]
      ? unknown
      : {
          readonly "~records": {
            readonly "a records bundle provides only /records/ stores, not": Exclude<
              Layer.Success<R["memory"]>,
              RecordServices<Layer.Success<R["memory"]>>
            >;
          };
        }
    : {
        readonly "~records": {
          readonly "sql provides stores memory does not": Exclude<
            RecordKeysOf<Layer.Success<R["sql"]>>,
            RecordKeysOf<Layer.Success<R["memory"]>>
          >;
        };
      }
  : {
      readonly "~records": {
        readonly "memory provides stores sql does not": Exclude<
          RecordKeysOf<Layer.Success<R["memory"]>>,
          RecordKeysOf<Layer.Success<R["sql"]>>
        >;
      };
    };

/** Plan 08: the record stores a plugin (or a union of plugin classes) provides. Distributes over a union. */
export type RecordsOut<P> = P extends {
  readonly records: { readonly memory: infer M extends Layer.Any };
}
  ? Layer.Success<M>
  : never;

/** Plan 08: what a record bundle of the given mode still requires (`SqlClient`, `Encryption`, ...). */
export type RecordsIn<P, Mode extends "memory" | "sql"> = P extends {
  readonly records: infer B;
}
  ? B extends {
      readonly memory: infer M extends Layer.Any;
      readonly sql: infer S extends Layer.Any;
    }
    ? Layer.Services<Mode extends "memory" ? M : S>
    : never
  : never;

/** Plan 08: the hook points a plugin (or a union of plugin classes) declares. */
export type HookPointsOut<P> = P extends { readonly hookPoints: infer H extends Layer.Any }
  ? Layer.Success<H>
  : never;

/** Plan 08: the record stores `R` requires that `Provided` does not. */
export type MissingRecords<R, Provided> = Exclude<RecordKeysOf<R>, RecordKeysOf<Provided>>;

/**
 * Plan 08 (BEH-EA-T4): completeness of the `records` declaration, checked where `AuthPlugin.layer` is
 * called, like `PortsComplete`. Records owned by a `dependsOn` plugin count as provided.
 */
export type RecordsComplete<R, Provided> = [MissingRecords<R, Provided>] extends [never]
  ? unknown
  : {
      readonly "~missingRecords": {
        readonly "declare these record stores in AuthPlugin.Service's records": MissingRecords<
          R,
          Provided
        >;
      };
    };

type CorePoints = Layer.Success<typeof Hooks.HooksLive>;

/** Plan 08: the plugin-owned hook points `R` requires that nothing declares (core's own points are always present). */
export type MissingHookPoints<R, Provided> = Exclude<
  HookKeysOf<R>,
  HookKeysOf<Provided | CorePoints>
>;

/** Plan 08 (BEH-EA-T5): completeness of the `hookPoints` declaration, checked where `AuthPlugin.layer` is called. */
export type HookPointsComplete<R, Provided> = [MissingHookPoints<R, Provided>] extends [never]
  ? unknown
  : {
      readonly "~missingHookPoints": {
        readonly "declare these hook points in AuthPlugin.Service's hookPoints": MissingHookPoints<
          R,
          Provided
        >;
      };
    };

export type { RateLimitDeclaration, RateLimitDimension } from "./RateLimitModel.ts";

/** PV-241: the group ids of a plugin's contract, the only groups a declared rule may name. */
export type GroupIdOf<Groups> =
  Groups extends HttpApiGroup.HttpApiGroup<infer Id, infer _Endpoints, infer _Error> ? Id : never;

/**
 * PERS-003/PV-260: a statically declared tap — the manifest reads `point`/`order`; a contract test
 * reads the rest: which plugin owns it (`owner`, the plugin id), its point's `kind`, the `handler`
 * itself (identity), and `exercise`/`install` to run it against a point of that kind.
 */
export interface DeclaredTap extends HookPoint.TapDeclaration<unknown> {
  readonly owner: string;
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

/**
 * Plan 05: the tenancy of one declared table, as `tables` takes it. Re-exported so a package that
 * does not depend on `@awthaq/sql` (roles, qadi) declares its tables through core alone.
 * `partitioned` (nullable tenant column stamped from the ambient tenant), `keyed` (the organization
 * id is the row's own key), `derived` (scoped through a parent table) or `global` (deliberately
 * tenant-blind; the reason is printed by `awthaq plugin list`).
 */
export const Table = {
  partitioned: (column = "tenantId"): TenantScoped.TableDeclaration => ({
    tenancy: TenantScoped.partitioned(column),
  }),
  keyed: (column: string): TenantScoped.TableDeclaration => ({
    tenancy: TenantScoped.keyed(column),
  }),
  derived: (parent: string, via: string, parentKey = "id"): TenantScoped.TableDeclaration => ({
    tenancy: TenantScoped.derived(parent, via, parentKey),
  }),
  global: (reason: string): TenantScoped.TableDeclaration => ({
    tenancy: TenantScoped.global(reason),
  }),
};

export interface Any {
  readonly id: string;
  readonly apiVersion: 1;
  readonly contract: ContractData;
  readonly tables: ReadonlyArray<string>;
  /** Plan 05: optional so a hand-built plugin value (a test fixture) need not declare any; an absent entry reads as Global. */
  readonly tenancy?: Readonly<Record<string, TenantScoped.TableDeclaration>>;
  readonly migrations: Migrations;
  readonly dependsOn: ReadonlyArray<Any>;
  /** PERS-003: optional so a hand-built plugin value (a test fixture) need not declare any. */
  readonly taps?: ReadonlyArray<DeclaredTap>;
  /** JH-007: optional here so a hand-built plugin value need not name it. */
  readonly readsTables?: ReadonlyArray<string>;
  /** PV-241: optional so a hand-built plugin value need not declare any. */
  readonly rateLimits?: ReadonlyArray<RateLimitDeclaration>;
  /** BEH-EA-105: optional so a hand-built plugin value need not declare any. */
  readonly rateLimitRules?: RateLimitModel.Table;
  /** PV-241: optional so a hand-built plugin value need not declare any. */
  readonly ports?: ReadonlyArray<string>;
  /** ADR-EA-040: optional so a hand-built plugin value need not declare any. */
  readonly exposes?: ReadonlyArray<string>;
  /** Optional here (a hand-built `Any` may have none); every plugin made with `Service` carries the list. */
  readonly config?: ReadonlyArray<ConfigDescriptor>;
  /** SAM-004: optional so a hand-built plugin value need not declare any; every plugin made with `Service` carries the record. */
  readonly userFields?: UserFields.Declarations;
  /** Plan 08: optional so a hand-built plugin value (a test fixture) need not declare any; every plugin made with `Service` carries the pair. */
  readonly records?: AnyRecords;
  /** Plan 08: optional so a hand-built plugin value need not declare any; every plugin made with `Service` carries the layer. */
  readonly hookPoints?: Layer.Layer<never, unknown, unknown>;
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

/** ADR-EA-040: the exposed service keys, kept the same way (known only once `AuthPlugin.layer` runs). */
const exposesByPlugin = new WeakMap<object, ReadonlyArray<string>>();

const noExposes: ReadonlyArray<string> = [];

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
export const Service = <Self, Shape>() => {
  // The public signature: `records`/`hookPoints` are inferred from the options (and default to "none declared"
  // when absent). The implementation below is typed against the widest shapes, the way `Auth.make`'s is.
  function build<
    const Id extends string,
    Groups extends GroupsFor<Id>,
    const Fields extends UserFields.Declarations = {},
    const Limits extends RateLimitModel.Table<GroupIdOf<Groups>> = {},
    const Records extends AnyRecords = NoRecords,
    Points extends Layer.Layer<never, unknown, unknown> = Layer.Layer<never>,
  >(
    id: Id,
    options: {
      readonly apiVersion: 1;
      readonly contract: HttpApi.HttpApi<"auth", Groups>;
      /**
       * BEH-EA-005/BEH-EA-328: the tables this plugin owns, keyed by name (each `<id>_...`), each with its
       * tenancy: `{ webhooks_endpoint: AuthPlugin.Table.partitioned() }`. A table without a declaration, or
       * with another plugin's prefix, does not compile.
       */
      readonly tables?: {
        readonly [T in `${NoInfer<Id>}_${string}`]: TenantScoped.TableDeclaration;
      };
      readonly migrations?: Migrations;
      readonly readsTables?: ReadonlyArray<string>;
      /**
       * BEH-EA-105/107/111: the typed rate-limit rule table (`{ signIn: RateLimits.rule({ group, endpoint,
       * key: RateLimits.Key.email, limit, window }) }`). Declared once: the static `rateLimits` listing is
       * derived from it, `RateLimits.budget(Self)` registers it and `spend`s only its names, and a rule
       * whose `group` is not one of this plugin's contract groups is a compile error.
       */
      readonly rateLimitRules?: Limits;
      /** ECS-008/BEH-EA-229: descriptors of the `Context.Reference`s this plugin reads (`ConfigDescriptor.make`). */
      readonly config?: ReadonlyArray<ConfigDescriptor>;
      /**
       * SAM-004/BEH-EA-040/048: nullable scalar columns this plugin adds to `users`, `{ plan:
       * UserFields.serverOnly(Schema.Literals(["free", "pro"])) }` for a column `<id>_plan`. The linker
       * (`Auth.make`) generates the migration; a field is client-writable unless declared otherwise.
       * Validated here, at definition time: a schema that is not one scalar throws `InvalidDeclaration`.
       */
      readonly userFields?: Fields;
      /**
       * Plan 08 (BEH-EA-T4): the plugin's record stores as two matched layers, `{ memory, sql }`. Every
       * `/records/` store the plugin's layer requires must be provided by this bundle or by a `dependsOn`
       * plugin's (checked at `AuthPlugin.layer`); `memory` and `sql` must provide the same stores, and only
       * stores. `TestAuth.layer` selects one per composition; a host picks one the same way.
       */
      readonly records?: Records;
      /**
       * Plan 08 (BEH-EA-T5): the default (no-tap) layers of the hook points this plugin owns, merged into one
       * layer. A plugin layer that requires a non-core hook point it does not declare here does not compile.
       */
      readonly hookPoints?: Points;
    } & RecordsLegal<Records>,
  ): Class<Self, Id, Shape, Groups, Fields, Limits, Records, Points>;
  function build(
    id: string,
    options: {
      readonly apiVersion: 1;
      readonly contract: ContractData;
      readonly tables?: Readonly<Record<string, TenantScoped.TableDeclaration>>;
      readonly migrations?: Migrations;
      readonly readsTables?: ReadonlyArray<string>;
      readonly rateLimitRules?: RateLimitModel.Table;
      readonly config?: ReadonlyArray<ConfigDescriptor>;
      readonly userFields?: UserFields.Declarations;
      readonly records?: AnyRecords;
      readonly hookPoints?: Layer.Layer<never, unknown, unknown>;
    },
  ): object {
    const key: Key<string> = `awthaq/plugin/${id}`;
    const userFields: UserFields.Declarations = options.userFields ?? {};
    const tenancy: Readonly<Record<string, TenantScoped.TableDeclaration>> = options.tables ?? {};
    const tables = Object.keys(tenancy).filter((name): name is `${string}_${string}` =>
      name.startsWith(`${id}_`),
    );
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
      tables,
      tenancy,
      migrations: options.migrations ?? [],
      readsTables: options.readsTables ?? [],
      rateLimits: RateLimitModel.declare(options.rateLimitRules ?? {}),
      rateLimitRules: options.rateLimitRules ?? {},
      config: options.config ?? [],
      userFields,
      dependsOn: noDependencies,
      taps: noTaps,
      ports: noPorts,
      exposes: noExposes,
      records: options.records ?? noRecords,
      hookPoints: options.hookPoints ?? Layer.empty,
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
    const withLivePorts = Object.defineProperty(withLiveTaps, "ports", {
      enumerable: true,
      configurable: true,
      get(this: object): ReadonlyArray<string> {
        return portsByPlugin.get(this) ?? noPorts;
      },
    });
    return Object.defineProperty(withLivePorts, "exposes", {
      enumerable: true,
      configurable: true,
      get(this: object): ReadonlyArray<string> {
        return exposesByPlugin.get(this) ?? noExposes;
      },
    });
  }
  return build;
};

/** Plan 08: what a plugin that declares no `records` reads (empty layers, in both modes). */
const noRecords: NoRecords = { memory: Layer.empty, sql: Layer.empty };

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

/** ADR-EA-040: the service keys of a requirement/provision union. */
export type ServiceKeysOf<S> = S extends { readonly key: infer K extends string } ? K : never;

/**
 * ADR-EA-040: completeness and namespacing of an `exposes` declaration, checked where
 * `AuthPlugin.layer` is called. Nothing when every service the exposing layer provides is keyed
 * `awthaq/plugin/<id>/<name>` and is listed in `services` (and nothing listed is missing from the
 * layer); otherwise `exposes` becomes a required property whose type names the offending keys. The
 * namespace rule means two plugins can never expose the same tag, so no implicit slot appears.
 */
export type ExposesComplete<Id extends string, XOut, Exposed extends ReadonlyArray<PortClass>> = [
  Exclude<ServiceKeysOf<XOut> | Exposed[number]["key"], `awthaq/plugin/${Id}/${string}`>,
] extends [never]
  ? [Exclude<ServiceKeysOf<XOut>, Exposed[number]["key"]>] extends [never]
    ? [Exclude<Exposed[number]["key"], ServiceKeysOf<XOut>>] extends [never]
      ? unknown
      : {
          readonly exposes: {
            readonly "listed in services but not provided by layer": Exclude<
              Exposed[number]["key"],
              ServiceKeysOf<XOut>
            >;
          };
        }
    : {
        readonly exposes: {
          readonly "list these exposed services in services": Exclude<
            ServiceKeysOf<XOut>,
            Exposed[number]["key"]
          >;
        };
      }
  : {
      readonly exposes: {
        readonly "an exposed service must be keyed awthaq/plugin/<id>/<name>": Exclude<
          ServiceKeysOf<XOut> | Exposed[number]["key"],
          `awthaq/plugin/${Id}/${string}`
        >;
      };
    };

/**
 * ADR-EA-040: the namespaced domain services a plugin exposes beside its own service. `services`
 * lists the tags (static: the manifest prints them without building a layer); `layer` builds them,
 * once, beneath `make`, so `make` may require them.
 */
export interface Exposes<Exposed, XOut, XE, XR> {
  readonly services: Exposed;
  readonly layer: Layer.Layer<XOut, XE, XR>;
}

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
  Fields extends UserFields.Declarations,
  Limits extends RateLimitModel.Table,
  Records extends AnyRecords,
  Points extends Layer.Layer<never, unknown, unknown>,
  E,
  R,
  HE,
  HR,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
  Exposed extends ReadonlyArray<PortClass> = readonly [],
  XOut = never,
  XE = never,
  XR = never,
>(
  plugin: Class<Self, Id, Shape, Groups, Fields, Limits, Records, Points>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly exposes?: Exposes<Exposed, XOut, XE, XR>;
    readonly make: Effect.Effect<Shape, E, R>;
    readonly handlers: Layer.Layer<HttpApiGroup.ToService<"auth", Groups>, HE, HR>;
  } & PortsComplete<R | HR | CR | XR, Ports> &
    ExposesComplete<Id, XOut, Exposed> &
    RecordsComplete<R | HR | CR | XR, Layer.Success<Records["memory"]> | RecordsOut<Deps[number]>> &
    HookPointsComplete<
      R | HR | CR | XR | TapPoints<Taps>,
      Layer.Success<Points> | HookPointsOut<Deps[number]>
    >,
): Layer.Layer<
  Self | HttpApiGroup.ToService<"auth", Groups> | XOut,
  E | HE | CE | XE,
  | Exclude<R, Scope.Scope | XOut>
  | Exclude<HR, Self | XOut>
  | InstanceOf<Deps[number]>
  | InstanceOf<Ports[number]>
  | TapPoints<Taps>
  | Exclude<CR, Self | XOut | HttpApiGroup.ToService<"auth", Groups>>
  | XR
>;
export function layer<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations,
  Limits extends RateLimitModel.Table,
  Records extends AnyRecords,
  Points extends Layer.Layer<never, unknown, unknown>,
  E,
  R,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
  Exposed extends ReadonlyArray<PortClass> = readonly [],
  XOut = never,
  XE = never,
  XR = never,
>(
  plugin: Class<Self, Id, Shape, Groups, Fields, Limits, Records, Points>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly exposes?: Exposes<Exposed, XOut, XE, XR>;
    readonly make: Effect.Effect<Shape, E, R>;
  } & PortsComplete<R | CR | XR, Ports> &
    ExposesComplete<Id, XOut, Exposed> &
    RecordsComplete<R | CR | XR, Layer.Success<Records["memory"]> | RecordsOut<Deps[number]>> &
    HookPointsComplete<
      R | CR | XR | TapPoints<Taps>,
      Layer.Success<Points> | HookPointsOut<Deps[number]>
    >,
): Layer.Layer<
  Self | XOut,
  E | CE | XE,
  | Exclude<R, Scope.Scope | XOut>
  | InstanceOf<Deps[number]>
  | InstanceOf<Ports[number]>
  | TapPoints<Taps>
  | Exclude<CR, Self | XOut>
  | XR
>;
export function layer<
  Self,
  Id extends string,
  Shape,
  Groups extends HttpApiGroup.Constraint,
  Fields extends UserFields.Declarations,
  Limits extends RateLimitModel.Table,
  Records extends AnyRecords,
  Points extends Layer.Layer<never, unknown, unknown>,
  E,
  R,
  HE = never,
  HR = never,
  Deps extends ReadonlyArray<Any> = readonly [],
  Taps extends ReadonlyArray<HookPoint.TapDeclaration<unknown>> = readonly [],
  Ports extends ReadonlyArray<PortClass> = readonly [],
  CE = never,
  CR = never,
  Exposed extends ReadonlyArray<PortClass> = readonly [],
  XOut = never,
  XE = never,
  XR = never,
>(
  plugin: Class<Self, Id, Shape, Groups, Fields, Limits, Records, Points>,
  options: {
    readonly dependsOn?: Deps;
    readonly taps?: Taps;
    readonly ports?: Ports;
    readonly contributes?: Layer.Layer<never, CE, CR>;
    readonly exposes?: Exposes<Exposed, XOut, XE, XR>;
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
    taps.map((declaration) => ({ ...declaration, owner: plugin.id })),
  );
  // A variant layer that names no `ports` (BEH-EA-019's second `layer` of one class) leaves the first declaration alone.
  if (options.ports !== undefined) {
    portsByPlugin.set(
      plugin,
      options.ports.map((port) => port.key),
    );
  }
  if (options.exposes !== undefined) {
    exposesByPlugin.set(
      plugin,
      options.exposes.services.map((service) => service.key),
    );
  }
  const ownOnly = Layer.effect<Self, Shape, E, R>(plugin, options.make);
  // ADR-EA-040: the exposed services are built once, beneath `make`, so `make` may require them and
  // a dependent plugin's requirement on them is discharged by `Auth.make`'s fold.
  const own = Layer.provideMerge(ownOnly, options.exposes?.layer ?? Layer.empty);
  const withHandlers = options.handlers ? Layer.provideMerge(options.handlers, own) : own;
  // A plugin's other registry contributions (its erasure/export sections, rate-limit
  // rules, ...): built over the plugin's own service, and what else they require joins
  // this layer's `RIn`.
  const withContributions =
    options.contributes === undefined
      ? withHandlers
      : Layer.provideMerge(options.contributes, withHandlers);
  // BEH-EA-111: declared means opened. A plugin whose table is non-empty must have opened its budget
  // by the time its layer is built, so the declaration `plugin list --rules` prints is never a rule
  // nothing registered. Applies only when a registry is in scope (a budget requires one, so a plugin
  // that opens its budget always has it).
  const guarded = Layer.tap(withContributions, () =>
    Effect.flatMap(Effect.serviceOption(RateLimitModel.RateLimitsRegistry), (registry) =>
      Option.isNone(registry) || Object.keys(plugin.rateLimitRules).length === 0
        ? Effect.void
        : Effect.flatMap(registry.value.handleOf(plugin.id), (handle) =>
            Option.isSome(handle)
              ? Effect.void
              : Effect.die(
                  new RateLimitModel.RateLimitBudgetNotOpened({
                    plugin: plugin.id,
                    rules: Object.keys(plugin.rateLimitRules),
                    message: `awthaq: plugin "${plugin.id}" declares rate-limit rules but its layer never opened RateLimits.budget(${plugin.id})`,
                  }),
                ),
          ),
    ),
  );
  if (taps.length === 0) return guarded;
  // PERS-003: the plugin installs its own taps as its own owner, so the
  // runtime chain orders them by this plugin's place in the composition.
  const installed = taps.reduce<Layer.Layer<never, never, unknown>>(
    (acc, declaration) => Layer.merge(acc, declaration.install(plugin)),
    Layer.empty,
  );
  return Layer.merge(guarded, installed);
}
