// Shipping-gap map (.scratch/shipping-gaps), ticket 20: the Password
// plugin's real wire-level seam, reused from
// `packages/password/test/AuthHttp.test.ts` (the same `HttpRouter.toWebHandler`
// + `Mailer.layerMemory`-alike "readable capture" pattern that file already
// establishes) rather than a new one invented for this suite. Every scenario
// drives the plugin exclusively through its real HTTP surface — no direct
// domain-service access — matching that file's own scope: "this only checks
// the HTTP plumbing," with domain rules already proven in
// `packages/password/test/Password.test.ts`.
import { AuthEvents, Accounts, RateLimits, Sessions, Users, Verification } from "@awthaq/core";
import type { AuthEvent } from "@awthaq/core/AuthEvents";
import { Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import type { MailMessage } from "@awthaq/ports/Mailer";
import { Authentication, AuthHttp } from "@awthaq/server";
import { Password, PasswordApi } from "@awthaq/password";
import { NodeCrypto } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
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

/** BEH-EA-119: a corpus nothing ever matches, the same default `AuthHttp.test.ts` uses — a Scenario opting into a real breach lookup overrides this via `configureBreach`. */
const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

export interface AppOptions {
  readonly hasher?: Layer.Layer<PasswordHasher.PasswordHasher, Config.ConfigError, Crypto.Crypto>;
  readonly breachHttpClient?: Layer.Layer<HttpClient.HttpClient>;
  readonly config?: Layer.Layer<never>;
}

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly sentMail: Effect.Effect<ReadonlyArray<MailMessage>>;
  readonly publishedEvents: Effect.Effect<ReadonlyArray<AuthEvent>>;
}

/**
 * Mirrors `AuthHttp.test.ts`'s own `capturingMailer` — a capture cell built
 * *outside* the layer graph so a step can read it after the graph is torn
 * down into the handler closure. Events get the identical treatment,
 * subscribing to `AuthEvents`'s real `PubSub` the same way
 * `AuthEvents.test.ts`'s own `seen` `Ref` does.
 */
const buildApp = (options: AppOptions = {}): AppHandle => {
  const messages = Effect.runSync(Ref.make<ReadonlyArray<MailMessage>>([]));
  const capturingMailer = Layer.succeed(
    Mailer.Mailer,
    Mailer.Mailer.of({
      send: (message) => Ref.update(messages, (existing) => [...existing, message]),
      sent: Ref.get(messages),
    }),
  );

  const events = Effect.runSync(Ref.make<ReadonlyArray<AuthEvent>>([]));
  const eventsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      yield* authEvents.stream.pipe(
        Stream.runForEach((event) => Ref.update(events, (existing) => [...existing, event])),
        Effect.forkScoped,
      );
    }),
  );

  const appLayer = Layer.mergeAll(
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
    AuthHttp.docs(PasswordApi.PasswordApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(eventsLayer),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        options.hasher ?? PasswordHasher.layerArgon2id,
        capturingMailer,
        RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(options.breachHttpClient ?? NoBreachHttpClient),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(options.config ?? Password.config({})),
  );

  const { handler } = HttpRouter.toWebHandler(appLayer);
  return { handler, sentMail: Ref.get(messages), publishedEvents: Ref.get(events) };
};

export interface ActorState {
  email: string;
  password: string;
  cookie: string | undefined;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle>;
  /** The options the current `app` was built from — `configureApp` merges onto this rather than replacing it wholesale, so two Given steps (e.g. "breachCheck: onUnavailable reject" then, separately, "the provider is unreachable") compose instead of the second silently discarding the first's choice. */
  readonly options: Ref.Ref<AppOptions>;
  readonly actors: Ref.Ref<Record<string, ActorState>>;
  readonly responses: Ref.Ref<Record<string, Response>>;
}

export class World extends Context.Service<World, WorldShape>()("features/PasswordWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make(buildApp()),
      options: yield* Ref.make<AppOptions>({}),
      actors: yield* Ref.make<Record<string, ActorState>>({}),
      responses: yield* Ref.make<Record<string, Response>>({}),
    });
  }),
);

/** Rebuilds this Scenario's app from `options` merged onto whatever was configured so far — no requests may have been made against the old one yet, since state does not carry over. */
export const configureApp = Effect.fn("features.password.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  const merged = { ...(yield* Ref.get(world.options)), ...options };
  yield* Ref.set(world.options, merged);
  yield* Ref.set(world.app, buildApp(merged));
});

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
      body: JSON.stringify(body),
    }),
  );

export const request = Effect.fn("features.password.request")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  const { app } = yield* World;
  const { handler } = yield* Ref.get(app);
  return yield* Effect.promise(() => post(handler, path, body, cookie));
});

export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

export const setLastResponse = Effect.fn("features.password.setLastResponse")(function* (
  key: string,
  response: Response,
) {
  const { responses } = yield* World;
  yield* Ref.update(responses, (existing) => ({ ...existing, [key]: response }));
});

export const getLastResponse = Effect.fn("features.password.getLastResponse")(function* (
  key: string,
) {
  const { responses } = yield* World;
  const found = (yield* Ref.get(responses))[key];
  if (found === undefined) throw new Error(`no response recorded for "${key}"`);
  return found;
});

export const setActor = Effect.fn("features.password.setActor")(function* (
  name: string,
  state: ActorState,
) {
  const { actors } = yield* World;
  yield* Ref.update(actors, (existing) => ({ ...existing, [name]: state }));
});

export const getActor = Effect.fn("features.password.getActor")(function* (name: string) {
  const { actors } = yield* World;
  const found = (yield* Ref.get(actors))[name];
  if (found === undefined) throw new Error(`no actor named "${name}" has been set up`);
  return found;
});

/**
 * `signUp`'s verification mail is dispatched via `Effect.forkDetach`
 * (BEH-EA-113: never awaited) — a few cooperative scheduler turns give
 * that detached fiber a chance to run to completion, mirroring
 * `AuthHttp.test.ts`'s own `letForkedFibersRun`.
 */
export const letForkedFibersRun = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

export const sentMail = Effect.fn("features.password.sentMail")(function* () {
  const { app } = yield* World;
  return yield* (yield* Ref.get(app)).sentMail;
});

export const publishedEvents = Effect.fn("features.password.publishedEvents")(function* () {
  const { app } = yield* World;
  return yield* (yield* Ref.get(app)).publishedEvents;
});

export const STRONG_PASSWORD = "correct horse battery staple";
