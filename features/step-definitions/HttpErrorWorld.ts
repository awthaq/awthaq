// P20a/AH-003 (decision 36, tier 1): the World for 11-http-error-mapping.feature.
//
// Every composition here goes through `Auth.make` and `@awthaq/test`'s `TestAuth.layer` (the
// memory bundle P10 shipped, ETVS-004): the shipped `Password` plugin, two small plugins of the
// World's own (`invite`, a stand-in for a plugin authored by someone else, and `errors`, whose
// endpoints fail with the contract's tagged errors on demand), and an application group added
// through `extraGroups`. What the scenarios then observe is real wiring: the group services a
// plugin's layer provides (their keys derive from the group id alone, BEH-EA-082), the routes
// and documents `AuthHttp` serves, and the status a client sees.
import { Api } from "@awthaq/api";
import { ApiKey, ApiKeyClientRecords, ApiKeyRecords } from "@awthaq/api-key";
import { Auth, AuthPlugin, Sessions, Users } from "@awthaq/core";
import { Jwt, JwtConfig, KeyRing, RevocationStore, SigningKeyRecords } from "@awthaq/jwt";
import { Password } from "@awthaq/password";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CSRF_TEST_COOKIE_VALUE, CsrfConfigForTests, withCsrfCookie } from "./CsrfTestSupport.ts";

// ---- the World's own plugins ------------------------------------------------------------

/** A plugin "authored by someone else": one group, namespaced under its own id (BEH-EA-004). */
const InviteApi = HttpApi.make("auth").add(
  HttpApiGroup.make("invite").add(
    HttpApiEndpoint.get("ping", "/invite/ping", { success: Schema.String }),
  ),
);
const InviteHandlers = HttpApiBuilder.group(InviteApi, "invite", (handlers) =>
  handlers.handle("ping", () => Effect.succeed("pong")),
);
export class InvitePlugin extends AuthPlugin.Service<InvitePlugin, Record<string, never>>()(
  "invite",
  { apiVersion: 1, contract: InviteApi, tables: [] },
) {
  static readonly layer = AuthPlugin.layer(InvitePlugin, {
    make: Effect.succeed({}),
    handlers: InviteHandlers,
  });
}

/** BEH-EA-088: a status no table anywhere could know about — only the error's own annotation says 418. */
export class Teapot extends Schema.TaggedError<Teapot>()("Teapot", {}, { httpApiStatus: 418 }) {}

const ErrorsApi = HttpApi.make("auth").add(
  HttpApiGroup.make("errors").add(
    HttpApiEndpoint.get("unauthenticated", "/errors/unauthenticated", {
      error: [Api.Unauthenticated],
    }),
    HttpApiEndpoint.get("invalidCredentials", "/errors/invalid-credentials", {
      error: [Api.InvalidCredentials],
    }),
    HttpApiEndpoint.get("csrfRejected", "/errors/csrf-rejected", { error: [Api.CsrfRejected] }),
    HttpApiEndpoint.get("teapot", "/errors/teapot", { error: [Teapot] }),
    HttpApiEndpoint.get("rateLimited", "/errors/rate-limited", { error: [Api.RateLimited] }),
  ),
);
const ErrorsHandlers = HttpApiBuilder.group(ErrorsApi, "errors", (handlers) =>
  handlers
    .handle("unauthenticated", () => Effect.fail(new Api.Unauthenticated()))
    .handle("invalidCredentials", () => Effect.fail(new Api.InvalidCredentials()))
    .handle("csrfRejected", () => Effect.fail(new Api.CsrfRejected()))
    .handle("teapot", () => Effect.fail(new Teapot()))
    .handle("rateLimited", () => Effect.fail(new Api.RateLimited({ retryAfterMillis: 1000 }))),
);
export class ErrorsPlugin extends AuthPlugin.Service<ErrorsPlugin, Record<string, never>>()(
  "errors",
  { apiVersion: 1, contract: ErrorsApi, tables: [] },
) {
  static readonly layer = AuthPlugin.layer(ErrorsPlugin, {
    make: Effect.succeed({}),
    handlers: ErrorsHandlers,
  });
}

/** An application's own group, added beside the plugins' through `Auth.make`'s `extraGroups`. */
export const WidgetGroup = HttpApiGroup.make("widgets").add(
  HttpApiEndpoint.get("list", "/widgets", { success: Schema.String }),
);
const WidgetApi = HttpApi.make("auth").add(WidgetGroup);
const WidgetHandlers = HttpApiBuilder.group(WidgetApi, "widgets", (handlers) =>
  handlers.handle("list", () => Effect.succeed("widgets")),
);

// ---- compositions ----------------------------------------------------------------------

export const builtPassword = Auth.make([Password.Password]);
export const builtInvite = Auth.make([InvitePlugin]);
export const builtPasswordInvite = Auth.make([Password.Password, InvitePlugin]);
export const builtErrors = Auth.make([ErrorsPlugin]);
export const builtPasswordWithApp = Auth.make([Password.Password], { extraGroups: [WidgetGroup] });

