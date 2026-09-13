// Shipping-gap map (.scratch/shipping-gaps), ticket 21: the real wire-level
// seam `packages/server/test/AuthHttp.test.ts` establishes for
// `@effect-auth/server`'s own core `session` HTTP group
// (`/session`, `/session/list`, `/session/sign-out`, `/session/revoke`,
// `/session/revoke-others`), plus `@effect-auth/password`'s `/password/sign-up`
// composed alongside it on the same `HttpRouter` — Session's own contract has
// no HTTP endpoint that *issues* a session (only ones that consume an
// already-issued cookie), so a real Set-Cookie response (REQ-EA-136/154/155)
// needs an actual sign-in flow, the same way any real deployment would.
import { AuthCore } from "@effect-auth/api";
import { AuthEvents, Accounts, RateLimits, Sessions, Users, Verification } from "@effect-auth/core";
import { Mailer, PasswordHasher, RateLimiter } from "@effect-auth/ports";
import { Password, PasswordApi } from "@effect-auth/password";
import { Account, Authentication, AuthHttp, Session } from "@effect-auth/server";
import { NodeCrypto } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const buildApp = () => {
  const appLayer = Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/password-openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
    AuthHttp.docs(AuthCore.AuthCoreApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id,
        Mailer.layerMemory,
        RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const { handler } = HttpRouter.toWebHandler(appLayer);
  return handler;
};

export interface ActorState {
  email: string;
  /** The bare `name=value` pair, ready to send back as a request's own `cookie` header. */
  cookie: string;
  /** The full raw `Set-Cookie` response header this session's own cookie was issued under — carries the attributes (`Secure`, `HttpOnly`, `SameSite`, `Path`, any `Domain`) REQ-EA-154/155 inspect. */
  setCookie: string;
}

export interface WorldShape {
  readonly handler: (request: Request) => Promise<Response>;
  readonly actors: Ref.Ref<Record<string, ActorState>>;
  readonly responses: Ref.Ref<Record<string, Response>>;
}

export class World extends Context.Service<World, WorldShape>()("features/SessionWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      handler: buildApp(),
      actors: yield* Ref.make<Record<string, ActorState>>({}),
      responses: yield* Ref.make<Record<string, Response>>({}),
    });
  }),
);

export const STRONG_PASSWORD = "correct horse battery staple";
let nextEmail = 0;

const get = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  cookie?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: cookie ? { cookie } : {},
    }),
  );

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

export const setCookieHeader = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw;
};

/** Signs a fresh user up (BEH-EA-113's own detail is out of scope here — Password's `AuthHttp.test.ts` already covers it), returning the resulting `__Host-session` cookie. */
export const signUp = Effect.fn("features.session.signUp")(function* (name: string) {
  const { handler } = yield* World;
  const email = `${name}-${nextEmail++}@example.com`;
  const response = yield* Effect.promise(() =>
    post(handler, "/password/sign-up", { email, password: STRONG_PASSWORD }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed for ${email}: ${response.status}`);
  const cookie = cookieFrom(response);
  const setCookie = setCookieHeader(response);
  const { actors } = yield* World;
  yield* Ref.update(actors, (existing) => ({ ...existing, [name]: { email, cookie, setCookie } }));
  return { response, cookie, setCookie };
});

/** Mints a second (third, ...) session for the SAME account an earlier `signUp`/`signInAgain` call already created — BEH-EA-053's "a new session is issued, never reused" at each sign-in, the real way to get more than one live session for one user. Stored under `newName`, a fresh label for this particular session. */
export const signInAgain = Effect.fn("features.session.signInAgain")(function* (
  newName: string,
  existingName: string,
) {
  const { handler } = yield* World;
  const owner = yield* getActor(existingName);
  const response = yield* Effect.promise(() =>
    post(handler, "/password/sign-in", { email: owner.email, password: STRONG_PASSWORD }),
  );
  if (response.status !== 200) {
    throw new Error(`sign-in failed for ${owner.email}: ${response.status}`);
  }
  const cookie = cookieFrom(response);
  const setCookie = setCookieHeader(response);
  const { actors } = yield* World;
  yield* Ref.update(actors, (existing) => ({
    ...existing,
    [newName]: { email: owner.email, cookie, setCookie },
  }));
  return { response, cookie, setCookie };
});

/** The `id` half of an actor's own current session — resolved via the real `/session` "current" endpoint, the same id shape `/session/revoke` expects. */
export const sessionIdOf = Effect.fn("features.session.sessionIdOf")(function* (cookie: string) {
  const { handler } = yield* World;
  const response = yield* Effect.promise(() => get(handler, "/session", cookie));
  const body = (yield* Effect.promise(() => response.json())) as { readonly id: string };
  return body.id;
});

export const getSession = Effect.fn("features.session.getSession")(function* (
  path: string,
  cookie?: string,
) {
  const { handler } = yield* World;
  return yield* Effect.promise(() => get(handler, path, cookie));
});

export const postSession = Effect.fn("features.session.postSession")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  const { handler } = yield* World;
  return yield* Effect.promise(() => post(handler, path, body, cookie));
});

/** Registers `newName` as another name for the same already-set-up actor's session — e.g. "alice" is also her own "current" session "s1" in REQ-EA-151's own Given. */
export const aliasActor = Effect.fn("features.session.aliasActor")(function* (
  newName: string,
  existingName: string,
) {
  const { actors } = yield* World;
  const existing = (yield* Ref.get(actors))[existingName];
  if (existing === undefined) throw new Error(`no actor named "${existingName}" has been set up`);
  yield* Ref.update(actors, (state) => ({ ...state, [newName]: existing }));
});

export const getActor = Effect.fn("features.session.getActor")(function* (name: string) {
  const { actors } = yield* World;
  const found = (yield* Ref.get(actors))[name];
  if (found === undefined) throw new Error(`no actor named "${name}" has been set up`);
  return found;
});

export const setLastResponse = Effect.fn("features.session.setLastResponse")(function* (
  key: string,
  response: Response,
) {
  const { responses } = yield* World;
  yield* Ref.update(responses, (existing) => ({ ...existing, [key]: response }));
});

export const getLastResponse = Effect.fn("features.session.getLastResponse")(function* (
  key: string,
) {
  const { responses } = yield* World;
  const found = (yield* Ref.get(responses))[key];
  if (found === undefined) throw new Error(`no response recorded for "${key}"`);
  return found;
});
