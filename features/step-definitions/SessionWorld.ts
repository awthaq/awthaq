// Shipping-gap map (.scratch/shipping-gaps), ticket 21: the real wire-level
// seam `packages/server/test/AuthHttp.test.ts` establishes for
// `@awthaq/server`'s own core `session` HTTP group
// (`/session`, `/session/list`, `/session/sign-out`, `/session/revoke`,
// `/session/revoke-others`, `/session/revoke-all`), plus `@awthaq/password`'s
// `/password/sign-up` composed alongside it on the same `HttpRouter` —
// Session's own contract has no HTTP endpoint that *issues* a session (only
// ones that consume an already-issued cookie), so a real Set-Cookie response
// (REQ-EA-136/154/155) needs an actual sign-in flow, the same way any real
// deployment would.
//
// AH-005: what this World adds over the first version, so the scenarios whose
// only blocker was a World-capability gap can run:
// - **Real rows.** `Sessions` is `Persistence.sql()` over an in-memory SQLite client (core's own
//   migrations), so a step can read the persisted row (`readSessionRow`) — the memory layer
//   keeps its rows in a private `Ref` no step can reach.
// - **Simulated time.** A `TestClock` is part of the composition (started at the real "now",
//   which the CSRF double-submit token's `iat` is minted against) and `advance` moves it, so
//   day-scale expiry math runs in the same runtime the handler serves from.
// - **Log/span capture.** `@awthaq/test`'s `RedactionGuard` records every span, log line and
//   published event, so "the secret never reaches a log or span" is checkable.
// - **Fiber interleaving.** A `gate` endpoint behind the real `Authentication` middleware whose
//   handler blocks until released, so "validated, then revoked, then completes" can be driven.
import { Api } from "@awthaq/api";
import { Auth, Sessions, Users } from "@awthaq/core";
import type { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import type { Authentication } from "@awthaq/server";
import { RedactionGuard, TestAuth } from "@awthaq/test";
import { CSRF_TEST_COOKIE_VALUE, withCsrfCookie } from "./shared/Csrf.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mailedToken } from "./MailedToken.ts";
import {
  cookieFrom,
  awaitMail,
  makeCapturingMailer,
  makeNamedRegistry,
  setCookieFrom,
  STRONG_PASSWORD,
} from "./shared/Harness.ts";

const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

// REQ-EA-152/153: one endpoint behind the real `Authentication` middleware whose handler
// announces it has been admitted and then blocks until the step releases it — the fiber
// interleaving control a sequential step definition otherwise lacks.
const GateGroup = HttpApiGroup.make("gate")
  .add(HttpApiEndpoint.get("hold", "/gate/hold", { success: Schema.String }))
  .middleware(Api.Authentication);
// Declared against the composed api's own id (`auth`): the group rides beside `Password` as an `extraGroup`.
const GateApi = HttpApi.make("auth").add(GateGroup);

interface Gate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  /** How many requests passed the middleware and reached the handler. */
  readonly admitted: Ref.Ref<number>;
}

const GateHandlers = (gate: Gate) =>
  HttpApiBuilder.group(GateApi, "gate", (handlers) =>
    Effect.succeed(
      handlers.handle(
        "hold",
        Effect.fnUntraced(function* () {
          yield* Ref.update(gate.admitted, (n) => n + 1);
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
          return "completed";
        }),
      ),
    ),
  );

const defaultSettings: Sessions.SessionConfig = {
  absolute: Duration.days(30),
  idle: Duration.days(7),
  touchEvery: Duration.hours(1),
};

const built = Auth.make([Password.Password], { extraGroups: [GateGroup] });

/**
 * `Auth.make([Password], { extraGroups: [gate] })` through `TestAuth.layer({ records: "sql" })` (the core stores over an
 * in-memory SQLite database migrated by core's own migrations, so a step can read the persisted row), with core's `session`
 * and `account` groups served from the composed api. `@awthaq/test`'s `RedactionGuard` records every span, log line and
 * published event (BEH-EA-199). A simulated clock starts at the real "now" (the CSRF token's `iat` is minted against the
 * wall clock) and `advance` moves it; the double-submit token outlives every scenario's simulated span.
 */
