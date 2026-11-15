// @awthaq/test — the app harness: serve, listen, withApp, lazyApp, buildContext and the open-app counter LeakGuard reads (spec/behaviors/25-testing-harness.md, BEH-EA-351..353).
import { Api } from "@awthaq/api";
import { SessionCookie, Sessions, Users } from "@awthaq/core";
import { Defects } from "@awthaq/ports";
import { Csrf } from "@awthaq/server";
import { UserAgent } from "@awthaq/web";
import { csrfSetCookie, signInAs, withRequest, withoutRequest } from "./session.ts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as http from "node:http";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NetAddress from "effect/net/NetAddress";

/** What a request through `TestAuth.app` may carry: an agent's `RequestInit`. */
export type RequestInit = UserAgent.RequestInit;

/** How an agent of a `TestAuth.app` behaves. */
export interface AgentOptions {
  /** `bearer`: a native client (no cookies; the delivery header and `Authorization`). Default `cookie`. */
  readonly delivery?: "cookie" | "bearer";
  /** `throw` (default): a `Set-Cookie` a browser would refuse fails the request. `record`: kept in `refused`. */
  readonly onRefused?: "throw" | "record";
  /** Requests to these URLs never complete. */
  readonly hold?: (url: URL) => boolean;
}

/** What `signIn` takes beside the email. */
export interface SignInOptions {
  readonly name?: string;
  readonly amr?: ReadonlyArray<Sessions.AuthMethod>;
  readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
}

/** An agent already holding a session minted straight against `Users`/`Sessions`. */
export interface SignedInAgent extends UserAgent.UserAgent {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
}

/**
 * BEH-EA-T3: the composition served and read through one memo map, so the handler and the test's own
 * context share every instance (a session minted through `run` authenticates a request through `handler`).
 */
export interface App<A, E = never> {
  /** The raw `(Request) => Promise<Response>` the composition serves. */
  readonly handler: (request: Request) => Promise<Response>;
  /**
   * Runs an effect against the composition's own context (the instances the plugins use). ADR-EA-047: it runs as
   * in-process work that answers no request (`noRequest`) unless `app`'s `request` option names one.
   */
  readonly run: <X, XE, XR extends A | Api.AuthRequestContext>(
    effect: Effect.Effect<X, XE, XR>,
  ) => Promise<X>;
  /**
   * BEH-EA-333: a fresh browser (or native client) over this composition: its own cookie store, the
   * composition's clock, and a `__Host-csrf` cookie already held (minted from the composition's own
   * `CsrfConfig`, independently of `Csrf.ts`), so its first unsafe request echoes it like a page script.
   */
  readonly agent: (options?: AgentOptions) => Promise<UserAgent.UserAgent>;
  /**
   * Mints a user and a session (as `signInAs`) and returns an agent holding it: the session cookie rendered
   * under the composition's `SessionCookieConfig`, or the bearer token with `delivery: "bearer"`.
   */
  readonly signIn: (
    email: string,
    options?: SignInOptions & AgentOptions,
  ) => Promise<SignedInAgent>;
  /** One request from a fresh anonymous agent (nothing leaks between unrelated requests). */
  readonly request: (method: string, path: string, init?: RequestInit) => Promise<Response>;
  /**
   * The composition's context, built once on the real clock: for a World that runs effects *directly* on its own fiber
   * (under a step's `TestClock`) against the very instances `handler` serves from. A service that reads the clock when
   * it is built (`CsrfProtection`) is therefore not pinned to a `TestClock`'s epoch.
   */
  readonly context: () => Promise<Context.Context<A>>;
  /**
   * The memo map the handler and `run` share. A caller that builds more layers beside the app (a hand-made router, a
   * second stack that must see the same `Sessions`) builds them with `Layer.buildWithMemoMap(layer, app.memoMap, scope)`.
   */
  readonly memoMap: Layer.MemoMap;
  /**
   * A `ManagedRuntime` over the same composition and memo map, for code that takes a runtime instead of a context
   * (`getSession(headers, runtime)`): a session issued through `handler`, `run` or this runtime is visible to the others.
   * Built lazily; released with the app.
   */
  readonly runtime: ManagedRuntime.ManagedRuntime<A, E>;
  /**
   * Moves the composition's clock forward: with `testClock: true` the handler, `run`, `runtime` and every agent's
   * cookie store all read one `TestClock`, so a session expires, a window resets, a token lapses (and a cookie's
   * `Max-Age` with it) when the test says so. Without the option there is no `TestClock` to move and the promise
   * rejects.
   */
  readonly advance: (by: Duration.Input) => Promise<void>;
}

