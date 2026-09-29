// P20a/AH-003 (decision 36, tier 1): the World for 09-authentication-middleware.feature.
//
// A real `HttpRouter.toWebHandler` app whose probe groups declare the shipped
// authentication middleware (`Authentication`, `OptionalAuthentication`,
// `MachineAuthentication`), served over memory `Sessions`/`Users`, `@awthaq/jwt`'s
// signing stack and the real `@awthaq/api-key` plugin (the machine tier's credentials).
//
// The scenarios make claims about *which handler is tried and in what order*. Effect's
// security middleware tries the declared record's schemes in declaration order and stops
// at the first that succeeds, but no existing seam reports that. So each scheme handler is
// wrapped by `traced` — it records the scheme's name and then delegates unchanged to the
// real handler `Authentication.AuthenticationLive` built — and the `PostAuthResponseHook`
// (the middleware's own extension point, told `context.scheme` on every success) records
// which scheme authenticated. Nothing about resolution is stubbed.
import { Api } from "@awthaq/api";
import { ApiKey, ApiKeyClientRecords, ApiKeyRecords } from "@awthaq/api-key";
import { AuditLog, AuthEvents, Hooks, RateLimits, Sessions, Users } from "@awthaq/core";
import { Jwt, JwtConfig, KeyRing, RevocationStore, SigningKeyRecords } from "@awthaq/jwt";
import { ClientAddress, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { TestServices } from "./shared/Harness.ts";

/**
 * BEH-EA-072: a *different* declaration of the same two schemes, in the opposite order. Its
 * handlers are `Authentication`'s own (delegated to, exactly as `AdminAuthenticationLive`
 * does), so the only thing that differs from `Api.Authentication` is the declared record.
 */
export class ReorderedAuthentication extends HttpApiMiddleware.Service<
  ReorderedAuthentication,
  { provides: Api.CurrentPrincipal }
>()("ReorderedAuthentication", {
  security: { bearer: Api.BearerToken, cookie: Api.SessionCookie },
  error: [Api.Unauthenticated, Api.StoreUnavailable],
}) {}

const Who = Schema.Struct({
  tag: Schema.String,
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  /** Machine principals only: the credential's own grants. */
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

export const ProbeApi = HttpApi.make("probe")
  .add(
    HttpApiGroup.make("app")
      .add(HttpApiEndpoint.get("who", "/app/who", { success: Who }))
      .middleware(Api.Authentication),
  )
  .add(
    HttpApiGroup.make("optional")
      .add(HttpApiEndpoint.get("who", "/optional/who", { success: Who }))
      .middleware(Api.OptionalAuthentication),
  )
  .add(
    HttpApiGroup.make("machine")
      .add(HttpApiEndpoint.get("who", "/machine/who", { success: Who }))
      .middleware(Api.MachineAuthentication),
  )
  .add(
    HttpApiGroup.make("reordered")
      .add(HttpApiEndpoint.get("who", "/reordered/who", { success: Who }))
      .middleware(ReorderedAuthentication),
  )
  // No authentication middleware at all: BEH-EA-070's "neither declared" group.
  .add(HttpApiGroup.make("open").add(HttpApiEndpoint.get("who", "/open/who", { success: Who })));

/** Wraps one scheme handler so the trace records that the scheme was attempted, then delegates unchanged. */
const traced =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    attempts: Ref.Ref<ReadonlyArray<string>>,
    name: string,
    handler: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args) =>
    Ref.update(attempts, (all) => [...all, name]).pipe(Effect.andThen(handler(...args)));

export interface AppOptions {
  /** BEH-EA-072/REQ-EA-202: configuration the middleware could conceivably be influenced by — none of it may change the try-order. */
  readonly variant?: "default" | "userFacts" | "shortIdle" | "claimingResolver";
}

const buildApp = (options: AppOptions) => {
  const attempts = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  const resolvedBy = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  const handlerRuns = Ref.makeUnsafe(0);

  const describePrincipal = Ref.update(handlerRuns, (n) => n + 1).pipe(
    Effect.andThen(Api.CurrentPrincipal),
    Effect.map((principal) => ({
      tag: principal._tag,
      id: principal.ref.id,
      ...(principal._tag === "User" ? { sessionId: principal.sessionId } : {}),
      ...(principal._tag === "ApiKey" || principal._tag === "Service"
        ? { scopes: principal.scopes }
        : {}),
    })),
  );

  const ProbeHandlers = Layer.mergeAll(
    HttpApiBuilder.group(ProbeApi, "app", (handlers) =>
      handlers.handle("who", () => describePrincipal),
    ),
    HttpApiBuilder.group(ProbeApi, "optional", (handlers) =>
      handlers.handle("who", () => describePrincipal),
    ),
    HttpApiBuilder.group(ProbeApi, "machine", (handlers) =>
      handlers.handle("who", () => describePrincipal),
    ),
    HttpApiBuilder.group(ProbeApi, "reordered", (handlers) =>
      handlers.handle("who", () => describePrincipal),
    ),
    // BEH-EA-070: this group's handler asks for `CurrentPrincipal` as an optional service —
    // no middleware in its group provides it, so the read comes back empty.
    HttpApiBuilder.group(ProbeApi, "open", (handlers) =>
      handlers.handle("who", () =>
        Ref.update(handlerRuns, (n) => n + 1).pipe(
          Effect.andThen(Effect.serviceOption(Api.CurrentPrincipal)),
          Effect.map(
            Option.match({
              onNone: () => ({ tag: "absent", id: "" }),
              onSome: (principal) => ({ tag: principal._tag, id: principal.ref.id }),
            }),
          ),
        ),
      ),
    ),
  );

  const TracedAuthentication = Layer.effect(
    Api.Authentication,
    Effect.gen(function* () {
      const real = yield* Api.Authentication;
      return {
        impersonation: traced(attempts, "impersonation", real.impersonation),
        cookie: traced(attempts, "cookie", real.cookie),
        bearer: traced(attempts, "bearer", real.bearer),
      };
    }),
  ).pipe(Layer.provide(Authentication.AuthenticationLive));

  const TracedMachine = Layer.effect(
    Api.MachineAuthentication,
    Effect.gen(function* () {
      const real = yield* Api.MachineAuthentication;
      return {
        impersonation: traced(attempts, "impersonation", real.impersonation),
        cookie: traced(attempts, "cookie", real.cookie),
        apiKey: traced(attempts, "apiKey", real.apiKey),
        bearer: traced(attempts, "bearer", real.bearer),
      };
    }),
  ).pipe(Layer.provide(Authentication.MachineAuthenticationLive));

  const ReorderedLive = Layer.effect(
    ReorderedAuthentication,
    Effect.gen(function* () {
      const auth = yield* Api.Authentication;
      return { bearer: auth.bearer, cookie: auth.cookie };
    }),
  );

  // Records which scheme authenticated, then delegates to whatever hook is installed below
  // (`@awthaq/jwt` overrides the default), so the response is decorated exactly as it would be.
  const RecordingHook = Layer.effect(
    Authentication.PostAuthResponseHook,
    Effect.gen(function* () {
      const inner = yield* Authentication.PostAuthResponseHook;
      return {
        decorate: (principal, response, context) =>
          Ref.update(resolvedBy, (all) => [...all, context.scheme]).pipe(
            Effect.andThen(inner.decorate(principal, response, context)),
          ),
      };
    }),
  );

  const variant = options.variant ?? "default";
  const ResolverLive =
    variant === "userFacts"
      ? Authentication.PrincipalResolverWithUserFactsLive
      : Authentication.PrincipalResolverLive;
  const SessionSettings =
    variant === "shortIdle"
      ? Layer.succeed(Sessions.SessionConfig, {
          absolute: Duration.days(30),
          idle: Duration.hours(1),
          touchEvery: Duration.minutes(10),
        })
      : Layer.empty;
  // A resolver that claims a shape no scenario presents: registered, consulted, and never claiming.
  const ExtraContribution =
    variant === "claimingResolver"
      ? Authentication.contribute("bearer", {
          id: "features.never-claims",
          claims: (raw) => raw.startsWith("never-presented."),
          resolve: () => Effect.fail(new Api.Unauthenticated()),
        })
      : Layer.empty;

  // Order matters: a layer that needs the middleware (the `apikey` group is behind
  // `Authentication`) must sit closer to the routes than the middleware's own layers, and
  // `RecordingHook` closest of all so it wraps whatever hook `Jwt` installs.
  const appLayer = AuthHttp.routes(ProbeApi)
    .pipe(
      Layer.provide(ProbeHandlers),
      Layer.provideMerge(RecordingHook),
      Layer.provideMerge(ApiKey.ApiKey.layer),
      Layer.provideMerge(Jwt.Jwt.layer),
      // The registry sits below every layer that contributes to it.
      Layer.provideMerge(ExtraContribution),
      Layer.provideMerge(Authentication.CredentialResolversLive),
      Layer.provideMerge(
        Layer.mergeAll(ApiKeyRecords.layerMemory, ApiKeyClientRecords.layerMemory),
      ),
      Layer.provideMerge(KeyRing.KeyRing.layer),
      Layer.provideMerge(SigningKeyRecords.layerMemory),
      Layer.provideMerge(RevocationStore.layerMemory),
      Layer.provideMerge(SqlTransaction.layerNoop),
      Layer.provideMerge(ReorderedLive),
      Layer.provideMerge(TracedAuthentication),
      Layer.provideMerge(TracedMachine),
      Layer.provideMerge(Authentication.OptionalAuthenticationLive),
      Layer.provide(ResolverLive),
      // The `apikey` plugin's own management group carries `CsrfProtection`.
      Layer.provide(CsrfProtectionLive),
      Layer.provideMerge(SessionSettings),
    )
    .pipe(
      Layer.provideMerge(Sessions.layerMemory),
      Layer.provideMerge(Users.layerMemory),
      Layer.provideMerge(AuthEvents.layer),
      Layer.provideMerge(AuditLog.layerMemory),
      Layer.provideMerge(Hooks.HooksLive),
      Layer.provideMerge(RateLimits.layer),
      Layer.provideMerge(RateLimiter.layerPermissive),
      Layer.provideMerge(ClientAddress.layerDirect),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(TestServices),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provideMerge(ApiKey.config({})),
      Layer.provideMerge(
        JwtConfig.config({ issuer: "https://issuer.test", audience: "https://api.test" }),
      ),
    );

  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });

  /** Runs `effect` against the very services the handler resolves (same memo map), on the real clock. */
  const withServices = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof appLayer>>) =>
    Effect.promise(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
            return yield* effect.pipe(Effect.provide(context));
          }),
        ),
      ),
    );

  return { handler, withServices, attempts, resolvedBy, handlerRuns };
};

