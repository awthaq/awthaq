// P20a/AH-003, decision 36 Tier 4: the World for 01-contract-and-persistence/04-contract-stratum.feature.
//
// Three real apps, each a `HttpRouter.toWebHandler` over memory services:
//  - `authProbeApp`: probe groups behind the shipped `Authentication`, `OptionalAuthentication` and a
//    re-declared (bearer-before-cookie) record, with every scheme handler wrapped by `traced` so a
//    scenario can say which scheme was tried and which resolved (BEH-EA-028/029). Nothing about
//    resolution is stubbed: `traced` records and delegates unchanged.
//  - `passwordApp`: the real `Password` plugin over `@awthaq/test`'s `TestAuth` (BEH-EA-027's
//    credential errors, over the wire).
//  - `coreOnlyApp`: a composition whose only plugin contributes an unrelated group, so core's own
//    `session` group is the thing under test (BEH-EA-031).
// Sessions are minted directly against the same running services (shared `MemoMap`).
import { Api } from "@awthaq/api";
import { Auth, Sessions, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Authentication, AuthHttp } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { CSRF_TEST_COOKIE_VALUE, withCsrfCookie } from "./CsrfTestSupport.ts";
import { PasswordFixture } from "./PluginFixtures.ts";
import { services } from "./ServeComposition.ts";
import { TestServices } from "./shared/Harness.ts";

/** BEH-EA-028: the same two schemes declared in the opposite order — only the record differs, the handlers are `Authentication`'s own. */
export class ReorderedAuthentication extends HttpApiMiddleware.Service<
  ReorderedAuthentication,
  { provides: Api.CurrentPrincipal }
>()("ReorderedAuthentication", {
  security: { bearer: Api.BearerToken, cookie: Api.SessionCookie },
  error: [Api.Unauthenticated, Api.StoreUnavailable],
}) {}

const Who = Schema.Struct({ tag: Schema.String, id: Schema.String });

const ProbeApi = HttpApi.make("probe")
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
    HttpApiGroup.make("reordered")
      .add(HttpApiEndpoint.get("who", "/reordered/who", { success: Who }))
      .middleware(ReorderedAuthentication),
  );

const traced =
  <Args extends ReadonlyArray<unknown>, A, E, R>(
    attempts: Ref.Ref<ReadonlyArray<string>>,
    name: string,
    handler: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args) =>
    Ref.update(attempts, (all) => [...all, name]).pipe(Effect.andThen(handler(...args)));

