// P20a (tenancy follow-up to AH-003): the compositions 28-tenancy.feature runs against.
//
// Three independent stacks, each rebuilt per scenario, because the rules under test live in
// different strata:
//
//  - `identity`: `Users`/`Accounts`/`Sessions`/`Verification`/`AuditLog` over a real in-memory
//    SQLite database migrated by core's own migrations. Tenant *stamping* (BEH-EA-231) and the
//    global identity directory (BEH-EA-232) are properties of the repositories and of the
//    schema's unique constraints, which the memory twins cannot show.
//  - `organizations`: the Organization plugin over its memory records, plus `AdminTenants`
//    (suspension, BEH-EA-237), the qadi `relationships` resolver and the application's
//    per-tenant configuration map (BEH-EA-236). It shares one `OrganizationRecords` with the
//    gateway below, so an organization a step creates is the one the middleware resolves.
//  - `connections` and the OAuth compositions (BEH-EA-235): the per-organization connection
//    store and the resolver `@awthaq/oauth` consults after its static registry.
//
// The tenant middleware (BEH-EA-234/236) is exercised as what it is, a global router
// middleware, behind `HttpRouter.toWebHandler`.
import { Api } from "@awthaq/api";
import { Admin, AdminTenants } from "@awthaq/admin";
import { AuditLog, AuthEvents, Accounts, Hooks, Sessions, Users, Verification } from "@awthaq/core";
import {
  ConnectionRecords,
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationConnections,
  OrganizationHooks,
  OrganizationQadi,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
  TenantMiddleware,
  TenantResolver,
} from "@awthaq/organization";
import { OAuth, OAuthConnections, OAuthProvider } from "@awthaq/oauth";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  RateLimiter,
  SqlTransaction,
  Tenant,
} from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import { RateLimits } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { RelationshipResolver } from "@qadi/core";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { makeNamedRegistry, TestServices } from "./shared/Harness.ts";

type NamedRegistry<A> = ReturnType<typeof makeNamedRegistry<A>>;

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

// ---- the identity stack: real rows ------------------------------------------------------

/** What a step may ask of the identity composition. */
export type IdentityServices =
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | Verification.Verification
  | AuthEvents.AuthEvents
  | AuditLog.AuditLog
  | Repositories.UsersRepository
  | SqlClient.SqlClient;

const buildIdentityStack = () => {
  const SqlLive = SqliteClient.layer({ filename: ":memory:" });
  const Migrated = Layer.effectDiscard(
    Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
  ).pipe(Layer.provide(SqlLive));
  const Stores = Layer.mergeAll(
    Users.layerSql.pipe(Layer.provide(Repositories.UsersRepositoryLive)),
    Repositories.UsersRepositoryLive,
    Accounts.layerSql.pipe(
      Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive))),
    ),
    Sessions.layerSql.pipe(Layer.provide(Repositories.SessionsRepositoryLive)),
    Verification.layerSql.pipe(
      Layer.provide(
        Layer.mergeAll(
          Repositories.VerificationRepositoryLive,
          Repositories.VerificationReservationsRepositoryLive,
        ),
      ),
    ),
    SqlTransaction.layerSql,
  );
  return Stores.pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerSql.pipe(Layer.provide(Repositories.AuditLogRepositoryLive))),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );
};

// ---- the organization stack -------------------------------------------------------------

/** The application's own per-tenant settings, keyed by tenant id (a database table in real life). */
export const tenantLimits = new Map<string, number>();

/** Names an `Organization.config` per tenant; the request-level layer the tenant middleware provides. */
export class TenantConfig extends LayerMap.Service<TenantConfig>()(
  "features/TenancyWorld/TenantConfig",
  {
    lookup: (tenantId: string) =>
      Layer.merge(
        Organization.config({ membershipLimit: tenantLimits.get(tenantId) ?? 50 }),
        Tenant.configApplied(tenantId),
      ),
    idleTimeToLive: "1 minute",
  },
) {}

