// BDD-005/P20a: the SCIM plugin's real wire-level seam — the layer graph
// `packages/scim/test/support.ts` builds (the real in-memory core, the organization plugin
// `Scim` depends on, the SCIM records, the connection store and bearer authentication),
// served over `HttpRouter.toWebHandler` and reached the way a directory service's HTTP client
// would reach it: as the holder of a connection's bearer token. The services the handler runs
// on are reachable through `withContext` (the same instances, via one shared `MemoMap`), for
// the Givens that arrange what only an operator can (a connection, an administrator's ban,
// live sessions) and for the Thens that observe what HTTP cannot show (an account's status,
// its sessions, its membership, the audit log).
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Errors, Hooks, HookPoint, Sessions, Users } from "@awthaq/core";
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Scim, ScimApi, ScimConnections, ScimRecords } from "@awthaq/scim";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { makeNamedRegistry, TestServices } from "./shared/Harness.ts";
import { snapshot, type Snapshot } from "./shared/WireJson.ts";

const ORIGIN = "http://localhost:3000";

// ---- the composition ---------------------------------------------------------------------

/** The real in-memory `Users`, except that reading by email reports an outage (ADR-EA-028). */
const UsersDownOnLookup: typeof Users.layerMemory = Layer.effect(
  Users.Users,
  Effect.gen(function* () {
    const real = yield* Users.Users;
    return Users.Users.of({
      ...real,
      findByEmail: () =>
        Effect.fail(new Errors.StoreUnavailable({ operation: "Users.findByEmail" })),
    });
  }),
).pipe(Layer.provide(Users.layerMemory));

/** A `beforeDelete` tap that refuses every deletion, as a legal hold would (BEH-EA-095). */
const VetoDelete = Hooks.BeforeUserDelete.tap(() =>
  Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" })),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("scim-bdd-csrf-secret-padded-to-thirty-two-bytes-long"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const OrganizationRecordsLive = OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

export interface AppOptions {
  readonly scim?: Partial<Scim.ScimConfigShape>;
  readonly organization?: Partial<Organization.OrganizationConfigShape>;
  readonly vetoDelete?: boolean;
  readonly usersOutage?: boolean;
}

const buildLive = (options: AppOptions) => {
  const users = options.usersOutage === true ? UsersDownOnLookup : Users.layerMemory;
  const hooks =
    options.vetoDelete === true
      ? VetoDelete.pipe(Layer.provideMerge(Hooks.HooksLive))
      : Hooks.HooksLive;
  const CoreLive = Layer.mergeAll(Sessions.layerMemory, users).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(hooks),
    Layer.provideMerge(NodeCrypto.layer),
  );
  const OrganizationLive = Organization.Organization.layer.pipe(
    Layer.provide(Organization.config(options.organization ?? {})),
    Layer.provide(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
  );
  // `ScimRecords.layerMemory` is shared by the plugin, the connection store and the bearer
  // authentication (one `Ref`), so a token created through the store authenticates through
  // the plugin.
  return Scim.Scim.layer.pipe(
    Layer.provide(Scim.config(options.scim ?? {})),
    Layer.provide(ScimConnections.ScimAuthenticationLive),
    Layer.provideMerge(ScimConnections.layerStore),
    Layer.provideMerge(OrganizationLive),
    Layer.provideMerge(ScimRecords.layerMemory),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecordsLive),
    Layer.provideMerge(MembershipRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(ActiveContextRecords.layerMemory),
    Layer.provideMerge(InvitationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(OrgRoleRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TeamRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(Mailer.layerMemory),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
  );
};

export type AppServices =
  | Scim.Scim
  | ScimConnections.ScimConnectionStore
  | ScimRecords.ScimRecords
  | Organization.Organization
  | OrganizationRecords.OrganizationRecords
  | MembershipRecords.MembershipRecords
  | TeamRecords.TeamRecords
  | Users.Users
  | Sessions.Sessions
  | AuditLog.AuditLog;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly withContext: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>;
  readonly close: Effect.Effect<void>;
}

const buildApp = (options: AppOptions): AppHandle => {
  const Live = buildLive(options);
  const AppLayer = AuthHttp.routes(ScimApi.ScimApi).pipe(
    Layer.provide(Live),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  // One long-lived scope owns the built layer, so `withContext` sees the very instances the
  // handler runs on for the whole scenario.
  const scope = Effect.runSync(Scope.make());
  let built: Promise<Context.Context<AppServices>> | undefined;
  const context = () => (built ??= Effect.runPromise(Layer.buildWithMemoMap(Live, memoMap, scope)));
  const withContext: AppHandle["withContext"] = (effect) =>
    context().then((services) => Effect.runPromise(effect.pipe(Effect.provide(services))));
  return { handler, withContext, close: Scope.close(scope, Exit.void) };
};

// ---- the World ---------------------------------------------------------------------------

/** One SCIM connection of one organization, with the bearer token it was created with. */
export interface ConnectionState {
  readonly identity: ScimApi.ScimConnectionIdentity;
  readonly organizationId: string;
  readonly token: string;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle>;
  readonly options: Ref.Ref<AppOptions>;
  /** Set once anything reads or writes, so a late configuration Given is a bug in the scenario. */
  readonly started: Ref.Ref<boolean>;
  readonly connections: ReturnType<typeof makeNamedRegistry<ConnectionState>>;
  /** User ids by the name the scenario gave them (a `userName`, a display name). */
  readonly userIds: ReturnType<typeof makeNamedRegistry<string>>;
  readonly groupIds: ReturnType<typeof makeNamedRegistry<string>>;
  /** The organization each group (team) belongs to, by group name. */
  readonly groupOrgs: Map<string, string>;
  /** Live session tokens per user name, oldest first. */
  readonly sessions: Map<string, Array<Redacted.Redacted<string>>>;
  /** A signed-in caller's session cookie, by name. */
  readonly cookies: ReturnType<typeof makeNamedRegistry<string>>;
  readonly last: Ref.Ref<Snapshot | undefined>;
  /** The id a resource had when it was first provisioned, by kind and name. */
  readonly firstIds: Map<string, string>;
  /** Every list response a scenario has read, in order (for the paging scenarios). */
  readonly pages: Array<Snapshot>;
}

export class World extends Context.Service<World, WorldShape>()("features/ScimWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const app = yield* Ref.make(buildApp({}));
    yield* Effect.addFinalizer(() => Ref.get(app).pipe(Effect.flatMap((handle) => handle.close)));
    return World.of({
      app,
      options: yield* Ref.make<AppOptions>({}),
      started: yield* Ref.make(false),
      connections: makeNamedRegistry<ConnectionState>("SCIM connection"),
      userIds: makeNamedRegistry<string>("user"),
      groupIds: makeNamedRegistry<string>("group"),
      groupOrgs: new Map(),
      sessions: new Map(),
      cookies: makeNamedRegistry<string>("session cookie"),
      last: yield* Ref.make<Snapshot | undefined>(undefined),
      firstIds: new Map(),
      pages: [],
    });
  }),
);

export const currentApp = Effect.gen(function* () {
  const world = yield* World;
  yield* Ref.set(world.started, true);
  return yield* Ref.get(world.app);
});

/** Merges `options` over what earlier Givens chose and rebuilds the app; only before anything has been used. */
export const configureApp = Effect.fn("features.scim.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  if (yield* Ref.get(world.started)) {
    return yield* Effect.die(new Error("configure the app before any connection or request exists"));
  }
  const previous = yield* Ref.get(world.options);
  const merged: AppOptions = {
    ...previous,
    ...options,
    scim: { ...previous.scim, ...options.scim },
    organization: { ...previous.organization, ...options.organization },
  };
  yield* Ref.set(world.options, merged);
  const old = yield* Ref.get(world.app);
  yield* old.close;
  yield* Ref.set(world.app, buildApp(merged));
});

