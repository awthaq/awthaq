// @awthaq/server — AuthHost
//
// ADR-EA-044 (plan 15): the servable layer, derived from what `Auth.make` returned. A host provides only what it
// owns: where state lives, the CSRF secret, its ports, its own policy layers. Everything that is a function of the
// plugin tuple (routes, core handlers, records bundles, hook points, core services, registries, middleware, user
// fields, migrations) is assembled here, once. `RIn` is exactly the host-owned remainder, so `Layer.launch` refuses
// to compile while a port is missing (BEH-EA-014), and in SQL mode the layer runs or verifies the migrations itself
// before anything is built over the client (the one requirement the compiler cannot see).

import {
  Accounts,
  AuditChain,
  AuditLog,
  type Auth,
  AuthEvents,
  type AuthPlugin,
  DataExport,
  Erasure,
  Hooks,
  Migrations,
  Persistence,
  RateLimits,
  type Retention,
  Sessions,
  Slots,
  Users,
  Verification,
} from "@awthaq/core";
import type {
  AccountStore,
  AuditLogStore,
  Encryption,
  RelayCursorStore,
  SessionStore,
  SqlTransaction,
  UserStore,
  VerificationStore,
} from "@awthaq/ports";
import type { SealedColumn } from "@awthaq/sql";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Etag from "effect/http/Etag";
import type * as HttpPlatform from "effect/http/HttpPlatform";
import type * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type * as SqlClient from "effect/sql/SqlClient";
import * as AuthHttp from "./AuthHttp.ts";
import * as BodyLimit from "./BodyLimit.ts";
import * as Credentials from "./Credentials.ts";
import type * as Csrf from "./Csrf.ts";
import * as RequestContext from "./RequestContext.ts";

/** Single-process state: every core store and every plugin's `records.memory` (TRBS-005). */
export interface MemoryPersistence {
  readonly records: "memory";
}

/** One database for everything: `Persistence.sql(options)`, every plugin's `records.sql`, the migrations. */
export interface SqlPersistence<KE, KR> {
  readonly records: "sql";
  /** The one client. It is also in the output (the CLI's `import` keeps its checkpoint beside the users it writes). */
  readonly client: Layer.Layer<SqlClient.SqlClient, KE, KR>;
  /**
   * `"apply"`: core's migrations, then the composition's (`built.migrations`, user-field columns included), run
   * when the layer is built and before anything else is built over the client. `"verify"`: nothing is applied, and
   * a pending migration refuses the build (`Migrations/Pending`), for a host whose deploy step is
   * `awthaq migration apply`. Either way a ledger that disagrees with the linker refuses the build
   * (`Migrations/LedgerDrift`). No default: which process migrates is the host's decision.
   */
  readonly migrations: Migrations.OnBuild;
  readonly options?: Persistence.SqlOptions;
}

export interface Options<S, SE, SR, T, D, DR, CE, CR, PR> {
  /** Required. `Csrf.layerConfig` reads `AWTHAQ_CSRF_SECRET`; there is no safe default secret. */
  readonly csrf: Layer.Layer<Csrf.CsrfConfig, CE, CR>;
  /** Defaults to `Credentials.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` adds `emailVerified`. */
  readonly principalResolver?: Layer.Layer<Credentials.PrincipalResolver, never, PR>;
  /**
   * Host-owned layers that may read the composition and that the plugins read: plugin configuration
   * (`Password.config(...)`), extra-group handlers, a guard built over a plugin layer, adapters and gates. Built
   * above the core services, records and middleware, beneath the plugins; merged into the output, so `yield*`
   * returns the instance the plugins used. It shadows a composition-owned service *for the plugins* only: for a key
   * both provide, the output holds the composition's instance. Use `decorate` to replace one for everyone.
   */
  readonly services?: Layer.Layer<S, SE, SR>;
  /** Application taps, built over the one instance of every point (core's and each plugin's `hookPoints`). */
  readonly taps?: Layer.Layer<never, never, T>;
  /** Wraps a composition-owned service in place (a metrics `Sessions`, a fault): built over it, shadows it above. */
  readonly decorate?: Layer.Layer<D, never, DR>;
  /** AR-003: the groups this listener serves. Default `"all"`. Plugin layers are always built whole. */
  readonly tier?: "all" | "public" | "admin";
  /** `RequestContext.layer` (default `true`). `false` also silences `coreHandlers`' build-time warning. */
  readonly requestContext?: boolean;
  /** `BodyLimit.layer` (default `true`; `BodyLimit.config({ maxBytes })` tunes it). */
  readonly bodyLimit?: boolean;
  /** BEH-EA-084: serve the OpenAPI document at this path (unauthenticated; off by default). */
  readonly openapiPath?: `/${string}` | undefined;
  /** BEH-EA-084: serve the Scalar page at this path (unauthenticated; off by default). */
  readonly docsPath?: `/${string}` | undefined;
}

/**
 * The stores, the transaction, the provider-token key, the deployed sealed columns and the retention registry the
 * base is built over. Named so
 * the bases' inferred types can be emitted (TS2883 needs each namespace in scope); a host never writes it.
 */