/** What `serve` itself reads from the composition: the CSRF config, and the stores `signIn` writes through. */
export type AppNeeds = Csrf.CsrfConfig | Users.Users | Sessions.Sessions;

// Measurement for the leak guard (plan 34): apps served and not yet released.
let openAppCount = 0;
export const openApps = () => openAppCount;

/** How an app runs (BEH-EA-351). */
export interface ServeOptions {
  /**
   * The origin agents address (default `http://localhost`, a secure context): a plugin that derives a URL from
   * the request's host sees it, and an agent applies a browser's `Domain`/`Secure` rules against it.
   */
  readonly baseUrl?: string;
  /**
   * Serve the composition over one `TestClock` (`true`: time starts at the epoch; `"now"`: at the wall clock): `advance` moves it for the handler,
   * for `run` and for every agent's cookie store alike.
   */
  readonly testClock?: boolean | "now";
  /** An existing memo map to build into, so several apps (or a hand-made router) share the instances they have in common. */
  readonly memoMap?: Layer.MemoMap;
  /** ADR-EA-047: the request `run` answers (`withRequest`'s facts); by default none (`noRequest`). */
  readonly request?: Parameters<typeof withRequest>[0];
}

const make = <A, E>(composition: Layer.Layer<A | AppNeeds, E>, options: ServeOptions) => {
  const baseUrl = options.baseUrl ?? "http://localhost";
  const memoMap = options.memoMap ?? Layer.makeMemoMapUnsafe();
  const simulated = options.testClock === true || options.testClock === "now";
  const appLayer = Layer.merge(
    composition,
    options.testClock === "now"
      ? Layer.effectDiscard(TestClock.setTime(Date.now())).pipe(
          Layer.provideMerge(TestClock.layer()),
        )
      : options.testClock === true
        ? TestClock.layer()
        : Layer.empty,
  );
  const scope = Scope.makeUnsafe();
  openAppCount++;
  const web = HttpRouter.toWebHandler(appLayer, { memoMap, disableLogger: true });
  let context: Promise<Context.Context<A | AppNeeds>> | undefined;
  const built = () => {
    context ??= Effect.runPromise(Layer.buildWithMemoMap(appLayer, memoMap, scope));
    return context;
  };
  const inRequest = options.request === undefined ? withoutRequest : withRequest(options.request);
  const run: App<A | AppNeeds, E>["run"] = (effect) =>
    built().then((services) => Effect.runPromiseWith(services)(inRequest(effect)));
  const runtime = ManagedRuntime.make(appLayer, { memoMap });
  const handler = (request: Request) => web.handler(request);

  // The agents' clock: the composition's `TestClock` (re-read whenever an agent is made or the clock moves),
  // or the wall clock.
  let clockMs = 0;
  const syncClock = async () => {
    if (simulated) clockMs = await run(Clock.currentTimeMillis);
  };
  const now = simulated ? () => clockMs : Date.now;

  // The CSRF cookie every agent starts with, minted from the composition's own config.
  let csrfConfig:
    | Promise<{
        readonly secret: Redacted.Redacted<string>;
        readonly cookie: ReturnType<typeof SessionCookie.csrfCookieOptions>;
      }>
    | undefined;
  const csrfCookie = async () => {
    csrfConfig ??= run(
      Effect.gen(function* () {
        const config = yield* Csrf.CsrfConfig;
        const cookieConfig = yield* SessionCookie.SessionCookieConfig;
        return { secret: config.secret, cookie: SessionCookie.csrfCookieOptions(cookieConfig) };
      }),
    );
    const { secret, cookie } = await csrfConfig;
    return csrfSetCookie(secret, { issuedAt: Math.floor(now() / 1000), ...cookie });
  };

  const agent = async (agentOptions: AgentOptions = {}) => {
    await syncClock();
    const made = UserAgent.make({
      handler,
      origin: baseUrl,
      now,
      ...(agentOptions.delivery === undefined ? {} : { delivery: agentOptions.delivery }),
      ...(agentOptions.onRefused === undefined ? {} : { onRefused: agentOptions.onRefused }),
      ...(agentOptions.hold === undefined ? {} : { hold: agentOptions.hold }),
    });
    if (agentOptions.delivery !== "bearer") made.cookies.receive(await csrfCookie());
    return made;
  };

  const app: App<A | AppNeeds, E> = {
    handler,
    run,
    agent,
    signIn: async (email, signInOptions = {}) => {
      const { delivery, onRefused, hold, ...mint } = signInOptions;
      const signedIn = await run(signInAs({ email, ...mint }));
      const made = await agent({
        ...(delivery === undefined ? {} : { delivery }),
        ...(onRefused === undefined ? {} : { onRefused }),
        ...(hold === undefined ? {} : { hold }),
      });
      if (delivery === "bearer") {
        made.bearer.set(Redacted.value(signedIn.token));
      } else {
        const received = made.cookies.receive(signedIn.setCookie);
        if (received._tag !== "Stored") {
          throw new Error(
            `TestAuth.app: the agent did not store the minted session cookie (${received._tag === "Refused" ? received.refusal : received._tag}); is \`baseUrl\` an origin its \`SessionCookieConfig\` can set cookies on?`,
          );
        }
      }
      return {
        ...made,
        userId: signedIn.userId,
        token: signedIn.token,
      };
    },
    request: async (method, path, init = {}) => (await agent()).request(method, path, init),
    context: built,
    memoMap,
    runtime,
    advance: async (by) => {
      if (!simulated) {
        throw new Error("TestAuth.app: `advance` needs the `testClock: true` option");
      }
      await run(TestClock.adjust(by));
      await syncClock();
    },
  };
  const release = async () => {
    await web.dispose();
    await runtime.dispose();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    openAppCount--;
  };
  return { app, release, appLayer, memoMap };
};