export type AppHandle = ReturnType<typeof buildApp>;

export interface Actor {
  readonly userId: string;
  readonly cookie: string;
  readonly token: string;
  readonly sessionId: string;
}

/** What one request left behind: the answer, and the trace of how the middleware got there. */
export interface Observation {
  readonly status: number;
  readonly tag: string | undefined;
  readonly principalTag: string | undefined;
  readonly id: string | undefined;
  readonly sessionId: string | undefined;
  readonly scopes: ReadonlyArray<string> | undefined;
  /** Scheme handlers the middleware tried, in order. */
  readonly attempts: ReadonlyArray<string>;
  /** The scheme(s) the post-auth hook was told authenticated the request. */
  readonly resolvedBy: ReadonlyArray<string>;
  /** How many times an endpoint handler's own code ran. */
  readonly handlerRuns: number;
}

export interface RequestSpec {
  readonly cookie?: string;
  readonly bearer?: string;
  readonly apiKey?: string;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly actors: Ref.Ref<Readonly<Record<string, Actor>>>;
  /** The request the scenario's Givens are arranging (sent by the When). */
  readonly pending: Ref.Ref<RequestSpec>;
  readonly observations: Ref.Ref<ReadonlyArray<Observation>>;
  readonly outcomes: Ref.Ref<Readonly<Record<string, unknown>>>;
}