export type BaseServices =
  | AccountStore.AccountStore
  | AuditLogStore.AuditLogStore
  | Encryption.Encryption
  | RelayCursorStore.RelayCursorStore
  | Retention.RetentionRegistry
  | SealedColumn.Deployed
  | SessionStore.SessionStore
  | SqlTransaction.SqlTransaction
  | UserStore.UserStore
  | VerificationStore.VerificationStore;

/** Everything the core services read: events over the audit log, every core point and registry, the audit chain. */
const foundation = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layer),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(AuditChain.layer),
);

/** The registries a composition holds exactly once (ADR-EA-033, ADR-EA-012, MA-005). */
const registries = Layer.mergeAll(
  RateLimits.layer,
  Slots.layer,
  Credentials.CredentialResolversLive,
);

const coreServices = Layer.mergeAll(
  Users.layer,
  Accounts.layer,
  Sessions.layer,
  Verification.layer,
);

/** The base over one store bundle (ADR-EA-041 decision 4: the bundle brings its own `SqlTransaction`). */
const baseOver = <O, E, R>(stores: Layer.Layer<O, E, R>) =>
  Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(coreServices, registries)),
    Layer.provideMerge(foundation),
    Layer.provideMerge(stores),
  );

const memoryBase = baseOver(Persistence.memory);

/**
 * The client reaches the stores, every plugin's `records.sql` and everything above only through the migrated layer,
 * so nothing is built over it before the schema is current (or verified current).
 */
const sqlBaseOf = <KE, KR>(
  client: Layer.Layer<SqlClient.SqlClient, KE, KR>,
  mode: Migrations.OnBuild,
  migrations: Migrations.Migrations,
  options: Persistence.SqlOptions | undefined,
) =>
  baseOver(Persistence.sql(options)).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(Migrations.onBuild(mode, migrations)).pipe(Layer.provideMerge(client)),
    ),
  );

/** The SQL base's types, over a client with no requirement of its own. */
const sqlBaseShape = (client: Layer.Layer<SqlClient.SqlClient>) =>
  sqlBaseOf(client, "verify", [], undefined);

type Mode = "memory" | "sql";

/** The platform services `AuthHttp.routes`/`docs` need, which `HttpRouter.serve`/`toWebHandler` and the platform supply. */
export type Serving =
  | HttpRouter.HttpRouter
  | HttpPlatform.HttpPlatform
  | Etag.Generator
  | FileSystem.FileSystem
  | Path.Path;

type BaseOut<M extends Mode> = M extends "memory"
  ? Layer.Success<typeof memoryBase>
  : Layer.Success<ReturnType<typeof sqlBaseShape>>;
type BaseIn<M extends Mode> = M extends "memory"
  ? Layer.Services<typeof memoryBase>
  : Layer.Services<ReturnType<typeof sqlBaseShape>>;

/** Everything the layer provides beneath its plugins (and merges into its output). */
export type Provided<P extends ReadonlyArray<AuthPlugin.Any>, M extends Mode, S, D> =
  | BaseOut<M>
  | Csrf.CsrfConfig
  | Credentials.PrincipalResolver
  | AuthPlugin.RecordsOut<P[number]>
  | AuthPlugin.HookPointsOut<P[number]>
  | S
  | D;

/** BEH-EA-014 through the whole pipeline: what the host still owns. `never` exactly when every port is provided. */
export type Requires<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  M extends Mode,
  S,
  SR,
  T,
  D,
  DR,
  CR,
  PR,
  KR,
> = Exclude<
  | Layer.Services<Auth.Built<P, Extra>["layer"]>
  | Layer.Services<typeof AuthHttp.coreHandlers>
  | Layer.Services<typeof RequestContext.layer>
  | Layer.Services<typeof BodyLimit.layer>
  | SecureRandom.SecureRandom
  | AuthPlugin.RecordsIn<P[number], M>
  | BaseIn<M>
  | Serving
  | SR
  | T
  | DR
  | CR
  | PR
  | KR,
  Provided<P, M, S, D> | AuthHttp.DeclaredMiddleware<Auth.AllGroups<P, Extra>>
>;

/** The widest options, which the one implementation is checked against. */
type AnyOptions = Options<
  never,
  unknown,
  unknown,
  unknown,
  never,
  unknown,
  unknown,
  unknown,
  unknown
> & {
  readonly persistence: MemoryPersistence | SqlPersistence<unknown, unknown>;
};

type AnyBuilt = Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>;

/** Declared over the widest shapes; the `layer` overloads carry the precise formula. */
const routesFor = (built: AnyBuilt, options: AnyOptions): Layer.Layer<never, unknown, unknown> => {
  const served = { openapiPath: options.openapiPath };
  const docs = { path: options.docsPath };
  const withDocs = (
    routes: Layer.Layer<never, never, unknown>,
    page: Layer.Layer<never, never, unknown>,
  ) => (options.docsPath === undefined ? routes : Layer.merge(routes, page));
  return options.tier === "public"
    ? withDocs(AuthHttp.routes(built.publicApi, served), AuthHttp.docs(built.publicApi, docs))
    : options.tier === "admin"
      ? withDocs(AuthHttp.routes(built.adminApi, served), AuthHttp.docs(built.adminApi, docs))
      : withDocs(AuthHttp.routes(built.api, served), AuthHttp.docs(built.api, docs));
};