/** No breach corpus matches anything: the breach check is not what these scenarios are about. */
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** The layers that are genuinely the host's own: middleware and the outbound client. */
export const hostServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests))),
  NoBreachHttpClient,
);

/**
 * A plugin from a separate package with existence-sensitive endpoints (REQ-EA-237): `@awthaq/api-key`
 * over `@awthaq/jwt`, whose key-management endpoints answer for keys that do or do not exist.
 */
export const builtApiKey = Auth.make([Jwt.Jwt, ApiKey.ApiKey]);
const apiKeyServices = Layer.mergeAll(
  hostServices,
  Authentication.CredentialResolversLive,
  RevocationStore.layerMemory,
  ApiKeyRecords.layerMemory,
  ApiKeyClientRecords.layerMemory,
  ApiKey.config({}),
).pipe(
  Layer.provideMerge(KeyRing.KeyRing.layer),
  Layer.provideMerge(SigningKeyRecords.layerMemory),
  Layer.provideMerge(
    JwtConfig.config({ issuer: "https://issuer.test", audience: "https://api.test" }),
  ),
);

export const OPENAPI_PATH = "/auth/openapi.json";
export const DOCS_PATH = "/auth/docs";

/**
 * A running composition: the web handler `HttpRouter.toWebHandler` gives a Next.js/Hono host,
 * and a way to reach the very services that handler runs against (same memo map).
 */
const makeApp = <A, E>(appLayer: Layer.Layer<A, E>) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
  // The handler's own runtime builds the layer lazily and keeps it alive; reaching the services
  // *after* it has (a request to no route builds it) shares those very instances through the memo
  // map. Building first and releasing would make the handler rebuild — and re-register every route.
  const warm = Effect.promise(() => handler(new Request("http://localhost/__warm-up")));
  const withContext = <X, EX>(effect: Effect.Effect<X, EX, A>) =>
    warm.pipe(
      Effect.andThen(
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
        ),
      ),
    );
  /**
   * The `HttpApiGroup` services the composition's plugin layers provide: their key (derived from
   * the group id alone) and the endpoints each one implements.
   */
  const groups = withContext(
    Effect.context<A>().pipe(
      Effect.map((context) => {
        const found = new Map<string, ReadonlyArray<string>>();
        for (const [key, value] of context.mapUnsafe) {
          if (key.startsWith(GROUP_KEY_PREFIX) && value?.handlers instanceof Map) {
            found.set(key, [...value.handlers.keys()].sort());
          }
        }
        return found;
      }),
    ),
  );
  return { handler, withContext, groups, layer: appLayer };
};

export const GROUP_KEY_PREFIX = "effect/httpapi/HttpApiGroup/";

export const passwordRoutes = TestAuth.layer(builtPassword, hostServices, {
  openapiPath: OPENAPI_PATH,
  docsPath: DOCS_PATH,
});
export const passwordApp = () => makeApp(passwordRoutes);
export const inviteApp = () => makeApp(TestAuth.layer(builtInvite, hostServices));
export const passwordInviteApp = () =>
  makeApp(
    TestAuth.layer(builtPasswordInvite, hostServices, {
      openapiPath: OPENAPI_PATH,
      docsPath: DOCS_PATH,
    }),
  );
export const errorsApp = () => makeApp(TestAuth.layer(builtErrors, hostServices));
export const passwordWithAppApp = () =>
  makeApp(
    TestAuth.layer(builtPasswordWithApp, Layer.mergeAll(hostServices, WidgetHandlers), {
      openapiPath: OPENAPI_PATH,
    }),
  );
export const apiKeyApp = () => makeApp(TestAuth.layer(builtApiKey, apiKeyServices));

/** BEH-EA-087: `ManagedRuntime.make(AuthLive)` over the same layer the routed composition serves. */
export const makeRuntimeAndRouted = () => {
  const authLive = TestAuth.layer(builtPassword, hostServices);
  const runtime = ManagedRuntime.make(authLive);
  const { handler } = HttpRouter.toWebHandler(authLive, { memoMap: runtime.memoMap });
  return { runtime, routed: handler };
};

export type PasswordApp = ReturnType<typeof passwordApp>;
export type RuntimeApp = ReturnType<typeof makeRuntimeAndRouted>;

/**
 * REQ-EA-238/239: a route handler of a host that is not built on `HttpRouter` (a Hono `app.get`,
 * say), calling into awthaq only through `runtime.runPromise`. It resolves the session with
 * `Authentication.resolvePrincipal` — the function the `Authentication` middleware itself runs —
 * so no domain logic is written a second time for imperative callers.
 */