const buildAppLayer = (settings: Sessions.SessionConfig, gate: Gate) => {
  const { layer: capturingMailer, sent } = makeCapturingMailer();

  const ClockLive = Layer.effectDiscard(TestClock.setTime(Date.now())).pipe(
    Layer.provideMerge(TestClock.layer()),
  );

  const appLayer = TestAuth.layer(built, {
    records: "sql",
    suite: "features_SessionWorld",
    csrf: { maxAge: Duration.days(400) },
    services: Layer.mergeAll(
      NoBreachHttpClient,
      Password.config({}),
      capturingMailer,
      GateHandlers(gate),
    ),
    openapiPath: "/openapi.json",
    docsPath: "/docs",
  }).pipe(
    // The session lifetimes this scenario wants: the base's `Sessions` reads `SessionConfig` when it is built.
    Layer.provide(Layer.succeed(Sessions.SessionConfig, settings)),
    Layer.provideMerge(ClockLive),
  );
  return { appLayer, sent };
};

export interface ActorState {
  email: string;
  /** The bare `name=value` pair, ready to send back as a request's own `cookie` header. */
  cookie: string;
  /** The full raw `Set-Cookie` response header this session's own cookie was issued under — carries the attributes (`Secure`, `HttpOnly`, `SameSite`, `Path`, any `Domain`) REQ-EA-154/155 inspect. */
  setCookie: string;
}

/** A persisted `sessions` row as SQLite returns it — read raw, so a step sees exactly what a disclosed table would. */
export type SessionRow = Readonly<Record<string, unknown>>;

/** The services the steps reach into the running app for (the same instances the handler uses). */
export type AppServices =
  | Sessions.Sessions
  | Users.Users
  | SqlClient.SqlClient
  | RedactionGuard.RedactionGuard
  | Authentication.PrincipalResolver;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly run: <A>(effect: Effect.Effect<A, never, AppServices>) => Promise<A>;
  readonly sentMail: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
  readonly gate: Gate;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle | undefined>;
  readonly settings: Ref.Ref<Sessions.SessionConfig>;
  readonly actors: ReturnType<typeof makeNamedRegistry<ActorState>>;
  readonly responses: ReturnType<typeof makeNamedRegistry<Response>>;
  /** Rows captured at a chosen moment, so a Then can compare against "before". */
  readonly snapshots: ReturnType<typeof makeNamedRegistry<SessionRow>>;
  /** Statuses a long-running step observed, in order (REQ-EA-144). */
  readonly statuses: Ref.Ref<ReadonlyArray<number>>;
  /** Requests started but not yet awaited (REQ-EA-152/153). */
  readonly inflight: ReturnType<typeof makeNamedRegistry<Fiber.Fiber<Response>>>;
  /** BEH-EA-258: sessions issued directly with a chosen `amr`, the principals resolved from them, and text a step carries to the next. */
  readonly views: ReturnType<typeof makeNamedRegistry<Sessions.SessionView>>;
  readonly principals: ReturnType<typeof makeNamedRegistry<Api.UserPrincipal>>;
  readonly texts: ReturnType<typeof makeNamedRegistry<string>>;
}

export class World extends Context.Service<World, WorldShape>()("features/SessionWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      app: yield* Ref.make<AppHandle | undefined>(undefined),
      settings: yield* Ref.make(defaultSettings),
      actors: makeNamedRegistry<ActorState>("actor"),
      responses: makeNamedRegistry<Response>("response"),
      snapshots: makeNamedRegistry<SessionRow>("row snapshot"),
      statuses: yield* Ref.make<ReadonlyArray<number>>([]),
      inflight: makeNamedRegistry<Fiber.Fiber<Response>>("in-flight request"),
      views: makeNamedRegistry<Sessions.SessionView>("session view"),
      principals: makeNamedRegistry<Api.UserPrincipal>("principal"),
      texts: makeNamedRegistry<string>("text"),
    });
  }),
);

/** Overrides `SessionConfig` for this scenario — before the first request, since state does not carry over a rebuild. */
export const configureSessions = Effect.fn("features.session.configureSessions")(function* (
  overrides: Partial<Sessions.SessionConfig>,
) {
  const world = yield* World;
  if ((yield* Ref.get(world.app)) !== undefined) {
    return yield* Effect.die(new Error("configureSessions must run before the first request"));
  }
  yield* Ref.update(world.settings, (existing) => ({ ...existing, ...overrides }));
});

const appHandle = Effect.fn("features.session.appHandle")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const gate: Gate = {
    entered: Deferred.makeUnsafe<void>(),
    release: Deferred.makeUnsafe<void>(),
    admitted: Ref.makeUnsafe(0),
  };
  const { appLayer, sent } = buildAppLayer(yield* Ref.get(world.settings), gate);
  const app = TestAuth.app(appLayer);
  const handle: AppHandle = { handler: app.handler, run: app.run, sentMail: sent, gate };
  yield* Ref.set(world.app, handle);
  return handle;
});

/**
 * Runs `effect` against the services the handler itself is running (the shared `MemoMap` hands
 * back the already-built instances), on the real clock — the `TestClock` it may adjust is the
 * one in the app's own context.
 */