/**
 * BEH-EA-351: serves `composition` for as long as the caller's scope is open (built lazily, on the real clock) and
 * releases everything it built when the scope closes, whether by success, failure or interruption. It replaces the
 * hand-rolled `Layer.makeMemoMapUnsafe` + `HttpRouter.toWebHandler` + `buildWithMemoMap` blocks, the per-suite
 * CSRF token mint and the hand-threaded cookies: agents keep cookies, echo CSRF and follow rotations.
 */
export const serve = <A, E>(
  composition: Layer.Layer<A | AppNeeds, E>,
  options: ServeOptions = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => make(composition, options)),
    (made) => Effect.promise(made.release),
  ).pipe(Effect.map((made) => made.app));

/** BEH-EA-353: the same app, also bound to 127.0.0.1 on an ephemeral port. */
export interface ListeningApp<A, E = never> extends App<A, E> {
  readonly url: string;
  /**
   * `METHOD /path?query`, oldest first, for every request the socket answered. In-process `handler` and agent
   * requests are not logged: the log is the socket's.
   */
  readonly requests: () => ReadonlyArray<string>;
}

/**
 * BEH-EA-353: `serve`, plus a Node HTTP listener on `127.0.0.1:0` over the same instances, for an out-of-process
 * client (the CLI's generated `HttpApiClient`). Agents stay in-process. The socket closes before the app releases.
 */
export const listen = <A, E>(
  composition: Layer.Layer<A | AppNeeds, E>,
  options: ServeOptions = {},
) =>
  Effect.gen(function* () {
    const made = yield* Effect.acquireRelease(
      Effect.sync(() => make(composition, options)),
      (acquired) => Effect.promise(acquired.release),
    );
    const log: Array<string> = [];
    const socketScope = yield* Scope.fork(yield* Effect.scope, "sequential");
    const server = yield* Layer.buildWithMemoMap(
      HttpRouter.serve(made.appLayer, {
        disableLogger: true,
        disableListenLog: true,
        middleware: (app) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            log.push(`${request.method} ${request.url}`);
            return yield* app;
          }),
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => http.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
      made.memoMap,
      socketScope,
    ).pipe(Effect.map((context) => Context.get(context, HttpServer.HttpServer)));
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die("TestAuth.listen: the server did not bind a TCP port");
    }
    const listening: ListeningApp<A | AppNeeds, E> = {
      ...made.app,
      url: `http://127.0.0.1:${server.address.port}`,
      requests: () => [...log],
    };
    return listening;
  });

