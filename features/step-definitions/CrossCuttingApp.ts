// P20a (decision 36, tier 3): the one app the cross-cutting Worlds (hooks, events, rate
// limiting) share. It is `@awthaq/test`'s `TestAuth.layer` over the password plugin — the
// ETVS-004 bundle: memory repositories, a cheap real argon2id, a capturing mailer, the
// permissive `RateLimiter` and every hook point — so a scenario adds only what it is *about*:
// a tap, a subscriber, a stricter limiter. Steps call the real `Password` service (or the
// composed router, for wire-level claims) inside the built context; nothing is mocked that the
// scenario does not name.
//
// The layer is built lazily, at the first `run`/`dispatch`, from whatever the Givens
// configured: a tap or a subscriber must be in the graph before the first hook run (BEH-EA-024
// freezes a point at its first read), so configuration after that is a defect in the scenario,
// and fails loudly.
import { Auth, AuditLog, AuthEvents, Hooks, RateLimits, Sessions, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { createHmac, randomBytes } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CsrfConfigForTests } from "./CsrfTestSupport.ts";

/** One captured log line: its level, and everything it carried (message parts and annotations), JSON-rendered so a step can search it. */
export interface LogRecord {
  readonly level: string;
  readonly text: string;
}

/** `JSON.stringify` replacer that renders a `Cause` as its structure, so a log's whole payload is searchable. */
const replacer = (_key: string, value: unknown): unknown =>
  Cause.isCause(value) ? { cause: Cause.pretty(value) } : value;

const makeLogCapture = () => {
  const records = Ref.makeUnsafe<ReadonlyArray<LogRecord>>([]);
  const layer = Logger.layer([
    Logger.make((options) => {
      Effect.runSync(
        Ref.update(records, (existing) => [
          ...existing,
          {
            level: options.logLevel,
            text: JSON.stringify({ message: options.message }, replacer),
          },
        ]),
      );
    }),
  ]);
  return { records: Ref.get(records), layer };
};

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

/** BEH-EA-119: a corpus nothing ever matches (and `breachCheck` is off below anyway) — the app never reaches the network. */
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** Every hook point a tap layer may require: they ride in the `TestAuth` bundle (`Hooks.HooksLive`). */
export type HookPoints =
  | Hooks.BeforeSignUp
  | Hooks.AfterSignUp
  | Hooks.BeforeSignIn
  | Hooks.AfterSignIn
  | Hooks.BeforeSessionIssue
  | Hooks.BeforeUserDelete
  | Hooks.AfterUserAttributesChanged;

/** A tap or a subscription: something a scenario adds to the composition, satisfied by the bundle's hook points and `AuthEvents`. */
export type Contribution = Layer.Layer<never, never, HookPoints | AuthEvents.AuthEvents>;

export interface AppSpec {
  /**
   * Password policy for the scenario. The default turns off what a cross-cutting scenario is
   * not about and would only slow down (breach lookup, the calibrated timing floor, email
   * verification before sign-in).
   */
  readonly passwordConfig: Partial<Password.PasswordConfigShape>;
  readonly contributions: ReadonlyArray<Contribution>;
  /** Replaces the bundle's permissive limiter for the plugin (BEH-EA-112: a test that wants rate limiting provides its own). */
  readonly rateLimiter: Layer.Layer<RateLimiter.RateLimiter> | undefined;
}

export const emptySpec: AppSpec = {
  passwordConfig: { breachCheck: false, signInTimingFloor: "off", requireVerifiedEmail: false },
  contributions: [],
  rateLimiter: undefined,
};

const appLayer = (spec: AppSpec) =>
  TestAuth.layer(
    Auth.make([Password.Password]),
    Layer.mergeAll(
      AuthenticationLive,
      CsrfProtectionLive,
      NoBreachHttpClient,
      Password.config(spec.passwordConfig),
      ...(spec.rateLimiter === undefined ? [] : [spec.rateLimiter]),
      ...spec.contributions,
    ),
  );