export class World extends Context.Service<World, WorldShape>()("features/AuthenticationWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make<AppHandle | undefined>(undefined),
      actors: yield* Ref.make<Readonly<Record<string, Actor>>>({}),
      pending: yield* Ref.make<RequestSpec>({}),
      observations: yield* Ref.make<ReadonlyArray<Observation>>([]),
      outcomes: yield* Ref.make<Readonly<Record<string, unknown>>>({}),
    });
  }),
);

/** Rebuilds this Scenario's app — call before anything has been issued against it. */
export const configureApp = Effect.fn("features.authentication.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  yield* Ref.set(world.app, buildApp(options));
});

export const appHandle = Effect.fn("features.authentication.appHandle")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const fresh = buildApp({});
  yield* Ref.set(world.app, fresh);
  return fresh;
});

/** A real user with a real, live session (and a second, independent one on request). */
export const signIn = Effect.fn("features.authentication.signIn")(function* (name: string) {
  const app = yield* appHandle();
  const world = yield* World;
  const actor = yield* app.withServices(
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({
        identity: { _tag: "Email", email: `${name}@example.com` },
        name,
      });
      const issued = yield* sessions.issue({ userId: user.id });
      const token = Redacted.value(issued.token);
      return {
        userId: user.id,
        cookie: `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        token,
        sessionId: issued.session.id,
      };
    }),
  );
  yield* Ref.update(world.actors, (existing) => ({ ...existing, [name]: actor }));
  return actor;
});

/** A further live session for the same user — a credential distinct from the first, so a scenario can tell which one resolved. */
export const issueSecondSession = Effect.fn("features.authentication.issueSecondSession")(
  function* (name: string) {
    const app = yield* appHandle();
    const actor = yield* getActor(name);
    return yield* app.withServices(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(actor.userId) });
        const token = Redacted.value(issued.token);
        return {
          cookie: `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          token,
          sessionId: issued.session.id,
        };
      }),
    );
  },
);

