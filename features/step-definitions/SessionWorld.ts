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
// - **Real rows.** `Sessions` is `layerSql` over an in-memory SQLite client (core's own
//   migrations), so a step can read the persisted row (`readSessionRow`) — the memory layer
//   keeps its rows in a private `Ref` no step can reach.
// - **Simulated time.** A `TestClock` is part of the composition (started at the real "now",
//   which the CSRF double-submit token's `iat` is minted against) and `advance` moves it, so
//   day-scale expiry math runs in the same runtime the handler serves from.
// - **Log/span capture.** `@awthaq/test`'s `RedactionGuard` records every span, log line and
//   published event, so "the secret never reaches a log or span" is checkable.
// - **Fiber interleaving.** A `gate` endpoint behind the real `Authentication` middleware whose
//   handler blocks until released, so "validated, then revoked, then completes" can be driven.
import { Api, AuthCore } from "@awthaq/api";
import {
  AuditLog,
  AuthEvents,
  Accounts,
  DataExport,
  Erasure,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, RateLimiter, SqlTransaction } from "@awthaq/ports";
import type { Mailer } from "@awthaq/ports";
import { Password, PasswordApi } from "@awthaq/password";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import { RedactionGuard } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { CSRF_TEST_COOKIE_VALUE, CsrfConfigForTests, withCsrfCookie } from "./CsrfTestSupport.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mailedToken } from "./MailedToken.ts";
import {
  cheapArgon2id,
  cookieFrom,
  letForkedFibersRun,
  makeCapturingMailer,
  makeNamedRegistry,
  setCookieFrom,
  STRONG_PASSWORD,
  TestServices,
} from "./shared/Harness.ts";

const CoreMigrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

const sessionsSql = (config: Sessions.SessionConfig) =>
  Sessions.layerSql.pipe(
    Layer.provide(Repositories.SessionsRepositoryLive),
    Layer.provide(Layer.succeed(Sessions.SessionConfig, config)),
    Layer.provideMerge(CoreMigrated),
  );

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// The simulated clock moves by days in some scenarios; a token older than the default 24h would
// be rejected, so this World's double-submit token outlives every scenario's simulated span.
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, { ...CsrfConfigForTests, maxAge: Duration.days(400) }),
  ),
  Layer.provide(NodeCrypto.layer),
);

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
const GateApi = HttpApi.make("gate").add(GateGroup);

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

const buildAppLayer = (settings: Sessions.SessionConfig, gate: Gate) => {
  const { layer: capturingMailer, sent } = makeCapturingMailer();

  const CoreLive = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    // CSG-001: the account handler runs `AccountErasure` over these same stores (and
    // over the registry `Hooks.HooksLive` provides).
    Layer.provideMerge(
      Layer.mergeAll(
        Users.layerMemory,
        Accounts.layerMemory,
        sessionsSql(settings),
        Verification.layerMemory,
      ),
    ),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
  );

  // Records every span, log line and published event of this composition (BEH-EA-199).
  // The base logger set is emptied first (the guard's own logger merges with what it finds), so
  // the suite's output is not one console line per request.
  const GuardLive = RedactionGuard.layerEvents.pipe(
    Layer.provideMerge(RedactionGuard.layer.pipe(Layer.provide(Logger.layer([])))),
  );

  // Simulated time, started at the real "now": the CSRF token's `iat` is minted against the
  // wall clock, and rows are stamped by the ambient clock.
  const ClockLive = Layer.effectDiscard(TestClock.setTime(Date.now())).pipe(
    Layer.provideMerge(TestClock.layer()),
  );

  const appLayer = Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/password-openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
    AuthHttp.routes(GateApi, { openapiPath: "/gate-openapi.json" }).pipe(
      Layer.provide(GateHandlers(gate)),
    ),
    AuthHttp.docs(AuthCore.AuthCoreApi),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(GuardLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(cheapArgon2id, capturingMailer, RateLimiter.layerPermissive).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    // CSG-001/DRS-002: `Account.deleteUser` runs inside a `SqlTransaction` — a no-op wrapper
    // for this composition, same as `TestAuth.layer`'s own default and `OAuth.test.ts`'s.
    Layer.provide(SqlTransaction.layerNoop),
    // AGA-001/NHS-003: `Password`'s sign-up/sign-in/reset resolve through `ClientAddress` too.
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
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
  | RedactionGuard.RedactionGuard;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly memoMap: Layer.MemoMap;
  readonly appLayer: ReturnType<typeof buildAppLayer>["appLayer"];
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
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
  const built: AppHandle = { handler, memoMap, appLayer, sentMail: sent, gate };
  yield* Ref.set(world.app, built);
  return built;
});

/**
 * Runs `effect` against the services the handler itself is running (the shared `MemoMap` hands
 * back the already-built instances), on the real clock — the `TestClock` it may adjust is the
 * one in the app's own context.
 */
export const inApp = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  Effect.gen(function* () {
    const { appLayer, memoMap } = yield* appHandle();
    return yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const context = yield* Layer.buildWithMemoMap(appLayer, memoMap, scope);
            return yield* effect.pipe(Effect.provide(context), Effect.orDie);
          }),
        ),
      ),
    );
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
      yield* sql`UPDATE sessions SET secretHash = ${secretHash} WHERE id = ${sessionId}`;
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
        SELECT COUNT(*) AS n FROM sessions WHERE userId = ${userId}`;
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

  yield* letForkedFibersRun;
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
