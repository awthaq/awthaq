// Shipping-gap map (.scratch/shipping-gaps), ticket 24: the same real wire
// seam `packages/admin/test/AuthHttp.test.ts` establishes — a real
// `HttpRouter.toWebHandler` app over real in-memory `Sessions`/`AuthEvents`/
// `ImpersonationRecords`. Sessions are bootstrapped directly against
// `Sessions` (there is no sign-up endpoint on this plugin, or any plugin
// composed here) via `Effect.runPromise` (not a bare `yield*`) — the same
// technique `AuthHttp.test.ts`'s own `issueSessionCookieHeader` uses,
// deliberately bypassing whatever ambient `TestClock`
// `@effect-cucumber/vitest` provides so the bootstrap always runs on the
// same real clock `HttpRouter.toWebHandler`'s own per-request execution is
// always on (see `PasskeyWorld.ts`'s own `signIn` comment, ticket 25, for
// the real bug this avoids).
//
// Several scenarios (BEH-EA-209/210/211/218) need to inspect state no HTTP
// response ever carries — a session row's own `actingAs`/`idleExpiresAt`,
// or a resolved `UserPrincipal`'s `actingAs` — so this World also exposes
// direct domain-level access to `Sessions`/`Authentication.resolvePrincipal`
// over the same shared `MemoMap` the HTTP handler itself resolves against.
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { Admin, AdminApi, ImpersonationRecords } from "@awthaq/admin";
import type { Api } from "@awthaq/api";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CSRF_TEST_COOKIE_VALUE, CsrfConfigForTests, withCsrfCookie } from "./CsrfTestSupport.ts";
import type { AuthSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

const ORIGIN = "http://localhost:3000";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

export interface AppOptions {
  /** Omitted entirely means `AdminConfig`'s own fail-closed default (`() => false`) applies — REQ-EA-382/400's own point. */
  readonly canImpersonate?: (subject: AuthSubject) => Effect.Effect<boolean>;
}

const buildAppLayer = (
  options: AppOptions,
  events: Ref.Ref<ReadonlyArray<AuthEvents.AuthEvent>>,
) => {
  const eventsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      // `startImmediately`: without it the fork is merely scheduled, and
      // the very first request through this app could publish before the
      // subscription has actually registered with the underlying
      // `PubSub.bounded` — a live broadcast, not a replay log, so a missed
      // publish is gone for good. Real, reproduced bug (an empty
      // `publishedEvents()` after a real impersonate call), not
      // hypothetical — see `packages/core/test/AuthEvents.test.ts`'s own
      // identical fix and its own comment on exactly this race.
      yield* authEvents.stream.pipe(
        Stream.runForEach((event) => Ref.update(events, (existing) => [...existing, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
    }),
  );

  // `options.canImpersonate` omitted reconstructs `AdminConfig`'s own
  // fail-closed default (`() => Effect.succeed(false)`) explicitly —
  // behaviorally identical to not providing `Admin.config(...)` at all
  // (REQ-EA-382/400's own point), without the conditional-layer plumbing
  // that would otherwise require.
  const canImpersonate = options.canImpersonate ?? (() => Effect.succeed(false));

  return Layer.mergeAll(
    AuthHttp.routes(AdminApi.AdminApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Admin.Admin.layer),
      Layer.provide(Admin.config({ canImpersonate })),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(AdminApi.AdminApi),
  ).pipe(
    Layer.provideMerge(eventsLayer),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(ImpersonationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
};

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly memoMap: Layer.MemoMap;
  readonly appLayer: ReturnType<typeof buildAppLayer>;
  readonly events: Ref.Ref<ReadonlyArray<AuthEvents.AuthEvent>>;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly lastResponse: Ref.Ref<Response | undefined>;
  readonly outcomes: Ref.Ref<Record<string, unknown>>;
}

export class World extends Context.Service<World, WorldShape>()("features/AdminWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make<AppHandle | undefined>(undefined),
      lastResponse: yield* Ref.make<Response | undefined>(undefined),
      outcomes: yield* Ref.make<Record<string, unknown>>({}),
    });
  }),
);