/** The build-time membership limit the organization composition is built with. */
export const BUILD_TIME_MEMBERSHIP_LIMIT = 3;

/** The one platform administrator the composition recognises (`canAdministerTenants`). */
export const PLATFORM_ADMIN = "superadmin";

export type OrganizationServices =
  | Organization.Organization
  | OrganizationRecords.OrganizationRecords
  | AdminTenants.AdminTenants
  | AuditLog.AuditLog
  | TenantConfig
  | RelationshipResolver;

const buildOrganizationStack = () => {
  const AuthenticationLive = Authentication.AuthenticationLive.pipe(
    Layer.provide(Authentication.PrincipalResolverLive),
  );
  const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
    Layer.provide(AuthenticationLive),
  );
  const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
    Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
    Layer.provide(NodeCrypto.layer),
  );
  const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Layer.mergeAll(
    AdminTenants.AdminTenants.layer,
    OrganizationQadi.relationships.pipe(
      Layer.provide(OrganizationQadi.ResourceOrganizationLookup.layerNone),
    ),
    TenantConfig.layer,
  ).pipe(
    Layer.provideMerge(
      Organization.Organization.layer.pipe(
        Layer.provide(Organization.config({ membershipLimit: BUILD_TIME_MEMBERSHIP_LIMIT })),
        Layer.provide(AuthenticationLive),
      ),
    ),
    Layer.provide(
      Admin.config({
        canAdministerTenants: ({ admin }) => Effect.succeed(admin.id === PLATFORM_ADMIN),
      }),
    ),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(OrganizationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
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

// ---- the OAuth connection store ----------------------------------------------------------

export type ConnectionServices =
  | OrganizationConnections.OrganizationConnectionStore
  | ConnectionRecords.ConnectionRecords;

const buildConnectionStack = () =>
  Layer.mergeAll(OrganizationConnections.layerStore, OrganizationConnections.oauthConnections).pipe(
    Layer.provideMerge(OrganizationConnections.OrganizationConnections.layer),
    Layer.provideMerge(ConnectionRecords.layerMemory),
    Layer.provideMerge(EncryptionLive),
    Layer.provideMerge(NodeCrypto.layer),
  );

const NoProviderTransport = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 404 }))),
  ),
);

/** A plain OAuth2 provider with explicit endpoints: `authorize` needs no discovery round trip. */
export const staticProvider = (id: string) =>
  OAuthProvider.oauth2({
    id,
    clientId: Config.succeed(`${id}-client-id`),
    clientSecret: Config.succeed(Redacted.make(`${id}-secret`)),
    scopes: ["read"],
    endpoints: {
      authorizationEndpoint: `https://${id}.example.com/authorize`,
      tokenEndpoint: `https://${id}.example.com/token`,
      userinfoEndpoint: `https://${id}.example.com/userinfo`,
    },
    mapProfile: (claims) => ({ subject: String(claims["id"]) }),
  });

export const OAUTH_BASE_URL = "https://app.example.com";

/** `OAuth` over memory identity stores, with the given static providers and (optionally) the connection resolver. */
const buildOAuthLayer = (
  providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>,
  connections: OAuthConnections.OAuthConnectionResolverShape | undefined,
) => {
  const CoreLive = Layer.mergeAll(
    Users.layerMemory,
    Accounts.layerMemory,
    Sessions.layerMemory,
    Verification.layerMemory,
  ).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return OAuth.OAuth.layer.pipe(
    Layer.provide(connections === undefined ? Layer.empty : OAuthConnections.layer(connections)),
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(NoProviderTransport),
    Layer.provide(
      OAuth.config({
        providers,
        linking: "explicit",
        trustedOrigins: [],
        baseUrl: OAUTH_BASE_URL,
        retry: { base: Duration.zero },
      }),
    ),
  );
};