/**
 * What a step may `yield*` inside the built app. Spelled out from the package entry points
 * (not `Layer.Success<typeof appLayer>`) so the exported types stay nameable — the inferred
 * layer type reaches through per-package `node_modules` symlinks (TS2883).
 */
export type AppServices =
  | HookPoints
  | AuditLog.AuditLog
  | AuthEvents.AuthEvents
  | Mailer.Mailer
  | Password.Password
  | RateLimiter.RateLimiter
  | RateLimits.RateLimitsRegistry
  | Sessions.Sessions
  | Users.Users
  | HttpRouter.HttpRouter;

export interface Host {
  readonly configure: (change: (spec: AppSpec) => AppSpec) => Effect.Effect<void>;
  /** Runs `effect` inside the built app, capturing whatever it logs. Builds the app on first use. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Effect.Effect<A, E>;
  /** Sends one web `Request` through the composed router (the same seam `TestAuth.test.ts` uses). */
  readonly dispatch: (request: Request) => Effect.Effect<Response>;
  readonly logs: Effect.Effect<ReadonlyArray<LogRecord>>;
  /** The scope the app lives in — a scenario adding a late subscription builds it here. */
  readonly scope: Scope.Scope;
  /** The built app's context, for a step that builds a further layer over it (a late subscription). */
  readonly context: Effect.Effect<Context.Context<AppServices>>;
  /** Logger layer a step-built layer needs so the fibers it forks write to the capture too. */
  readonly captureLogs: Layer.Layer<never>;
}

export const makeHost = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const spec = yield* Ref.make(emptySpec);
  const built = yield* Ref.make<Option.Option<Context.Context<AppServices>>>(Option.none());
  const capture = makeLogCapture();

  const context = Effect.gen(function* () {
    const existing = yield* Ref.get(built);
    if (Option.isSome(existing)) return existing.value;
    const fresh = yield* Layer.buildWithScope(appLayer(yield* Ref.get(spec)), scope).pipe(
      // A ConfigError here is a defect in the fixed spec, not a runtime condition.
      Effect.orDie,
      // The capture logger is in scope while the graph builds so the fibers its layers fork
      // (subscriptions, sweepers) write to it too; `RedactionGuard` merges with, not replaces, it.
      Effect.provide(capture.layer),
    );
    yield* Ref.set(built, Option.some(fresh));
    return fresh;
  });

  const configure: Host["configure"] = (change) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* Ref.get(built))) {
        return yield* Effect.die(
          new Error("the app is already built — every tap, subscriber and limiter must be configured by a Given, before the first action"),
        );
      }
      yield* Ref.update(spec, change);
    });

  const run: Host["run"] = (effect) =>
    Effect.flatMap(context, (ctx) =>
      effect.pipe(Effect.provide(ctx), Effect.provide(capture.layer)),
    );

  const dispatch: Host["dispatch"] = (request) =>
    run(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        const response = yield* router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Effect.scoped,
          );
        return HttpServerResponse.toWeb(response);
      }).pipe(Effect.orDie),
    );

  const host: Host = {
    configure,
    run,
    dispatch,
    logs: capture.records,
    scope,
    context,
    captureLogs: capture.layer,
  };
  return host;
});

/**
 * A JSON POST carrying a double-submit CSRF pair minted at the *current clock reading*.
 * `CsrfTestSupport`'s fixed token is stamped with the real time at module load, which is what
 * the other Worlds' real-clock handlers accept; a scenario here runs under `TestClock` (time
 * starts at the epoch), where that token's `iat` lies in the future and `CsrfProtection`
 * refuses it. Same construction (`<iat>.<random>.<hmac(iat.random)>`, HMAC-SHA256 over the
 * configured secret), stamped by the clock the request will be checked against.
 */
export const jsonPost = (path: string, body: unknown) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const signed = `${Math.floor(now / 1000)}.${randomBytes(32).toString("hex")}`;
    const signature = createHmac("sha256", Redacted.value(CsrfConfigForTests.secret))
      .update(signed)
      .digest("hex");
    const token = `${signed}.${signature}`;
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${CSRF_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: token,
      },
      body: JSON.stringify(body),
    });
  });