/** Builds a fresh app — call once per Scenario (no merge semantics needed: every scenario here configures once, up front). */
export const configureApp = Effect.fn("features.admin.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  const events = Ref.makeUnsafe<ReadonlyArray<AuthEvents.AuthEvent>>([]);
  const appLayer = buildAppLayer(options, events);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
  yield* Ref.set(world.app, { handler, memoMap, appLayer, events });
});

const appHandle = Effect.fn("features.admin.appHandle")(function* () {
  const world = yield* World;
  const found = yield* Ref.get(world.app);
  if (found === undefined) yield* configureApp({});
  return (yield* Ref.get(world.app))!;
});

export const request = Effect.fn("features.admin.request")(function* (
  method: string,
  path: string,
  options?: { readonly body?: unknown; readonly headers?: Record<string, string> },
) {
  const { handler } = yield* appHandle();
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
          ...options?.headers,
          cookie: withCsrfCookie(options?.headers?.["cookie"]),
          "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    ),
  );
  const world = yield* World;
  yield* Ref.set(world.lastResponse, response);
  return response;
});

export const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

export const tokenFromCookie = (cookie: string): string =>
  decodeURIComponent(cookie.replace("__Host-session=", ""));

/**
 * Issues a real session directly against `Sessions`, reaching into the
 * same running services `handler` uses via the shared `MemoMap` — see this
 * file's own header comment for why `Effect.runPromise` (real clock,
 * bypassing any ambient `TestClock`) is load-bearing here, not stylistic.
 */
export const signIn = Effect.fn("features.admin.signIn")(function* (userId: string) {
  const { appLayer, memoMap } = yield* appHandle();
  return yield* Effect.promise(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const users = yield* Users.Users;
            yield* users
              .create({ email: `${userId}@example.com`, name: userId })
              .pipe(Effect.catchTag("EmailAlreadyExists", () => Effect.void));
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    ),
  );
});

/** Domain-level: reads a session row back by its raw token — the wire never exposes `actingAs`/`idleExpiresAt` directly. */
export const inspectSession = Effect.fn("features.admin.inspectSession")(function* (token: string) {
  const { appLayer, memoMap } = yield* appHandle();
  return yield* Effect.promise(() =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const { session } = yield* sessions.verify(Redacted.make(token));
            return session;
          }).pipe(Effect.provide(context));
        }),
      ),
    ),
  );
});

/**
 * Domain-level: `Authentication.resolvePrincipal` against a raw token —
 * BEH-EA-211's own seam. Explicitly typed to `Api.Principal` — a real
 * TS2883 portability error otherwise (two different resolved filesystem
 * paths to the same, real `packages/api` behind the `@awthaq/admin`
 * vs. this package's own `node_modules/@awthaq/api` symlink), not a
 * layer-composition bug this time (see `OAuthWorld.ts`'s own comment,
 * ticket 22, for a case where the identical error *was* a real bug).
 */
export const resolvePrincipal: (token: string) => Effect.Effect<Api.Principal, never, World> =
  Effect.fn("features.admin.resolvePrincipal")(function* (token: string) {
    const { appLayer, memoMap } = yield* appHandle();
    return yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
            return yield* Effect.gen(function* () {
              const sessions = yield* Sessions.Sessions;
              const resolver = yield* Authentication.PrincipalResolver;
              return yield* Authentication.resolvePrincipal(
                sessions,
                resolver,
                Redacted.make(token),
              ).pipe(
                // Ticket 03: `resolvePrincipal` keys its per-request verify
                // memoization off the ambient `HttpServerRequest` — this
                // helper calls it directly, outside any real HTTP request,
                // so it provides a synthetic one instead.
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(new Request(ORIGIN)),
                ),
              );
            }).pipe(Effect.provide(context), Effect.provide(Authentication.PrincipalResolverLive));
          }),
        ),
      ),
    );
  });

export const publishedEvents = Effect.fn("features.admin.publishedEvents")(function* () {
  const { events } = yield* appHandle();
  return yield* Ref.get(events);
});

export const setOutcome = Effect.fn("features.admin.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const { outcomes } = yield* World;
  yield* Ref.update(outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.admin.getOutcome")(function* (key: string) {
  const { outcomes } = yield* World;
  const found = (yield* Ref.get(outcomes))[key];
  if (found === undefined) throw new Error(`no outcome recorded for "${key}"`);
  return found;
});