/** BEH-EA-351: the bracket for a promise-style test; the app is released when `use` settles, either way. */
export const withApp = async <A, E, T>(
  composition: Layer.Layer<A | AppNeeds, E>,
  options: ServeOptions | undefined,
  use: (app: App<A | AppNeeds, E>) => Promise<T>,
) => {
  const settled = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(serve(composition, options), (served) =>
        // The callback's own rejection is carried out of the scope as a value, so it is thrown unchanged once the app is released.
        Effect.promise(() =>
          use(served).then(
            (value) => ({ failed: false as const, value }),
            (error: unknown) => ({ failed: true as const, error }),
          ),
        ),
      ),
    ),
  );
  if (settled.failed) throw settled.error;
  return settled.value;
};

/** BEH-EA-352: a World's one app cell. */
export interface LazyApp<O, R> {
  readonly options: Effect.Effect<O>;
  /** Accumulates a Given's choice. A defect once `get` has built ("configure before the first request"). */
  readonly configure: (update: (current: O) => O) => Effect.Effect<void>;
  /** Releases what `get` built (if anything) and starts over from `options`: the one explicit rebuild. */
  readonly replace: (options: O) => Effect.Effect<void>;
  /** Builds on first use from the accumulated options, into a child of the cell's scope; then the same value. */
  readonly get: Effect.Effect<R>;
}

/**
 * BEH-EA-352: a lazily built app that lives in the scope that created the cell (a World's per-scenario scope). `build`
 * runs once, on the first `get`, from the options accumulated by `configure`; `replace` is the one explicit rebuild.
 * `alignStepClock` sets the caller's `TestClock` to the wall clock before the first build.
 */
export const lazyApp = <O, R>(
  initial: O,
  build: (options: O) => Effect.Effect<R, never, Scope.Scope>,
  settings: { readonly name?: string; readonly alignStepClock?: boolean } = {},
) =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope;
    const name = settings.name ?? "TestAuth.lazyApp";
    type State = {
      readonly options: O;
      readonly built: Option.Option<{ readonly value: R; readonly scope: Scope.Closeable }>;
    };
    const state = yield* SynchronizedRef.make<State>({ options: initial, built: Option.none() });
    const get = SynchronizedRef.modifyEffect(state, (current) =>
      Option.match(current.built, {
        onSome: ({ value }) => Effect.succeed([value, current] as const),
        onNone: () =>
          Effect.gen(function* () {
            if (settings.alignStepClock === true) yield* TestClock.setTime(Date.now());
            const child = yield* Scope.fork(parent, "sequential");
            const value = yield* build(current.options).pipe(Scope.provide(child));
            return [
              value,
              { options: current.options, built: Option.some({ value, scope: child }) },
            ] as const;
          }),
      }),
    );
    const release = (current: State) =>
      Option.match(current.built, {
        onNone: () => Effect.void,
        onSome: ({ scope }) => Scope.close(scope, Exit.void),
      });
    return {
      options: Effect.map(SynchronizedRef.get(state), (current) => current.options),
      configure: (update) =>
        SynchronizedRef.updateEffect(state, (current) =>
          Option.isSome(current.built)
            ? Defects.invariantViolation(
                "TestAuth",
                `${name}: configure after the app was built; configure in a Given before the first request, or call replace`,
              )
            : Effect.succeed({ ...current, options: update(current.options) }),
        ),
      replace: (options) =>
        SynchronizedRef.updateEffect(state, (current) =>
          Effect.as(release(current), { options, built: Option.none() }),
        ),
      get,
    } satisfies LazyApp<O, R>;
  });

/**
 * Builds `layer` into a context on the real clock and resolves it, for a World that runs effects *directly* on its own
 * fiber (under a step's `TestClock`) against services that must be constructed on the real one: a service that reads
 * the clock when it is built (`CsrfProtection`) would otherwise be pinned to 1970. Each call gets its own memo map
 * unless `memoMap` is given; `scope` owns the build (closing it releases the layer).
 */
export const buildContext = <A, E>(
  layer: Layer.Layer<A, E>,
  options: { readonly scope: Scope.Scope; readonly memoMap?: Layer.MemoMap },
): Promise<Context.Context<A>> =>
  Effect.runPromise(
    Layer.buildWithMemoMap(layer, options.memoMap ?? Layer.makeMemoMapUnsafe(), options.scope),
  );