export const imperativeMe = async (
  runtime: RuntimeApp["runtime"],
  cookieHeader: string,
): Promise<Response> => {
  const token = cookieHeader
    .split("; ")
    .map((pair) => pair.split("="))
    .find(([name]) => name === Api.SESSION_COOKIE_NAME)?.[1];
  if (token === undefined) return new Response(null, { status: 401 });
  const principal = await runtime.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const resolver = yield* Authentication.PrincipalResolver.pipe(
        Effect.provide(Authentication.PrincipalResolverLive),
      );
      return yield* Authentication.resolvePrincipal(
        sessions,
        resolver,
        Redacted.make(token),
        "cookie",
      );
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("http://localhost/")),
      ),
      Effect.option,
    ),
  );
  return Option.match(principal, {
    onNone: () => new Response(null, { status: 401 }),
    onSome: (found) => Response.json({ userId: found.ref.id }),
  });
};

export const useRuntimeApp = Effect.fn("features.httpError.useRuntimeApp")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.runtimeApp);
  if (existing !== undefined) return existing;
  const fresh = makeRuntimeAndRouted();
  yield* Ref.set(world.runtimeApp, fresh);
  return fresh;
});

// ---- scenario state --------------------------------------------------------------------

/** What one response looked like, reduced to what "identical status and body" compares. */
export interface Answer {
  readonly status: number;
  readonly body: string;
  readonly tag: string | undefined;
}

export interface WorldShape {
  /** Web handlers by the name a step gave them; their group keys are captured alongside. */
  readonly handlers: Ref.Ref<Readonly<Record<string, (request: Request) => Promise<Response>>>>;
  readonly groups: Ref.Ref<Readonly<Record<string, ReadonlyMap<string, ReadonlyArray<string>>>>>;
  readonly passwordApp: Ref.Ref<PasswordApp | undefined>;
  readonly runtimeApp: Ref.Ref<RuntimeApp | undefined>;
  readonly outcomes: Ref.Ref<Readonly<Record<string, unknown>>>;
}

export class World extends Context.Service<World, WorldShape>()("features/HttpErrorWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      handlers: yield* Ref.make<Readonly<Record<string, (request: Request) => Promise<Response>>>>(
        {},
      ),
      groups: yield* Ref.make<Readonly<Record<string, ReadonlyMap<string, ReadonlyArray<string>>>>>(
        {},
      ),
      passwordApp: yield* Ref.make<PasswordApp | undefined>(undefined),
      runtimeApp: yield* Ref.make<RuntimeApp | undefined>(undefined),
      outcomes: yield* Ref.make<Readonly<Record<string, unknown>>>({}),
    });
  }),
);

export const setOutcome = Effect.fn("features.httpError.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const world = yield* World;
  yield* Ref.update(world.outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.httpError.getOutcome")(function* (key: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.outcomes))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no outcome recorded for "${key}"`));
  return found;
});

/** Registers a composition under `name`, capturing its handler and the group services it provides. */
export const register = Effect.fn("features.httpError.register")(function* (
  name: string,
  app: {
    readonly handler: (request: Request) => Promise<Response>;
    readonly groups: Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  },
) {
  const world = yield* World;
  const groups = yield* app.groups;
  yield* Ref.update(world.handlers, (existing) => ({ ...existing, [name]: app.handler }));
  yield* Ref.update(world.groups, (existing) => ({ ...existing, [name]: groups }));
});

export const groupsOf = Effect.fn("features.httpError.groupsOf")(function* (name: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.groups))[name];
  if (found === undefined) return yield* Effect.die(new Error(`no composition named "${name}"`));
  return found;
});

export const handlerOf = Effect.fn("features.httpError.handlerOf")(function* (name: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.handlers))[name];
  if (found === undefined) return yield* Effect.die(new Error(`no composition named "${name}"`));
  return found;
});

/** The password composition of this Scenario, built on first use. */
export const usePasswordApp = Effect.fn("features.httpError.usePasswordApp")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.passwordApp);
  if (existing !== undefined) return existing;
  const fresh = passwordApp();
  yield* Ref.set(world.passwordApp, fresh);
  return fresh;
});

const ErrorBody = Schema.Struct({ _tag: Schema.optional(Schema.String) });

export const answerOf = Effect.fn("features.httpError.answerOf")(function* (response: Response) {
  const body = yield* Effect.promise(() => response.text());
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(body);
  return {
    status: response.status,
    body,
    tag: parsed._tag === "Some" ? parsed.value._tag : undefined,
  } satisfies Answer;
});

/** An unsafe request as a browser client would send it: with the double-submit pair. */
export const postJson = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: withCsrfCookie(cookie),
          "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        },
        body: JSON.stringify(body),
      }),
    ),
  );

export const get = (handler: (request: Request) => Promise<Response>, path: string) =>
  Effect.promise(() => handler(new Request(`http://localhost${path}`)));

/** `Password.signUp` over the composition's own services, then a verified mailbox: a user who can sign in. */
export const signUpVerified = Effect.fn("features.httpError.signUpVerified")(function* (
  app: PasswordApp,
  email: string,
  password: string,
) {
  yield* app.withContext(
    Effect.gen(function* () {
      const service = yield* Password.Password;
      const users = yield* Users.Users;
      const issued = yield* service.signUp({ email, password: Redacted.make(password) });
      yield* users.verifyEmail(issued.session.userId);
    }).pipe(Effect.orDie),
  );
});