const buildAuthProbe = () => {
  const attempts = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  const resolvedBy = Ref.makeUnsafe<ReadonlyArray<string>>([]);
  const describe = Effect.map(Api.CurrentPrincipal, (principal) => ({
    tag: principal._tag,
    id: principal.ref.id,
  }));
  const Handlers = Layer.mergeAll(
    HttpApiBuilder.group(ProbeApi, "app", (handlers) => handlers.handle("who", () => describe)),
    HttpApiBuilder.group(ProbeApi, "optional", (handlers) =>
      handlers.handle("who", () => describe),
    ),
    HttpApiBuilder.group(ProbeApi, "reordered", (handlers) =>
      handlers.handle("who", () => describe),
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
  const ReorderedLive = Layer.effect(
    ReorderedAuthentication,
    Effect.gen(function* () {
      const auth = yield* Api.Authentication;
      return { bearer: auth.bearer, cookie: auth.cookie };
    }),
  );
  // Records which scheme the middleware says authenticated the request, then delegates.
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
  const appLayer = AuthHttp.routes(ProbeApi).pipe(
    Layer.provide(Handlers),
    Layer.provideMerge(RecordingHook),
    Layer.provideMerge(ReorderedLive),
    Layer.provideMerge(TracedAuthentication),
    Layer.provideMerge(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(Users.layerMemory),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
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
  return { handler, withServices, attempts, resolvedBy };
};

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const buildPasswordApp = () => {
  // `requireVerifiedEmail: false`: BEH-EA-027 is about credential errors, not the verification gate.
  const appLayer = TestAuth.layer(
    Auth.make([Password.Password]),
    Layer.mergeAll(services, NoBreachHttpClient, Password.config({ requireVerifiedEmail: false })),
  );
  const { handler } = HttpRouter.toWebHandler(appLayer);
  return { handler };
};

const buildCoreOnlyApp = () => {
  const appLayer = TestAuth.layer(Auth.make([PasswordFixture]), services);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
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
  return { handler, withServices };
};

export type AppKind = "auth-probe" | "password" | "core-only";

export interface Actor {
  readonly userId: string;
  readonly cookie: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface Observed {
  readonly status: number;
  readonly body: string;
  readonly attempts: ReadonlyArray<string>;
  readonly resolvedBy: ReadonlyArray<string>;
}

export interface WorldShape {
  readonly authProbe: Ref.Ref<ReturnType<typeof buildAuthProbe> | undefined>;
  readonly password: Ref.Ref<ReturnType<typeof buildPasswordApp> | undefined>;
  readonly coreOnly: Ref.Ref<ReturnType<typeof buildCoreOnlyApp> | undefined>;
  readonly actors: Ref.Ref<Readonly<Record<string, Actor>>>;
  readonly observed: Ref.Ref<ReadonlyArray<Observed>>;
}

export class World extends Context.Service<World, WorldShape>()("features/ContractStratumWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      authProbe: yield* Ref.make<ReturnType<typeof buildAuthProbe> | undefined>(undefined),
      password: yield* Ref.make<ReturnType<typeof buildPasswordApp> | undefined>(undefined),
      coreOnly: yield* Ref.make<ReturnType<typeof buildCoreOnlyApp> | undefined>(undefined),
      actors: yield* Ref.make<Readonly<Record<string, Actor>>>({}),
      observed: yield* Ref.make<ReadonlyArray<Observed>>([]),
    });
  }),
);

/** Lazily builds this scenario's app of `kind` — every scenario starts from a fresh one. */
const lazily = <A>(ref: Ref.Ref<A | undefined>, build: () => A) =>
  Effect.gen(function* () {
    const existing = yield* Ref.get(ref);
    if (existing !== undefined) return existing;
    const fresh = build();
    yield* Ref.set(ref, fresh);
    return fresh;
  });

export const authProbeApp = Effect.gen(function* () {
  return yield* lazily((yield* World).authProbe, buildAuthProbe);
});

export const passwordApp = Effect.gen(function* () {
  return yield* lazily((yield* World).password, buildPasswordApp);
});

export const coreOnlyApp = Effect.gen(function* () {
  return yield* lazily((yield* World).coreOnly, buildCoreOnlyApp);
});

const ORIGIN = "http://localhost";

export const send = (
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  options?: {
    readonly body?: unknown;
    readonly cookie?: string;
    readonly bearer?: string;
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.promise(async () => {
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options?.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
          ...options?.headers,
          cookie: withCsrfCookie(options?.cookie),
          "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    return { status: response.status, body: await response.text(), headers: response.headers };
  });

const sessionFor = (name: string) =>
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
  });

/** A real user with a real, live session in the auth-probe app. */
export const signInProbe = (name: string) =>
  Effect.gen(function* () {
    const app = yield* authProbeApp;
    const actor = yield* app.withServices(sessionFor(name));
    const world = yield* World;
    yield* Ref.update(world.actors, (existing) => ({ ...existing, [name]: actor }));
    return actor;
  });

/** A real user with a real, live session in the core-only app. */
export const signInCore = (name: string) =>
  Effect.gen(function* () {
    const app = yield* coreOnlyApp;
    const actor = yield* app.withServices(sessionFor(name));
    const world = yield* World;
    yield* Ref.update(world.actors, (existing) => ({ ...existing, [name]: actor }));
    return actor;
  });

export const actorNamed = (name: string) =>
  Effect.gen(function* () {
    const found = (yield* Ref.get((yield* World).actors))[name];
    if (found === undefined) return yield* Effect.die(new Error(`no actor named "${name}"`));
    return found;
  });