export const inApp = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.gen(function* () {
    const { run } = yield* appHandle();
    return yield* Effect.promise(() => run(effect.pipe(Effect.orDie)));
  });

/** Moves the app's simulated clock forward. */
export const advance = Effect.fn("features.session.advance")(function* (duration: Duration.Input) {
  yield* inApp(TestClock.adjust(duration));
});

/** The app's current simulated time, in epoch milliseconds. */
export const nowMillis = Effect.fn("features.session.nowMillis")(function* () {
  return yield* inApp(
    TestClock.testClockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe())),
  );
});

/** The persisted row of a session, straight from the table (no domain service in between). */
export const readSessionRow = Effect.fn("features.session.readSessionRow")(function* (
  sessionId: string,
) {
  const rows = yield* inApp(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<SessionRow>`SELECT * FROM sessions WHERE id = ${sessionId}`;
    }),
  );
  const row = rows[0];
  if (row === undefined) return yield* Effect.die(new Error(`no persisted session "${sessionId}"`));
  return row;
});

/** Arranges a session whose persisted digest is `secretHash` — how a scenario that names its secret ("s3cr3t") gets a session it knows the secret of. */
export const pinSessionSecret = Effect.fn("features.session.pinSessionSecret")(function* (
  sessionId: string,
  secretHash: string,
) {
  yield* inApp(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE sessions SET "secretHash" = ${secretHash} WHERE id = ${sessionId}`;
    }),
  );
});

/** How many `sessions` rows exist for the user, live or not. */
export const countSessionRows = Effect.fn("features.session.countSessionRows")(function* (
  userId: string,
) {
  const rows = yield* inApp(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly n: number }>`
        SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sessions WHERE "userId" = ${userId}`;
    }),
  );
  return rows[0]?.n ?? 0;
});

/** The guard's verdict over every span, log line and published event so far, after registering `secret` as a canary. */
export const assertSecretNeverObserved = Effect.fn("features.session.assertSecretNeverObserved")(
  function* (secret: string) {
    yield* inApp(
      Effect.gen(function* () {
        const guard = yield* RedactionGuard.RedactionGuard;
        yield* guard.watch("session secret", secret);
      }),
    );
  },
);

/** Fails (defect) when a `Redacted` value or a watched canary reached a span, log line or event. */
export const assertNoLeaks = Effect.fn("features.session.assertNoLeaks")(function* () {
  yield* inApp(
    Effect.gen(function* () {
      const guard = yield* RedactionGuard.RedactionGuard;
      yield* guard.assertNoLeaks;
    }),
  );
});

const get = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  cookie?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "GET",
      headers: { cookie: withCsrfCookie(cookie) },
    }),
  );

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  cookie?: string,
  userAgent?: string,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: withCsrfCookie(cookie),
        "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        ...(userAgent === undefined ? {} : { "user-agent": userAgent }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

let nextEmail = 0;

/**
 * Signs a fresh user up — the way a real deployment gets a first session — and consumes the
 * verification mail `signUp` dispatched (upstream-hardening ticket 04: `signIn` hard-blocks an
 * unverified account), so every later sign-in this suite drives passes that gate. Registers
 * the actor under `name`. Returns the sign-up response.
 */
export const signUp = Effect.fn("features.session.signUp")(function* (name: string) {
  const { handler, sentMail } = yield* appHandle();
  const { actors } = yield* World;
  const email = `${name}-${nextEmail++}@example.com`;
  const response = yield* Effect.promise(() =>
    post(
      handler,
      "/password/sign-up",
      { email, password: STRONG_PASSWORD },
      undefined,
      `device-${name}`,
    ),
  );
  if (response.status !== 200) throw new Error(`sign-up failed for ${email}: ${response.status}`);
  yield* actors.set(name, {
    email,
    cookie: cookieFrom(response),
    setCookie: setCookieFrom(response),
  });

  yield* awaitMail(
    sentMail,
    (message) => message.template === "verify-email" && message.to === email,
  );
  const verifyMail = (yield* sentMail).findLast(
    (message) => message.template === "verify-email" && message.to === email,
  );
  if (verifyMail === undefined) throw new Error(`expected a verify-email mail for ${email}`);
  const token = mailedToken(verifyMail);
  const verified = yield* Effect.promise(() => post(handler, "/verify-email", { token }));
  if (verified.status !== 204) {
    throw new Error(`verify-email failed for ${email}: ${verified.status}`);
  }
  return response;
});

/** The newest mail of `template` sent to `address`, once the dispatch fibers have run. */
export const mailedTo = Effect.fn("features.session.mailedTo")(function* (
  address: string,
  template: string,
) {
  const { sentMail } = yield* appHandle();
  yield* awaitMail(sentMail, (message) => message.template === template && message.to === address);
  const found = (yield* sentMail).findLast(
    (message) => message.template === template && message.to === address,
  );
  if (found === undefined) throw new Error(`expected a ${template} mail for ${address}`);
  return found;
});

/** Signs the actor `existingName` in again (BEH-EA-053: a new session is minted, never reused); the new session is registered under `newName`. */
export const signInAgain = Effect.fn("features.session.signInAgain")(function* (
  newName: string,
  existingName: string,
) {
  const { handler } = yield* appHandle();
  const { actors } = yield* World;
  const owner = yield* actors.get(existingName);
  const response = yield* Effect.promise(() =>
    post(
      handler,
      "/password/sign-in",
      { email: owner.email, password: STRONG_PASSWORD },
      undefined,
      `device-${newName}`,
    ),
  );
  if (response.status !== 200) {
    throw new Error(`sign-in failed for ${owner.email}: ${response.status}`);
  }
  yield* actors.set(newName, {
    email: owner.email,
    cookie: cookieFrom(response),
    setCookie: setCookieFrom(response),
  });
  return response;
});

export const getSession = Effect.fn("features.session.getSession")(function* (
  path: string,
  cookie?: string,
) {
  const { handler } = yield* appHandle();
  return yield* Effect.promise(() => get(handler, path, cookie));
});

export const postSession = Effect.fn("features.session.postSession")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  const { handler } = yield* appHandle();
  return yield* Effect.promise(() => post(handler, path, body, cookie));
});

/** The `id` half of a session's own token — resolved via the real `/session` endpoint, the same id shape `/session/revoke` expects. */
export const sessionIdOf = Effect.fn("features.session.sessionIdOf")(function* (cookie: string) {
  const response = yield* getSession("/session", cookie);
  const body = yield* Effect.promise(() => response.json());
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
    body,
  ).pipe(Effect.orDie);
  return decoded.id;
});

/**
 * Starts a request without awaiting it, so a step can act while it is in flight. Stored under
 * `key`; `settle` awaits it.
 */
export const startRequest = Effect.fn("features.session.startRequest")(function* (
  key: string,
  path: string,
  cookie: string,
) {
  const { handler } = yield* appHandle();
  const { inflight } = yield* World;
  yield* inflight.set(
    key,
    yield* Effect.forkDetach(Effect.promise(() => get(handler, path, cookie))),
  );
});

export const settle = Effect.fn("features.session.settle")(function* (key: string) {
  const { inflight } = yield* World;
  return yield* Fiber.join(yield* inflight.get(key));
});

/** Resolves once the gate endpoint's handler has been admitted (past the real `Authentication` middleware). */
export const awaitGateEntered = Effect.fn("features.session.awaitGateEntered")(function* () {
  const { gate } = yield* appHandle();
  yield* Effect.promise(() => Effect.runPromise(Deferred.await(gate.entered)));
});

/** How many requests reached the gate's handler (past the middleware). */
export const gateAdmitted = Effect.fn("features.session.gateAdmitted")(function* () {
  const { gate } = yield* appHandle();
  return yield* Ref.get(gate.admitted);
});

/** Lets the blocked gate handler finish. */
export const releaseGate = Effect.fn("features.session.releaseGate")(function* () {
  const { gate } = yield* appHandle();
  yield* Effect.promise(() => Effect.runPromise(Deferred.succeed(gate.release, undefined)));
});

/**
 * A request made *as* the named actor that also honours rotation: verify's throttled touch
 * rotates the session secret and delivers the new one on this response (PIL-005/BEH-EA-052),
 * so the actor's stored cookie is replaced when the response carries one.
 */
export const requestAsActor = Effect.fn("features.session.requestAsActor")(function* (
  name: string,
  path: string,
) {
  const { actors } = yield* World;
  const actor = yield* actors.get(name);
  const response = yield* getSession(path, actor.cookie);
  const raw = response.headers.get("set-cookie");
  if (response.status === 200 && raw !== null && raw.startsWith("__Host-session=")) {
    yield* actors.set(name, { ...actor, cookie: cookieFrom(response), setCookie: raw });
  }
  return response;
});

/** Registers `newName` as another name for the same already-set-up actor's session — e.g. "alice" is also her own "current" session "s1" in REQ-EA-151's own Given. */
export const aliasActor = Effect.fn("features.session.aliasActor")(function* (
  newName: string,
  existingName: string,
) {
  const { actors } = yield* World;
  yield* actors.set(newName, yield* actors.get(existingName));
});