/** A session that has already expired (a one-millisecond absolute lifetime, waited out on the real clock). */
export const expiredSessionCookie = Effect.fn("features.authentication.expiredSessionCookie")(
  function* () {
    const app = yield* appHandle();
    const cookie = yield* app.withServices(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "expired-holder@example.com" },
          name: "expired-holder",
        });
        const issued = yield* sessions.issue({
          userId: user.id,
          absoluteDuration: Duration.millis(1),
        });
        return `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    return cookie;
  },
);

export const getActor = Effect.fn("features.authentication.getActor")(function* (name: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.actors))[name];
  if (found === undefined) return yield* Effect.die(new Error(`no actor named "${name}"`));
  return found;
});

export const arrange = Effect.fn("features.authentication.arrange")(function* (spec: RequestSpec) {
  const world = yield* World;
  yield* Ref.update(world.pending, (existing) => ({ ...existing, ...spec }));
});

const ErrorBody = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

/** Sends one GET to `path` carrying `spec`, and records what came back and how the middleware got there. */
export const send = Effect.fn("features.authentication.send")(function* (
  path: string,
  spec: RequestSpec,
) {
  const app = yield* appHandle();
  const world = yield* World;
  yield* Ref.set(app.attempts, []);
  yield* Ref.set(app.resolvedBy, []);
  yield* Ref.set(app.handlerRuns, 0);
  const cookies = spec.cookie === undefined ? [] : [spec.cookie];
  const response = yield* Effect.promise(() =>
    app.handler(
      new Request(`http://localhost${path}`, {
        method: "GET",
        headers: {
          ...(cookies.length === 0 ? {} : { cookie: cookies.join("; ") }),
          ...(spec.bearer === undefined ? {} : { authorization: `Bearer ${spec.bearer}` }),
          ...(spec.apiKey === undefined ? {} : { [Api.API_KEY_HEADER_NAME]: spec.apiKey }),
        },
      }),
    ),
  );
  const body = Schema.decodeUnknownSync(ErrorBody)(yield* Effect.promise(() => response.json()));
  const observation: Observation = {
    status: response.status,
    tag: body._tag,
    principalTag: body.tag,
    id: body.id,
    sessionId: body.sessionId,
    scopes: body.scopes,
    attempts: yield* Ref.get(app.attempts),
    resolvedBy: yield* Ref.get(app.resolvedBy),
    handlerRuns: yield* Ref.get(app.handlerRuns),
  };
  yield* Ref.update(world.observations, (all) => [...all, observation]);
  return observation;
});