// ---- the tenant-middleware gateway -------------------------------------------------------

export type GatewayVariant = "none" | "plain" | "rls" | "config";

export interface GatewayProbe {
  /** How many times the application's `TenantResolver` ran. */
  readonly resolverCalls: Ref.Ref<number>;
  /** How many times a route handler ran behind the middleware. */
  readonly handlerRuns: Ref.Ref<number>;
}

const buildGateway = (
  variant: GatewayVariant,
  records: OrganizationRecords.OrganizationRecordsShape,
  sql: SqlClient.SqlClient,
  probe: GatewayProbe,
) => {
  /** Reports the ambient tenant the handler's fiber sees. */
  const whoami = HttpRouter.add(
    "GET",
    "/whoami",
    Effect.gen(function* () {
      yield* Ref.update(probe.handlerRuns, (runs) => runs + 1);
      const tenant = yield* Tenant.TenantContext;
      return HttpServerResponse.jsonUnsafe({ tenant: Option.getOrNull(tenant) });
    }),
  );
  /** Reports the membership limit of the configuration in force for the handler's fiber. */
  const limit = HttpRouter.add(
    "GET",
    "/limit",
    Effect.gen(function* () {
      const config = yield* Organization.OrganizationConfig;
      const applied = yield* Effect.serviceOption(Tenant.TenantConfigApplied);
      return HttpServerResponse.jsonUnsafe({
        membershipLimit: config.membershipLimit,
        appliedTenant: Option.match(applied, { onNone: () => null, onSome: (a) => a.tenantId }),
      });
    }),
  );
  const routes = Layer.mergeAll(whoami, limit);
  // The application's own routing convention: an `x-tenant` header naming the organization id.
  const resolver = TenantResolver.TenantResolver.layer((request) =>
    Ref.update(probe.resolverCalls, (calls) => calls + 1).pipe(
      Effect.as(Option.fromNullishOr(request.headers["x-tenant"])),
    ),
  );
  // One web handler per variant: the middleware layers have different requirements, so each
  // variant is finished (and turned into a handler) on its own rather than through a union.
  const finish = <
    R extends
      | HttpRouter.HttpRouter
      | OrganizationRecords.OrganizationRecords
      | TenantResolver.TenantResolver
      | SqlClient.SqlClient
      | TenantConfig,
  >(
    middleware: Layer.Layer<never, never, R>,
  ) =>
    HttpRouter.toWebHandler(
      routes.pipe(
        Layer.provide(middleware),
        Layer.provide(resolver),
        Layer.provide(Layer.succeed(OrganizationRecords.OrganizationRecords, records)),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        Layer.provide(TenantConfig.layer),
        Layer.provideMerge(TestServices),
        Layer.provideMerge(HttpRouter.layer),
      ),
    );
  switch (variant) {
    case "plain":
      return finish(TenantMiddleware.layer);
    case "rls":
      return finish(TenantMiddleware.layerWithRls);
    case "config":
      return finish(TenantMiddleware.layerWithConfig(TenantConfig));
    case "none":
      return finish(Layer.empty);
  }
};

// ---- the World ---------------------------------------------------------------------------

/** An organization-plugin caller a scenario names. */
export const callerOf = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: `${id}-session`,
  });

/** What a scenario remembers about a connection an organization stored. */
export interface StoredConnection {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly providerId: string;
  /** The property names of the view the store returned, so "never shown back" is checkable. */
  readonly viewKeys: ReadonlyArray<string>;
  readonly hasClientSecret: boolean;
}

export interface OAuthComposition {
  readonly oauth: OAuth.OAuthShape;
  /** Provider ids the connection resolver was asked about (only when the composition wraps it in a counter). */
  readonly consulted: Ref.Ref<ReadonlyArray<string>>;
}

