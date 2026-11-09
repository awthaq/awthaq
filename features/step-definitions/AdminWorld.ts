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
// direct domain-level access to `Sessions`/`Credentials`
// over the same shared `MemoMap` the HTTP handler itself resolves against.
import { Auth, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Admin } from "@awthaq/admin";
import type { Api } from "@awthaq/api";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestAuth, type UserAgent } from "@awthaq/test";
import { resolveCredential } from "./shared/ResolveCredential.ts";

const ORIGIN = "http://localhost:3000";

/**
 * IDS-003: `Admin.impersonate` refuses a nonexistent target. The scenarios name
 * their targets by literal ids ("target-1", "admin-1"), so this World treats
 * every id as an existing account except those prefixed `unknown-`, which the
 * unknown-target scenario uses.
 */
const UsersLive = Layer.effect(
  Users.Users,
  Effect.gen(function* () {
    const real = yield* Users.Users;
    return Users.Users.of({
      ...real,
      findById: (id) =>
        real.findById(id).pipe(
          Effect.catchTag("UserNotFound", (notFound) =>
            id.startsWith("unknown-")
              ? Effect.fail(notFound)
              : Effect.succeed({
                  id,
                  identity: {
                    _tag: "Email" as const,
                    email: `${id}@example.com`,
                    emailVerified: false,
                  },
                  name: id,
                  metadata: Option.none(),
                  image: Option.none(),
                  tenantId: Option.none(),
                  status: "active" as const,
                  statusReason: Option.none(),
                  suspendedUntil: Option.none(),
                  createdAt: DateTime.makeUnsafe(0),
                  updatedAt: DateTime.makeUnsafe(0),
                }),
          ),
        ),
    });
  }),
);

export interface AppOptions {
  /** Omitted entirely means `AdminConfig`'s own fail-closed default (`() => false`) applies — REQ-EA-382/400's own point. */
  readonly canImpersonate?: Admin.AdminConfigShape["canImpersonate"];
  /** BAM-005: omitted means the fail-closed default, exactly like `canImpersonate`. */
  readonly canManageUsers?: Admin.AdminConfigShape["canManageUsers"];
}

const built = Auth.make([Admin.Admin]);

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
        // Core's events (the bus is typed open, ADR-EA-049): this world reads them back by tag.
        Stream.filter(AuthEvents.is(AuthEvents.eventTags)),
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

  return TestAuth.layer(built, {
    openapiPath: "/openapi.json",
    docsPath: "/docs",
    services: Admin.config({
      canImpersonate,
      ...(options.canManageUsers === undefined ? {} : { canManageUsers: options.canManageUsers }),
    }),
    decorate: UsersLive,
    taps: eventsLayer,
  });
};

export interface AppHandle {
  /** The composition served and read through one memo map: the handler and `run` share every instance. */
  readonly app: TestAuth.App<AppServices>;
  readonly events: Ref.Ref<ReadonlyArray<AuthEvents.AuthEvent>>;
}

export type AppServices = Layer.Success<ReturnType<typeof buildAppLayer>>;

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
  const app = TestAuth.app(buildAppLayer(options, events), { baseUrl: ORIGIN });
  yield* Ref.set(world.app, { app, events });
});

const appHandle = Effect.fn("features.admin.appHandle")(function* () {
  const world = yield* World;
  const found = yield* Ref.get(world.app);
  if (found === undefined) yield* configureApp({});
  return (yield* Ref.get(world.app))!;
});

/**
 * One request. `as` is the browser (user agent) making it, which keeps its own cookies and echoes CSRF;
 * without it, a fresh anonymous agent. `extraCookies` replays a credential for this request only (a revoked
 * impersonation token, presented again).
 */
export const request = Effect.fn("features.admin.request")(function* (
  method: string,
  path: string,
  options?: {
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly as?: UserAgent.UserAgent;
    readonly extraCookies?: Readonly<Record<string, string>>;
  },
) {
  const { app } = yield* appHandle();
  const init = {
    ...(options?.body === undefined ? {} : { json: options.body }),
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(options?.extraCookies === undefined ? {} : { extraCookies: options.extraCookies }),
  };
  const response = yield* Effect.promise(() =>
    options?.as === undefined
      ? app.request(method, path, init)
      : options.as.request(method, path, init),
  );
  const world = yield* World;
  yield* Ref.set(world.lastResponse, response);
  return response;
});

/** A signed-in user: their raw session token and the `Set-Cookie` the session is rendered as. */
export interface Actor {
  readonly userId: string;
  readonly token: string;
  readonly setCookie: string;
}

/** A fresh browser holding `actor`'s session (and the CSRF cookie every app agent starts with). */
export const browser = Effect.fn("features.admin.browser")(function* (actor: Actor) {
  const { app } = yield* appHandle();
  const agent = yield* Effect.promise(() => app.agent());
  const received = agent.cookies.receive(actor.setCookie);
  if (received._tag !== "Stored")
    throw new Error(`the browser did not store ${actor.userId}'s session`);
  return agent;
});

/**
 * Issues a real session directly against `Sessions`, reaching into the
 * same running services `handler` uses via the shared `MemoMap` — see this
 * file's own header comment for why `Effect.runPromise` (real clock,
 * bypassing any ambient `TestClock`) is load-bearing here, not stylistic.
 * The literal `userId` is the session's subject (the gates compare ids), so
 * this cannot be `TestAuth.signInAs`, which mints a generated id.
 */
export const signIn = Effect.fn("features.admin.signIn")(function* (userId: string) {
  const { app } = yield* appHandle();
  return yield* Effect.promise(() =>
    app.run(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users
          .create({ identity: { _tag: "Email", email: `${userId}@example.com` }, name: userId })
          .pipe(Effect.catchTag("Users/EmailAlreadyExists", () => Effect.void));
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        const setCookie = yield* TestAuth.sessionSetCookie(issued);
        const actor: Actor = {
          userId,
          token: Redacted.value(issued.token),
          setCookie,
        };
        return actor;
      }),
    ),
  );
});

/** Domain-level: reads a session row back by its raw token — the wire never exposes `actingAs`/`idleExpiresAt` directly. */
export const inspectSession = Effect.fn("features.admin.inspectSession")(function* (token: string) {
  const { app } = yield* appHandle();
  return yield* Effect.promise(() =>
    app.run(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session } = yield* sessions.verify(Redacted.make(token));
        return session;
      }),
    ),
  );
});

/**
 * Domain-level: `Credentials` resolving a raw session token —
 * BEH-EA-211's own seam. Explicitly typed to `Api.Principal` — a real
 * TS2883 portability error otherwise (two different resolved filesystem
 * paths to the same, real `packages/api` behind the `@awthaq/admin`
 * vs. this package's own `node_modules/@awthaq/api` symlink), not a
 * layer-composition bug this time (see `OAuthWorld.ts`'s own comment,
 * ticket 22, for a case where the identical error *was* a real bug).
 */
export const principalOfToken: (token: string) => Effect.Effect<Api.Principal, never, World> =
  Effect.fn("features.admin.principalOfToken")(function* (token: string) {
    const { app } = yield* appHandle();
    return yield* Effect.promise(() => app.run(resolveCredential("cookie", token)));
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