export const withContext = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.gen(function* () {
    const app = yield* currentApp;
    return yield* Effect.promise(() => app.withContext(effect));
  });

const ownerPrincipal = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

/** An organization owned by `owner-1`, and a SCIM connection for it: its identity and its bearer token. */
export const seedConnection = Effect.fn("features.scim.seedConnection")(function* (
  connectionName: string,
  organizationName: string,
) {
  const world = yield* World;
  const state = yield* withContext(
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const store = yield* ScimConnections.ScimConnectionStore;
      const org = yield* organization
        .create({
          caller: ownerPrincipal("owner-1"),
          name: organizationName,
          slug: `${organizationName}-${connectionName}`.toLowerCase(),
        })
        .pipe(Effect.orDie);
      const { connection, token } = yield* store
        .create({ organizationId: org.id, name: connectionName })
        .pipe(Effect.orDie);
      return {
        organizationId: org.id,
        identity: {
          id: connection.id,
          organizationId: org.id,
          name: connection.name,
        } satisfies ScimApi.ScimConnectionIdentity,
        token: Redacted.value(token),
      } satisfies ConnectionState;
    }),
  );
  yield* world.connections.set(connectionName, state);
  return state;
});

// ---- requests ----------------------------------------------------------------------------

export interface SendInit {
  readonly method: string;
  readonly path: string;
  /** A literal bearer credential; `undefined` sends none. */
  readonly bearer?: string | undefined;
  readonly cookie?: string | undefined;
  readonly body?: unknown;
  readonly contentType?: string | undefined;
}

export const send = Effect.fn("features.scim.send")(function* (
  init: SendInit,
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const app = yield* currentApp;
  const response = yield* Effect.promise(() =>
    app.handler(
      new Request(`${ORIGIN}${init.path}`, {
        method: init.method,
        headers: {
          ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }),
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
          ...(init.body === undefined
            ? {}
            : { "content-type": init.contentType ?? "application/scim+json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    ),
  );
  const drained = yield* snapshot(response);
  if (options.observe !== true) yield* Ref.set(world.last, drained);
  return drained;
});

/** A request made as the named connection, carrying its bearer token. */
export const sendAs = Effect.fn("features.scim.sendAs")(function* (
  connectionName: string,
  init: Omit<SendInit, "bearer">,
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const connection = yield* world.connections.get(connectionName);
  return yield* send({ ...init, bearer: connection.token }, options);
});

export const lastResponse = Effect.gen(function* () {
  const { last } = yield* World;
  const found = yield* Ref.get(last);
  if (found === undefined) return yield* Effect.die(new Error("no request has been made yet"));
  return found;
});