export interface WorldShape {
  readonly identity: Context.Context<IdentityServices>;
  readonly organizations: Context.Context<OrganizationServices>;
  readonly connections: Context.Context<ConnectionServices>;
  readonly gatewayProbe: GatewayProbe;
  readonly gatewayVariant: Ref.Ref<GatewayVariant | undefined>;
  readonly gateway: Ref.Ref<((request: Request) => Promise<Response>) | undefined>;
  /** Builds (once) and returns the web handler for the variant a Given installed. */
  readonly serve: (request: Request) => Promise<Response>;
  readonly buildOAuth: (
    providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>,
    connections: OAuthConnections.OAuthConnectionResolverShape | undefined,
  ) => Effect.Effect<OAuth.OAuthShape>;

  /** The ambient tenant the next operation runs under (`Option.none()`: none provided). */
  readonly ambient: Ref.Ref<Option.Option<string>>;
  readonly readInside: Ref.Ref<Option.Option<Option.Option<string>>>;
  readonly readAfter: Ref.Ref<Option.Option<Option.Option<string>>>;
  readonly readOutside: Ref.Ref<Option.Option<Option.Option<string>>>;
  /** Users a scenario created, in order ("the first user", "that user" = the last). */
  readonly userIds: Ref.Ref<ReadonlyArray<Users.UserId>>;
  /** The tenant the most recently observed user row carries. */
  readonly userTenant: Ref.Ref<Option.Option<string>>;
  readonly sessionTenant: Ref.Ref<Option.Option<string>>;
  readonly sessionToken: Ref.Ref<Option.Option<Redacted.Redacted<string>>>;
  readonly storedTenants: Ref.Ref<ReadonlyArray<string | null>>;
  readonly decodedCreate: Ref.Ref<Option.Option<object>>;
  readonly outcomes: NamedRegistry<string>;
  readonly lookups: NamedRegistry<boolean>;

  /** People (`callerOf`) and organizations (id) by the names the Gherkin text uses. */
  readonly people: NamedRegistry<Api.UserPrincipal>;
  readonly organizationIds: NamedRegistry<string>;
  readonly responses: NamedRegistry<{ readonly status: number; readonly body: unknown }>;
  readonly connectionIds: NamedRegistry<StoredConnection>;
  readonly oauthCompositions: Ref.Ref<Option.Option<OAuthComposition>>;
  readonly redirects: NamedRegistry<string>;
  readonly memberCounter: Ref.Ref<number>;
  readonly suspensions: NamedRegistry<string>;
}