const makeLayer = (built: AnyBuilt, options: AnyOptions): Layer.Layer<never, unknown, unknown> => {
  const persistence = options.persistence;
  const sql = persistence.records === "sql" ? persistence : undefined;
  // Plan 08's selection, moved here from `TestAuth`: the records bundle for the mode, and every declared point.
  const records = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>((acc, plugin) => {
    const bundle = sql === undefined ? plugin.records?.memory : plugin.records?.sql;
    return bundle === undefined ? acc : Layer.merge(acc, bundle);
  }, Layer.empty);
  const points = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, plugin) => (plugin.hookPoints === undefined ? acc : Layer.merge(acc, plugin.hookPoints)),
    Layer.empty,
  );
  const resolver = options.principalResolver ?? Credentials.PrincipalResolverLive;
  // Derived from the whole api: the plugin layers (which hold every handler) need it whatever the tier serves.
  const middleware = AuthHttp.middlewareFor(built.api, {
    csrf: options.csrf,
    principalResolver: resolver,
  });
  const edge = Layer.mergeAll(
    options.requestContext === false ? Layer.empty : RequestContext.layer,
    options.bodyLimit === false ? Layer.empty : BodyLimit.layer,
  );
  const handlers =
    options.requestContext === false
      ? AuthHttp.coreHandlers.pipe(
          Layer.provide(Layer.succeed(RequestContext.warnWhenAbsent, false)),
        )
      : AuthHttp.coreHandlers;
  const base =
    sql === undefined
      ? memoryBase
      : sqlBaseOf(sql.client, sql.migrations, built.migrations, sql.options);
  return routesFor(built, options).pipe(
    Layer.provide(handlers),
    // Built before the handlers, so `coreHandlers`' check finds `RequestContext.layer` on the router.
    Layer.provide(edge),
    // The plugins' own services stay in the output (`provideMerge`).
    Layer.provideMerge(built.layer),
    Layer.provideMerge(options.services ?? Layer.empty),
    Layer.provide(middleware),
    Layer.provideMerge(resolver),
    Layer.provideMerge(options.csrf),
    Layer.provideMerge((options.taps ?? Layer.empty).pipe(Layer.provideMerge(points))),
    Layer.provideMerge(records),
    Layer.provideMerge(options.decorate ?? Layer.empty),
    Layer.provideMerge(base),
    // SAM-004: the composition's declared user fields, last, so `Users` and the account handler both see it.
    Layer.provideMerge(built.userFieldsLayer),
  );
};

/**
 * ADR-EA-044: `AuthHost.layer(Auth.make([...]), { persistence, csrf, ... })` is the servable layer. It derives the
 * routes (for `tier`), core's handlers, every composed plugin's records bundle for the chosen persistence and its
 * declared hook points, core's services and registries, the host middleware the groups declare, the user-field
 * registry, `RequestContext.layer` and `BodyLimit.layer`; in SQL mode it applies or verifies the migrations before
 * anything is built over the client. Its `RIn` is the ports, adapters and platform services the host owns.
 *
 * Merge host-owned jobs and edge middleware (`Retention.layerScheduled`, `SecuritySignals.layer`,
 * `SecurityHeaders.layer`, `AuthHttp.cors`) beside it. It requires `HttpRouter` rather than providing it, so a host
 * merges its own routes onto the same router; `HttpRouter.serve`/`toWebHandler` supply it.
 *
 * Declared as overloads for the reason `TestAuth.layer` is: the precise formula cannot be checked against an
 * abstract `P` inside the body, so the implementation is checked against a widened signature.
 */
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  S = never,
  SE = never,
  SR = never,
  T = never,
  D = never,
  DR = never,
  CE = never,
  CR = never,
  PR = never,
>(
  built: Auth.Built<P, Extra>,
  options: Options<S, SE, SR, T, D, DR, CE, CR, PR> & { readonly persistence: MemoryPersistence },
): Layer.Layer<
  Provided<P, "memory", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  Layer.Error<Auth.Built<P, Extra>["layer"]> | SE | CE,
  Requires<P, Extra, "memory", S, SR, T, D, DR, CR, PR, never>
>;
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  S = never,
  SE = never,
  SR = never,
  T = never,
  D = never,
  DR = never,
  CE = never,
  CR = never,
  PR = never,
  KE = never,
  KR = never,
>(
  built: Auth.Built<P, Extra>,
  options: Options<S, SE, SR, T, D, DR, CE, CR, PR> & {
    readonly persistence: SqlPersistence<KE, KR>;
  },
): Layer.Layer<
  Provided<P, "sql", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  Layer.Error<Auth.Built<P, Extra>["layer"]> | SE | CE | KE | Migrations.OnBuildError,
  Requires<P, Extra, "sql", S, SR, T, D, DR, CR, PR, KR>
>;
export function layer(built: AnyBuilt, options: AnyOptions): Layer.Layer<never, unknown, unknown> {
  return makeLayer(built, options);
}