export const lastObservation = Effect.fn("features.authentication.lastObservation")(function* () {
  const world = yield* World;
  const all = yield* Ref.get(world.observations);
  const last = all[all.length - 1];
  if (last === undefined) return yield* Effect.die(new Error("no request has been sent yet"));
  return last;
});

export const setOutcome = Effect.fn("features.authentication.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const world = yield* World;
  yield* Ref.update(world.outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.authentication.getOutcome")(function* (key: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.outcomes))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no outcome recorded for "${key}"`));
  return found;
});

/**
 * REQ-EA-195: a machine caller's credentials, minted through the real `ApiKey` service: an
 * API key (`x-api-key`) and, from a registered client, a short-lived service bearer token.
 */
export const mintMachineCredentials = Effect.fn("features.authentication.mintMachineCredentials")(
  function* () {
    const app = yield* appHandle();
    return yield* app.withServices(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const apiKeys = yield* ApiKey.ApiKey;
        const owner = yield* users.create({
          identity: { _tag: "Email", email: "machine-owner@example.com" },
          name: "machine-owner",
        });
        const created = yield* apiKeys.create(owner.id, {
          name: "ci",
          scopes: ["reports:read"],
        });
        const client = yield* apiKeys.registerClient(owner.id, {
          name: "worker",
          scopes: ["reports:read"],
        });
        const issued = yield* apiKeys.issueServiceToken({
          clientId: client.view.clientId,
          clientSecret: client.clientSecret,
        });
        return {
          keyId: created.view.id,
          apiKey: Redacted.value(created.key),
          clientId: client.view.clientId,
          serviceToken: Redacted.value(issued.accessToken),
        };
      }).pipe(Effect.orDie),
    );
  },
);

/** BEH-EA-069/REQ-EA-194: the resolver, run directly over the live session `Sessions.verify` resolves from the actor's own token. */
export const resolveSessionPrincipal = Effect.fn("features.authentication.resolveSessionPrincipal")(
  function* (token: string) {
    const app = yield* appHandle();
    return yield* app.withServices(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        // The default resolver, on its own: a session is all it needs.
        const resolver = yield* Authentication.PrincipalResolver.pipe(
          Effect.provide(Authentication.PrincipalResolverLive),
        );
        const { session } = yield* sessions.verify(Redacted.make(token));
        return yield* resolver.resolve(session);
      }).pipe(Effect.orDie),
    );
  },
);

/** REQ-EA-195: the principal-only wrapper Path B calls, over a machine credential. */
export const resolveCredentialPrincipal = Effect.fn(
  "features.authentication.resolveCredentialPrincipal",
)(function* (credential: string, scheme: "apiKey" | "bearer") {
  const app = yield* appHandle();
  return yield* app.withServices(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const resolver = yield* Authentication.PrincipalResolver.pipe(
        Effect.provide(Authentication.PrincipalResolverLive),
      );
      return yield* Authentication.resolvePrincipal(
        sessions,
        resolver,
        Redacted.make(credential),
        scheme,
      );
      // A claiming resolver may read the request (e.g. to rate-limit by address); Path B has one too.
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/")),
      ),
      Effect.orDie,
    ),
  );
});

export const pendingRequest = Effect.fn("features.authentication.pendingRequest")(function* () {
  const world = yield* World;
  return yield* Ref.get(world.pending);
});

/** The one actor a scenario without a name in its step text is about. */
export const soleActor = Effect.fn("features.authentication.soleActor")(function* () {
  const world = yield* World;
  const actors = Object.values(yield* Ref.get(world.actors));
  const [actor] = actors;
  if (actor === undefined || actors.length !== 1) {
    return yield* Effect.die(new Error(`expected exactly one actor, found ${actors.length}`));
  }
  return actor;
});