export class World extends Context.Service<World, WorldShape>()("features/TenancyWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    // Built on the real clock, outside the step's TestClock, like every wire-level World: a
    // service that reads the clock when it is built would otherwise be pinned to 1970.
    const scope = Scope.makeUnsafe();
    const build = <A, E>(layer: Layer.Layer<A, E>) =>
      Effect.promise(() =>
        Effect.runPromise(Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope)),
      );
    const identity = yield* build(buildIdentityStack());
    const organizations = yield* build(buildOrganizationStack());
    const connections = yield* build(buildConnectionStack());
    const disposers: Array<() => Promise<void>> = [];
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Scope.close(scope, Exit.void),
        Effect.promise(() => Promise.all(disposers.map((dispose) => dispose()))),
      ),
    );

    const gatewayProbe: GatewayProbe = {
      resolverCalls: Ref.makeUnsafe(0),
      handlerRuns: Ref.makeUnsafe(0),
    };
    const gatewayVariant = Ref.makeUnsafe<GatewayVariant | undefined>(undefined);
    const gateway = Ref.makeUnsafe<((request: Request) => Promise<Response>) | undefined>(
      undefined,
    );
    const records = Context.get(organizations, OrganizationRecords.OrganizationRecords);
    const sql = Context.get(identity, SqlClient.SqlClient);
    const serve = async (request: Request) => {
      const existing = Effect.runSync(Ref.get(gateway));
      if (existing !== undefined) return existing(request);
      const variant = Effect.runSync(Ref.get(gatewayVariant));
      if (variant === undefined) throw new Error("no tenant middleware variant was chosen");
      const web = buildGateway(variant, records, sql, gatewayProbe);
      disposers.push(() => web.dispose());
      Effect.runSync(Ref.set(gateway, web.handler));
      return web.handler(request);
    };

    const buildOAuth: WorldShape["buildOAuth"] = (providers, resolver) =>
      Effect.promise(async () => {
        const context = await Effect.runPromise(
          Layer.buildWithMemoMap(
            buildOAuthLayer(providers, resolver),
            Layer.makeMemoMapUnsafe(),
            scope,
          ),
        );
        return Context.get(context, OAuth.OAuth);
      });

    return World.of({
      identity,
      organizations,
      connections,
      gatewayProbe,
      gatewayVariant,
      gateway,
      serve,
      buildOAuth,
      ambient: Ref.makeUnsafe<Option.Option<string>>(Option.none()),
      readInside: Ref.makeUnsafe<Option.Option<Option.Option<string>>>(Option.none()),
      readAfter: Ref.makeUnsafe<Option.Option<Option.Option<string>>>(Option.none()),
      readOutside: Ref.makeUnsafe<Option.Option<Option.Option<string>>>(Option.none()),
      userIds: Ref.makeUnsafe<ReadonlyArray<Users.UserId>>([]),
      userTenant: Ref.makeUnsafe<Option.Option<string>>(Option.none()),
      sessionTenant: Ref.makeUnsafe<Option.Option<string>>(Option.none()),
      sessionToken: Ref.makeUnsafe<Option.Option<Redacted.Redacted<string>>>(Option.none()),
      storedTenants: Ref.makeUnsafe<ReadonlyArray<string | null>>([]),
      decodedCreate: Ref.makeUnsafe<Option.Option<object>>(Option.none()),
      outcomes: makeNamedRegistry<string>("outcome"),
      lookups: makeNamedRegistry<boolean>("lookup"),
      people: makeNamedRegistry<Api.UserPrincipal>("person"),
      organizationIds: makeNamedRegistry<string>("organization"),
      responses: makeNamedRegistry<{ readonly status: number; readonly body: unknown }>("response"),
      connectionIds: makeNamedRegistry<StoredConnection>("connection"),
      oauthCompositions: Ref.makeUnsafe<Option.Option<OAuthComposition>>(Option.none()),
      redirects: makeNamedRegistry<string>("redirect"),
      memberCounter: Ref.makeUnsafe(0),
      suspensions: makeNamedRegistry<string>("suspension"),
    });
  }),
);

/**
 * Runs an identity-stack effect on the composition's own rows, under the scenario's ambient
 * tenant (a step that names its own tenant overrides it for that effect). A typed failure is a
 * defect here; `outcomeTag` observes one.
 */
export const identity = <A, E>(effect: Effect.Effect<A, E, IdentityServices>) =>
  Effect.gen(function* () {
    const world = yield* World;
    const ambient = yield* Ref.get(world.ambient);
    const scoped = Option.match(ambient, {
      onNone: () => effect,
      onSome: (id) => Tenant.withTenant(id)(effect),
    });
    return yield* Effect.provide(scoped, world.identity).pipe(Effect.orDie);
  });

/** Runs an organization-stack effect; a typed failure is a defect (use `organizationOutcome` to observe one). */
export const organization = <A, E>(effect: Effect.Effect<A, E, OrganizationServices>) =>
  Effect.gen(function* () {
    const world = yield* World;
    return yield* Effect.provide(effect, world.organizations).pipe(Effect.orDie);
  });

/**
 * The typed failure's tag of `effect` (or `"success"`): the outcome a refusal scenario reads
 * back. A defect stays a defect, so an unexpected crash never masquerades as a refusal.
 */
export const outcomeTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => "success" }),
    Effect.orDie,
  );
