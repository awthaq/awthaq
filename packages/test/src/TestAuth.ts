// @awthaq/test — TestAuth
//
// spec/behaviors/25-testing-harness.md, BEH-EA-193 through BEH-EA-200.
//
// **What is deliberately not built here, and why:**
// - BEH-EA-193's "permissive `RateLimiter`" is wired in below
//   (`RateLimiter.layerPermissive`, `@awthaq/ports`'s own BEH-EA-112
//   default; `rateLimiter: "enforcing"` swaps in the real in-memory limiter).
//   `RateLimits.layer` (`@awthaq/core`'s per-plugin rule
//   *registry* half) is provided too: every plugin that declares rate-limit
//   rules opens a `RateLimits.budget` in its layer, and core's own `account`
//   handlers do the same, so building any of them (and, by extension,
//   `TestAuth.layer(built)`) genuinely needs a `RateLimitsRegistry` instance
//   to register into.
// - BEH-EA-194 (`TestClock`) and BEH-EA-195 (`Layer.mock`) are `effect`'s own
//   exports, not awthaq's — nothing to wrap; a test simply imports them
//   directly (`effect/testing/TestClock`, `effect/Layer`).
// - BEH-EA-196 (`qadiTestLayer`, `subjectWith`) is `@qadi/testing`'s own
//   package, already published and real — again nothing to wrap. Its
//   illustrative `subjectWith` does not exist under that name in the real,
//   installed `@qadi/testing`/`@qadi/core`; the real equivalent is
//   `@qadi/core`'s own `makeSubject`/`fromRoles`, and `@qadi/testing`'s
//   `Fixtures.ts` ready-made subjects — a test imports those directly.
// - BEH-EA-200 (hook veto/observe isolation): `runPluginContractTests`' opt-in `hooks`
//   option (PV-260) exercises each tap the plugin *declares* (`AuthPlugin.layer`'s
//   `taps`, whose handlers `plugin.taps` exposes) against a stub input on a fresh point
//   of the tap's own kind. Taps an application adds itself are not declared on a plugin;
//   a test taps a point by passing the tap in `TestAuth.layer`'s `taps` option — it
//   requires its point, which the base provides (every core point's own layer,
//   `Hooks.HooksLive`) or a composed plugin declares (`AuthPlugin.Service`'s `hookPoints`,
//   provided once beneath the taps). The mechanism itself is covered by
//   `packages/core/test/HookPoint.test.ts`.
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   mechanical (EOTS-002): `RedactionGuard` installs a recording tracer and
//   logger (and an `AuthEvents` inspector) into `TestAuth.layer`, and
//   `runPluginContractTests`' opt-in `redaction` option drives a plugin's flows
//   against it with canary secrets.
//
// **`TestAuth.signInAs` targets `HttpRouter.toWebHandler`'s raw
// `(Request) => Promise<Response>` shape, not `HttpApiTest.groups`'s
// in-memory client.** BEH-EA-197's own illustrative code calls
// `client.admin.stats()` with no visible session plumbing after
// `signInAs`, implying some ambient mechanism thread a session into later
// calls automatically — but `HttpApiTest.groups` builds its own internal
// `HttpClient` with no seam for injecting a cookie header into it, and
// exposes no such seam itself. Every wire-level test already built in this
// repository (`password`'s, `oauth`'s, `qadi`'s, `server`'s own
// `AuthHttp.test.ts` files) instead threads a `Set-Cookie`/`cookie` header
// by hand between `HttpRouter.toWebHandler`'s real `Request`/`Response`
// objects — a proven, already-exercised pattern with a real extension seam.
// `signInAs` returns the ready-to-use cookie header string for exactly that
// pattern, rather than reimplementing (or fighting) `HttpApiTest.groups`'s
// internals for an ambient-session mechanism this codebase does not
// otherwise use anywhere.
//
// **`signInAs`'s `roles` is a caller-supplied callback, not a `{roles: [...]}`
// list.** `@awthaq/test` sits in the same stratum as `@awthaq/roles`
// (both are downstream of `core`/`server`/`qadi`/`sql`/`ports`/`api`, per
// `spec/overview.md`'s own package map) — it does not depend on `roles` (or
// any other plugin package), so it has no way to assign a role itself. A
// caller that has installed `Roles` passes `onSignedUp: (userId) =>
// roles.assign(userId, "member")`; `signInAs` runs it, if given, right after
// issuing the user and before minting the session.
import type { TestFramework } from "./TestFramework.ts";
import { Api } from "@awthaq/api";
import {
  Auth,
  AuthEvents,
  AuthPlugin,
  type DataExport,
  type Erasure,
  EventDefinition,
  HookPoint,
  Migrations,
  type Retention,
  SessionCookie,
  Sessions,
  Users,
} from "@awthaq/core";
import { ClientAddress, type Encryption, Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthHost, Credentials, Csrf } from "@awthaq/server";
import { CoreMigrations } from "@awthaq/sql";
import { UserAgent } from "@awthaq/web";
import { memoryFoundation } from "./internal/foundation.ts";
import * as RecordsContract from "./RecordsContract.ts";
import * as RedactionGuard from "./RedactionGuard.ts";
import * as TestEncryption from "./TestEncryption.ts";
import * as TestSql from "./TestSql.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { createHmac, randomBytes } from "node:crypto";
import * as Arbitrary from "effect/Arbitrary";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Cookies from "effect/http/Cookies";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * ETVS-004: a real argon2id hasher at the smallest legal cost, so a sign-up/sign-in suite
 * does not pay production KDF time per hash (the algorithm, salt, PHC format and rehash
 * path are the real ones; only m/t are lowered). A ConfigError here is a defect in this
 * fixed table, not a runtime condition.
 */
const TestHasher = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: { AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" },
      }),
    ),
  ),
  Layer.orDie,
);

/** Named so the foundations' inferred types can be emitted (declaration emit needs the namespace in scope). */
export type RetentionRegistryService = Retention.RetentionRegistry;
/** Named for the same reason: the registries `Hooks.HooksLive` provides, and the test ports' fixed key. */
export type FoundationServices =
  | AuthEvents.AuthEvents
  | DataExport.DataExportRegistry
  | Erasure.ErasureRegistry
  | Encryption.Encryption;

// ELC-004: `memoryFoundation`, what every memory layer needs beneath it (defined in `internal/foundation.ts`,
// shared with `RecordsContract`).
export { memoryFoundation } from "./internal/foundation.ts";

/**
 * The test ports: a cheap real hasher, a capturing mailer, a permissive (or the real) limiter, the socket peer, a fixed
 * key, and the platform crypto services. `rateLimiter` is `RateLimiter.layerPermissive` (BEH-EA-112: a test that signs
 * in fifty times in a loop should not fail for a reason unrelated to what it tests) unless a suite asks for
 * `"enforcing"`: the real limiter over the in-memory store, so lockout and throttle behaviour is the production one.
 * The registries (`RateLimits.layer`, `Slots.layer`, the credential-resolver registry) are not ports: `AuthHost`
 * provides them.
 */
const testPorts = (
  rateLimiter: "permissive" | "enforcing" | undefined,
  clientAddress: string | undefined,
) =>
  Layer.mergeAll(
    TestHasher,
    Mailer.layerMemory,
    rateLimiter === "enforcing" ? RateLimiter.layerMemory : RateLimiter.layerPermissive,
    // AGA-001/NHS-003: the raw-`remoteAddress` passthrough every zero-config app gets by default (a web handler
    // reports none); ADR-EA-047: a suite that needs a known address over HTTP fixes one.
    clientAddress === undefined ? ClientAddress.layerDirect : fixedClientAddress(clientAddress),
    TestEncryption.layer,
  ).pipe(Layer.provideMerge(NodeCrypto.layer));

/** A `ClientAddress` that resolves every request to `address`, so a wire test records and keys on a known one. */
const fixedClientAddress = (address: string) =>
  Layer.succeed(
    ClientAddress.ClientAddress,
    ClientAddress.ClientAddress.of({ resolve: () => Effect.succeed(Option.some(address)) }),
  );

/**
 * ADR-EA-047: runs `self` as if it answered an HTTP request with these facts: an in-process unit test of a plugin
 * operation that records or keys on the request. The correlation id defaults to `"test"`.
 */
export const withRequest =
  (
    facts: {
      readonly ip?: string | undefined;
      readonly userAgent?: string | undefined;
      readonly correlationId?: string | undefined;
    } = {},
  ) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      self,
      Api.AuthRequestContext,
      Api.AuthRequestContext.request({ ...facts, correlationId: facts.correlationId ?? "test" }),
    );

/** ADR-EA-047: runs `self` as in-process work that answers no request (a job, a CLI command). */
export const withoutRequest = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.provideService(self, Api.AuthRequestContext, Api.AuthRequestContext.noRequest);

const GuardLive = RedactionGuard.layerEvents.pipe(Layer.provideMerge(RedactionGuard.layer));

/**
 * The default CSRF configuration of every `TestAuth` composition: a fixed secret (at least 32 bytes), no
 * allowed origins. `options.csrf` overrides fields of it. `TestAuth.app(...).request` reads the composition's
 * own value back, so a test never repeats the secret.
 */
export const TestCsrfConfig: Csrf.CsrfConfigShape = {
  secret: Redacted.make("test-auth-csrf-secret-padded-to-at-least-thirty-two-bytes"),
  allowedOrigins: [],
};

/** The two record modes a composition runs over: the same suite, the same plugins, a different database. */
export const recordModes: readonly ["memory", "sql"] = ["memory", "sql"];

/** Options every mode shares. */
export interface CommonOptions<S, SE, SR, D, DR, T = never> {
  /**
   * What is genuinely the test's own: plugin configuration (`Plugin.config(...)`), adapters (`XmlSignature`,
   * `WebAuthn`, `HttpClient`, a fake fetcher, a transport), and doubles. It is **merged into the output**, so
   * a test that `yield*`s a service only this provides gets the very instance the plugins used (a capturing
   * `Mailer` given here is the one the plugin sends through and the one the test reads). It sits closest to
   * the plugins, so it may override a derived middleware or a base service *for the plugins*; a base service
   * captured by a core store (a custom `SecureRandom`) is not seen by it: use `decorate` or `memoryFoundation` for
   * that. Never put a core store, a plugin record layer or host middleware here: the harness provides them.
   */
  readonly services?: Layer.Layer<S, SE, SR>;
  /**
   * Wraps base services in place (a `Users` that fails, a `Sessions` spy): built over the base, it shadows
   * the base service for the plugins and for the test alike.
   */
  readonly decorate?: Layer.Layer<D, never, DR>;
  /**
   * Application taps. They receive the same point instances the plugins run (core's and the declared `hookPoints`); a
   * tap on a point no composed plugin declares stays in `RIn` and does not compile (INV-EA-005).
   */
  readonly taps?: Layer.Layer<never, never, T>;
  /** Overrides fields of `TestCsrfConfig`. */
  readonly csrf?: Partial<Csrf.CsrfConfigShape>;
  /** Defaults to `Credentials.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` opts into `emailVerified`. */
  readonly principalResolver?: Layer.Layer<
    Credentials.PrincipalResolver,
    never,
    Users.Users | Sessions.Sessions
  >;
  /** `"permissive"` (default) never refuses; `"enforcing"` is the real limiter over the in-memory store. */
  readonly rateLimiter?: "permissive" | "enforcing";
  /**
   * ADR-EA-047: the address every request resolves to (a fixed `ClientAddress`). By default the socket peer, which a
   * web handler never reports, so a wire test that asserts a recorded address or a per-address limit sets one.
   */
  readonly clientAddress?: string;
  /** P20a (BEH-EA-084): serve the generated OpenAPI document at this path. */
  readonly openapiPath?: `/${string}`;
  /** P20a (BEH-EA-084): serve the Scalar docs page at this path. */
  readonly docsPath?: `/${string}`;
  /** AR-003: the groups this composition serves (`AuthHost`'s `tier`). Default `"all"`. */
  readonly tier?: "all" | "public" | "admin";
}

/** BEH-EA-T2: `records: "sql"` needs a `suite` (one distinct name per test file; it names the Postgres schema). */
export type SqlMode = { readonly records: "sql"; readonly suite: string };
export type MemoryMode = { readonly records?: "memory" };

/** What `TestAuth` adds beneath `AuthHost.layer`: the test ports and the HTTP platform. */
type TestProvided =
  | Layer.Success<ReturnType<typeof testPorts>>
  | Layer.Success<typeof HttpServer.layerServices>
  | Layer.Success<typeof HttpRouter.layer>;

/** The recording guard rides in `AuthHost`'s `decorate` slot (above the base, beneath the records). */
type Guarded<D> = D | Layer.Success<typeof GuardLive>;
type GuardIn<DR> = DR | Layer.Services<typeof GuardLive>;

/** Everything a composition provides beneath its plugins, besides the middleware it derives. */
type Provided<P extends ReadonlyArray<AuthPlugin.Any>, M extends "memory" | "sql", S, D> =
  | AuthHost.Provided<P, M, S, Guarded<D>>
  | TestProvided;

/** What a composition still requires: `AuthHost`'s host-owned remainder minus the test ports and the platform. */
type Requires<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  M extends "memory" | "sql",
  S,
  SR,
  T,
  D,
  DR,
> = Exclude<
  AuthHost.Requires<P, Extra, M, S, SR, T, Guarded<D>, GuardIn<DR>, never, never, never>,
  TestProvided
>;

/**
 * The one implementation behind every `layer` overload, over the widest shapes. Contract tests use it directly
 * (`runPluginContractTests`' `build` check), where the plugin tuple is only known as `AuthPlugin.Any`. BEH-EA-342:
 * it is `AuthHost.layer` over the test ports, the redaction guard and the HTTP platform, nothing else.
 */
const makeLayer = <P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<never, unknown, unknown, never, unknown, unknown> &
    (MemoryMode | SqlMode) = {},
): Layer.Layer<never, unknown, unknown> => {
  const shared = {
    // The one `CsrfConfig` layer: the derived `CsrfProtection` reads it, and it is merged into the output so
    // `TestAuth.app` can mint a token against the very secret the composition checks.
    csrf: Layer.succeed(Csrf.CsrfConfig, { ...TestCsrfConfig, ...options.csrf }),
    ...(options.principalResolver === undefined
      ? {}
      : { principalResolver: options.principalResolver }),
    services: options.services ?? Layer.empty,
    taps: options.taps ?? Layer.empty,
    // EOTS-002: the recording tracer/logger (and the `AuthEvents` inspector) ride in the decorate slot, above the
    // base and beneath the records, where they always sat; they only record, `assertNoLeaks` is what fails.
    decorate: (options.decorate ?? Layer.empty).pipe(Layer.provideMerge(GuardLive)),
    tier: options.tier ?? "all",
    // `BodyLimit` has its own suite. The request context is derived with the middleware (ADR-EA-047).
    bodyLimit: false,
    openapiPath: options.openapiPath,
    docsPath: options.docsPath,
  };
  const platform = <A, E, R>(host: Layer.Layer<A, E, R>) =>
    host.pipe(
      // ADR-EA-049: a plugin that emits an event it did not list in its `events` fails its own tests.
      Layer.provideMerge(Layer.succeed(AuthEvents.UndeclaredEventPolicy, "die")),
      Layer.provideMerge(testPorts(options.rateLimiter, options.clientAddress)),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provideMerge(HttpRouter.layer),
    );
  // BEH-EA-T2: SQLite `:memory:` by default, a per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`, migrated with
  // core's migrations and then the composition's before anything is built over the client (`Migrations.apply`).
  return options.records === "sql" && "suite" in options
    ? platform(
        AuthHost.layer(built, {
          ...shared,
          persistence: {
            records: "sql",
            client: TestSql.layer(options.suite),
            migrations: "apply",
          },
        }),
      )
    : platform(AuthHost.layer(built, { ...shared, persistence: { records: "memory" } }));
};

/**
 * BEH-EA-193: `TestAuth.layer(Auth.make(plugins), { services })`: the whole pipeline over memory (or, with
 * `records: "sql", suite`, over a migrated database).
 *
 * Takes the already-`Auth.make`-built value rather than a raw plugin list. `Auth.make` is only callable, from
 * outside its own module, through its precise, `Validate<P>`-checked overload: a generic wrapper cannot
 * simplify its own abstract `Validate<P>` back to a concrete tuple to forward, and a second parallel
 * non-empty-tuple check would drift from `Auth.make`'s. Accepting the *result* sidesteps it: `Auth.Built<P>`
 * is a plain interface, so ordinary generic inference works and the caller gets `Validate<P>`'s real
 * compile-time checking exactly where they call `Auth.make`.
 *
 * What it builds, so a test does not (BEH-EA-342): `AuthHost.layer` plus the test ports, the redaction guard and the
 * HTTP platform. `AuthHost` derives the host middleware the composed groups declare (`CsrfProtection` over
 * `TestCsrfConfig`, BEH-EA-T1), every composed plugin's `records` bundle for the chosen mode and its declared
 * `hookPoints` (BEH-EA-T4/T5), the core services over `Persistence.memory` / `Persistence.sql()` with the
 * migrations applied, the registries, erasure and export; `TestAuth` adds a cheap argon2id hasher,
 * `Mailer.layerMemory`, a permissive `RateLimiter`, `Encryption` over a fixed key, `ClientAddress`, the platform
 * crypto services and the recording `RedactionGuard` (EOTS-002). `BodyLimit.layer` is off; the request context is derived
 * with the host middleware, as in production (ADR-EA-047).
 * Its `RIn` is `never` exactly when the composition is complete, and every service in its `ROut` is present
 * at runtime (including everything `services` provides).
 *
 * Declared as an overload for the same reason `Auth.make` is: the precise formula cannot be verified against
 * an abstract `P` inside the body, so the implementation is checked against a deliberately widened signature.
 */
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  S = never,
  SE = never,
  SR = never,
  D = never,
  DR = never,
  T = never,
>(
  built: Auth.Built<P, Extra>,
  options?: CommonOptions<S, SE, SR, D, DR, T> & MemoryMode,
): Layer.Layer<
  Provided<P, "memory", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  SE,
  Requires<P, Extra, "memory", S, SR, T, D, DR>
>;
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  S = never,
  SE = never,
  SR = never,
  D = never,
  DR = never,
  T = never,
>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<S, SE, SR, D, DR, T> & SqlMode,
): Layer.Layer<
  Provided<P, "sql", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  SE,
  Requires<P, Extra, "sql", S, SR, T, D, DR>
>;
export function layer(
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  options: CommonOptions<never, unknown, unknown, never, unknown, unknown> &
    (MemoryMode | SqlMode) = {},
): Layer.Layer<never, unknown, unknown> {
  return makeLayer(built, options);
}

export interface SignedInSession {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
  /**
   * The session's `Set-Cookie`, rendered under the composition's own `SessionCookieConfig` (name, `Domain`,
   * `SameSite`, `Max-Age`): hand it to an agent with `agent.cookies.receive(setCookie)`.
   */
  readonly setCookie: string;
}

/** Serialises a cookie Effect's `Cookies` accepts; a value it refuses is a defect of the fixture. */
const serialize = (name: string, value: string, options: Cookies.Cookie["options"]) =>
  Effect.fromResult(Cookies.makeCookie(name, value, options)).pipe(
    Effect.map(Cookies.serializeCookie),
    Effect.orDie,
  );

/**
 * The `Set-Cookie` the server would answer for `issued`, rendered under the ambient `SessionCookieConfig` (the
 * composition's, inside `app.run`): for a session issued straight against `Sessions` (an existing user, a second
 * session of one user), handed to an agent with `agent.cookies.receive(...)`.
 */
export const sessionSetCookie = (issued: Sessions.IssuedSession) =>
  Effect.gen(function* () {
    const rendered = yield* SessionCookie.render(issued.session, issued.token);
    return yield* serialize(rendered.name, rendered.value, rendered.options);
  });

/**
 * BEH-EA-197: mints a real user and a real session directly against
 * `Users`/`Sessions` — no password, no HTTP round trip — so an
 * authorization test's setup cost is independent of whichever credential
 * plugin (if any) is installed, matching this behavior's own point: testing
 * *authorization*, not sign-up. The cookie is rendered under the ambient
 * `SessionCookieConfig`, the one the composition's server reads.
 */
export const signInAs = (input: {
  readonly email: string;
  readonly name?: string;
  readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
  /** How the session says the user authenticated (`["pwd"]`, `["fed"]`, ...); none by default. */
  readonly amr?: ReadonlyArray<Sessions.AuthMethod>;
  /** ADR-EA-047: the request the session records (`withRequest`'s facts); by default none (`noRequest`). */
  readonly request?: Parameters<typeof withRequest>[0];
}): Effect.Effect<SignedInSession, never, Users.Users | Sessions.Sessions> =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users
      .create({ identity: { _tag: "Email", email: input.email }, name: input.name ?? input.email })
      .pipe(Effect.orDie);
    if (input.onSignedUp !== undefined) {
      yield* input.onSignedUp(user.id);
    }
    const issued = yield* sessions
      .issue({ userId: user.id, ...(input.amr === undefined ? {} : { amr: input.amr }) })
      .pipe(
        input.request === undefined ? withoutRequest : withRequest(input.request),
        Effect.orDie,
      );
    return { userId: user.id, token: issued.token, setCookie: yield* sessionSetCookie(issued) };
  });

/**
 * BEH-EA-T3: a signed double-submit CSRF token (`<iat>.<random>.<hmac>`), computed with `node:crypto`
 * independently of `Csrf.ts`'s own implementation, so a passing request proves RFC 2104 compatibility and
 * not mere self-consistency with the code under test. Valid for the secret it was minted against.
 */
export const csrfToken = (
  secret: Redacted.Redacted<string> | string,
  options?: {
    /** The `iat` in seconds; defaults to the wall clock. A suite running under `TestClock` (which starts at 0) passes `0`. */
    readonly issuedAt?: number;
  },
): string => {
  const signed = `${options?.issuedAt ?? Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const key = Redacted.isRedacted(secret) ? Redacted.value(secret) : secret;
  return `${signed}.${createHmac("sha256", key).update(signed).digest("hex")}`;
};

/**
 * The `Set-Cookie` of a freshly minted `__Host-csrf` (see `csrfToken`), for seeding an agent over a hand-wired
 * handler the way `TestAuth.app` seeds its own: `agent.cookies.receive(TestAuth.csrfSetCookie(secret))`.
 * `sameSite`/`partitioned` follow `SessionCookie.csrfCookieOptions` (default `Strict`).
 */
export const csrfSetCookie = (
  secret: Redacted.Redacted<string> | string,
  options?: {
    readonly issuedAt?: number;
    readonly sameSite?: "strict" | "none";
    readonly partitioned?: true;
  },
): string =>
  Effect.runSync(
    serialize(
      Api.CSRF_COOKIE_NAME,
      csrfToken(
        secret,
        options?.issuedAt === undefined ? undefined : { issuedAt: options.issuedAt },
      ),
      {
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: options?.sameSite ?? "strict",
        ...(options?.partitioned === undefined ? {} : { partitioned: options.partitioned }),
      },
    ),
  );

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
   * Built lazily; `dispose` releases it.
   */
  readonly runtime: ManagedRuntime.ManagedRuntime<A, E>;
  /**
   * Moves the composition's clock forward: with `testClock: true` the handler, `run`, `runtime` and every agent's
   * cookie store all read one `TestClock`, so a session expires, a window resets, a token lapses (and a cookie's
   * `Max-Age` with it) when the test says so. Without the option there is no `TestClock` to move and the promise
   * rejects.
   */
  readonly advance: (by: Duration.Input) => Promise<void>;
  /** Releases everything the composition built. */
  readonly dispose: () => Promise<void>;
}

/** What `app` itself reads from the composition: the CSRF config, and the stores `signIn` writes through. */
export type AppNeeds = Csrf.CsrfConfig | Users.Users | Sessions.Sessions;

/**
 * BEH-EA-T3/BEH-EA-333: serves `appLayer` (normally `TestAuth.layer(Auth.make([...]), ...)`) and returns the
 * handle a wire-level suite uses: agents that keep cookies, echo CSRF and follow rotations. It replaces the
 * hand-rolled `Layer.makeMemoMapUnsafe` + `HttpRouter.toWebHandler` + `buildWithMemoMap` blocks, the per-suite
 * CSRF token mint and the hand-threaded cookies.
 */
export const app = <A, E>(
  composition: Layer.Layer<A | AppNeeds, E>,
  options: {
    /**
     * The origin agents address (default `http://localhost`, a secure context): a plugin that derives a URL from
     * the request's host sees it, and an agent applies a browser's `Domain`/`Secure` rules against it.
     */
    readonly baseUrl?: string;
    /**
     * Serve the composition over one `TestClock` (time starts at the epoch): `advance` moves it for the handler,
     * for `run` and for every agent's cookie store alike.
     */
    readonly testClock?: boolean;
    /** An existing memo map to build into, so several apps (or a hand-made router) share the instances they have in common. */
    readonly memoMap?: Layer.MemoMap;
    /** ADR-EA-047: the request `run` answers (`withRequest`'s facts); by default none (`noRequest`). */
    readonly request?: Parameters<typeof withRequest>[0];
  } = {},
): App<A | AppNeeds, E> => {
  const baseUrl = options.baseUrl ?? "http://localhost";
  const memoMap = options.memoMap ?? Layer.makeMemoMapUnsafe();
  const appLayer = Layer.merge(
    composition,
    options.testClock === true ? TestClock.layer() : Layer.empty,
  );
  const scope = Scope.makeUnsafe();
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
    if (options.testClock === true) clockMs = await run(Clock.currentTimeMillis);
  };
  const now = options.testClock === true ? () => clockMs : Date.now;

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

  return {
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
      if (options.testClock !== true) {
        throw new Error("TestAuth.app: `advance` needs the `testClock: true` option");
      }
      await run(TestClock.adjust(by));
      await syncClock();
    },
    dispose: async () => {
      await web.dispose();
      await runtime.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

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

/** `Encryption` over a fixed test key (also in every composition's base); for a store suite that builds `Persistence.sql()` alone. */
export const encryption = TestEncryption.layer;

const clientReturning = (body: (url: string) => string, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body(request.url), { status })),
      ),
    ),
  );

/**
 * `HttpClient` doubles for the breach check (and any other outbound call a test must not make). Not in the
 * base on purpose: a test that forgets its receiver must fail to compile, not silently get a stub.
 */
export const httpClient = {
  /** Answers every request with `body(url)`. */
  returning: clientReturning,
  /** A well-formed range listing that never matches a real suffix (PHS-004: an empty body counts as unavailable). */
  noBreach: clientReturning(() => `${"F".repeat(35)}:1`),
  /** Every request fails with a transport error. */
  unavailable: Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    ),
  ),
};

/** A `TestFramework` whose `fail` throws, over the runner's own `describe`/`it` (what every contract file wrote by hand). */
export const throwingFramework = (
  describe: TestFramework["describe"],
  it: TestFramework["it"],
): TestFramework => ({
  describe,
  it,
  fail: (message) => {
    throw new Error(message);
  },
});

// ---------------------------------------------------------------------------
// BEH-EA-198/199 (second half): runPluginContractTests
// ---------------------------------------------------------------------------

/**
 * Plan 25 (BEH-EA-334, ADR-EA-041 decision 9): the record-store contract, required exactly when the
 * plugin's bundle provides a store (`RecordsContract.Suites<P>` then names every one), forbidden for a
 * plugin whose bundle provides none, and optional for a hand-built `AuthPlugin.Any` (whose stores the
 * compiler cannot see; the runner's coverage check is its half).
 */
export type RecordsOption<P> = P extends { readonly records: infer B extends AuthPlugin.AnyRecords }
  ? [AuthPlugin.RecordKeysOf<Layer.Success<B["memory"]>>] extends [never]
    ? { readonly records?: never }
    : { readonly records: RecordsContract.RunConfig<P> }
  : { readonly records?: RecordsContract.RunConfig<P> };

export interface ContractTestOptions<O, R = never> {
  readonly options: ReadonlyArray<O>;
  /**
   * Other plugins to compose alongside the plugin under test. Defaults to the plugin's own transitive
   * `dependsOn` closure (dependencies first), so `{ options: [{}] }` is enough for every plugin; `host: []`
   * still exercises `E_PLUGIN_MISSING_DEP`.
   */
  readonly host?: ReadonlyArray<AuthPlugin.Any>;
  /**
   * Plan 08 (BEH-EA-T6): opt in to the composition-builds check. `TestAuth.layer(Auth.make([...host, plugin]),
   * { records, suite, services })` is built for both record modes, which catches a plugin that composes over
   * memory but not over SQL. Opt-in because adapters such as `XmlSignature`, `WebAuthn` and `HttpClient` must
   * come from the caller (`services`).
   */
  readonly build?: { readonly services: Layer.Layer<never, unknown, unknown> };
  /**
   * EOTS-002/BEH-EA-199: opt in to the mechanical redaction check. `app` is the
   * composition to drive (normally `TestAuth.layer(Auth.make([...]), services)`, which
   * installs the `RedactionGuard`), `exercise` runs the plugin's flows against it — call
   * `guard.watch("password", canary)` first for every secret it will feed in. The check
   * fails if any `Redacted` value or watched canary reaches a span, a log line or a
   * published event (a leak names the channel and the canary's label, never the secret).
   * Without it the check is not registered: the harness cannot build a plugin whose
   * layer needs services it was not given.
   */
  readonly redaction?: {
    readonly app: Layer.Layer<RedactionGuard.RedactionGuard | R, unknown>;
    readonly exercise: (
      guard: RedactionGuard.RedactionGuardShape,
    ) => Effect.Effect<void, unknown, R | RedactionGuard.RedactionGuard>;
  };
  /**
   * PV-260/BEH-EA-200: opt in to the hook-kind checks. Every tap the plugin declares is always
   * checked to register its own handler at its own point (a plugin-owned entry in that point's
   * resolved chain, at the declared order); for each tap whose point appears here the plugin's
   * *actual handler* is run against the stub `input` — an observe tap must not try to abort (it
   * must not fail with `HookAbort`) and its failure must not reach the operation it observes, a
   * veto tap may only succeed or abort with `HookAbort`, a divert tap must not fail. `point` is
   * the hook point class (`Hooks.AfterSignUp`), `input` a value of its input schema (a stub that
   * does not match makes the check fail, naming the point). A `hooks` entry for a point the
   * plugin does not tap fails too, so a typo cannot silently skip a check.
   */
  readonly hooks?: ReadonlyArray<{
    readonly point: { readonly id: string };
    readonly input: unknown;
  }>;
  /**
   * ADR-EA-049: the plugin's declared `events` are always checked (`EventDefinition.problems`, plus sampled
   * erasure and actor properties). `notPersonal` lists `"<tag>.<field>"` free-text-looking fields that hold no
   * personal data (give each a comment saying why); every other such field must be declared `pii`.
   */
  readonly events?: { readonly notPersonal?: ReadonlyArray<string> };
}

/** Events sampled per declared definition by the contract runner's erasure/actor check. */
const EVENT_SAMPLES = 25;

/**
 * ADR-EA-049: plan 09 T3's sampled properties of each declared event. P3: blanking its declared personal-data
 * fields still decodes, so erasure never makes its audit row unreadable. P4: its actor is absent or a value the
 * event carries. Deterministic: each definition is sampled with its tag as the seed.
 */
const sampledEventProblems = (definitions: ReadonlyArray<EventDefinition.Any>) =>
  Effect.map(
    Effect.forEach(definitions, (definition) =>
      Effect.gen(function* () {
        const meta = definition[EventDefinition.MetaKey];
        const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(definition), {
          count: EVENT_SAMPLES,
          seed: meta.tag,
        }).pipe(Effect.orElseSucceed(() => []));
        const found = new Set<string>();
        for (const event of samples) {
          const encoded = Schema.encodeUnknownOption(definition)(event);
          const blanked = Option.map(encoded, (value) =>
            typeof value === "object" && value !== null
              ? Object.fromEntries(
                  Object.entries(value).map(([key, item]) => [
                    key,
                    meta.pii.includes(key) ? "" : item,
                  ]),
                )
              : value,
          );
          if (Option.isNone(Option.flatMap(blanked, Schema.decodeUnknownOption(definition)))) {
            found.add(`${meta.tag}: blanking its pii fields makes the event undecodable (P3)`);
          }
          const actor = EventDefinition.actorValue(meta, event);
          if (
            Option.isSome(actor) &&
            !Object.values(event).some(
              (value) => typeof value === "string" && value.endsWith(actor.value),
            )
          ) {
            found.add(`${meta.tag}: the actor is not a value the event carries (P4)`);
          }
        }
        return [...found];
      }),
    ),
    (perDefinition) => perDefinition.flat(),
  );

export type { TestFramework } from "./TestFramework.ts";

/**
 * SSMS-004: one fresh in-memory SQLite database, core migrations first, then `migrations`
 * on the plugin ledger — applied a second time to prove the migrator skips what it has
 * already applied — resolving to the resulting schema (every table/index and its SQL, minus
 * the two ledgers) so two independent applications can be compared.
 */
const applyMigrations = (migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"]) =>
  applyMigrationsOn(migrations, SqliteClient.layer({ filename: ":memory:" }));

const applyMigrationsOn = <E>(
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
  client: Layer.Layer<SqlClient.SqlClient, E>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The statement text ownership check below is SQLite's; on Postgres only the structural shape is read.
    const readSchema = sql.onDialectOrElse({
      pg: () =>
        Effect.succeed<
          ReadonlyArray<{
            readonly type: string;
            readonly name: string;
            readonly tbl_name: string;
            readonly sql: string;
          }>
        >([]),
      orElse: () => sql<{
        readonly type: string;
        readonly name: string;
        readonly tbl_name: string;
        readonly sql: string;
      }>`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('effect_sql_migrations', ${Migrations.pluginMigrationsTable})
      ORDER BY name`,
    });
    yield* Migrator.make({})({
      loader: CoreMigrations.coreMigrations,
      table: "effect_sql_migrations",
    });
    // PV-252/INV-EA-016: what core alone created, before any plugin migration runs.
    const coreSchema = yield* readSchema;
    yield* Migrations.run(migrations);
    const reapplied = yield* Migrations.run(migrations);
    const schema = yield* readSchema;
    const shape = yield* TestSql.schemaOf;
    return { schema, coreSchema, shape, reapplied: reapplied.length };
  }).pipe(Effect.provide(client), Effect.scoped);

/**
 * Plan 22 (schema lock): the structural schema core plus `plugin`'s dependency closure and the plugin
 * itself build on a fresh SQLite database, with the plugin's own migration names in ledger order.
 */
export const migratedSchema = (plugin: AuthPlugin.Any) => {
  const closure = dependencyClosure(plugin);
  const [first = plugin, ...rest] = closure.length === 0 ? [] : [...closure, plugin];
  return Effect.runPromise(
    Effect.all([applyMigrations([]), applyMigrations(Auth.make([first, ...rest]).migrations)]).pipe(
      Effect.map(([core, composed]) => ({
        migrations: plugin.migrations.map((migration) => migration.name),
        // What the plugins add: core's own tables, indexes and triggers are core's lock to keep.
        schema: {
          tables: Object.fromEntries(
            Object.entries(composed.shape.tables).filter(
              ([name]) => core.shape.tables[name] === undefined,
            ),
          ),
          indexes: composed.shape.indexes.filter(
            (index) => !core.shape.indexes.some((own) => own.name === index.name),
          ),
          triggers: composed.shape.triggers.filter(
            (trigger) => !core.shape.triggers.some((own) => own.name === trigger.name),
          ),
        },
      })),
    ),
  );
};

/** Every declared table exists, and so does every column a tenancy declaration names (plan 22, D3). */
const declarationProblems = (
  plugin: AuthPlugin.Any,
  shape: TestSql.SchemaShape,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const has = (table: string, column: string) =>
    shape.tables[table]?.some((candidate) => candidate.name === column) === true;
  for (const [table, { tenancy }] of Object.entries(plugin.tenancy ?? {})) {
    if (shape.tables[table] === undefined) {
      problems.push(`table "${table}" is declared but no migration creates it`);
      continue;
    }
    switch (tenancy._tag) {
      case "Partitioned":
      case "Keyed":
        if (!has(table, tenancy.column))
          problems.push(
            `${tenancy._tag.toLowerCase()} column "${table}.${tenancy.column}" does not exist`,
          );
        break;
      case "Derived":
        if (!has(table, tenancy.via))
          problems.push(`derived column "${table}.${tenancy.via}" does not exist`);
        if (!has(tenancy.parent, tenancy.parentKey))
          problems.push(
            `derived parent key "${tenancy.parent}.${tenancy.parentKey}" does not exist`,
          );
        break;
      case "Global":
        break;
    }
  }
  return problems;
};

/**
 * PV-252/INV-EA-016: what the plugins' migrations did to the schema core created. A core table
 * (or index) whose SQL changed was altered; anything new must hang off a table named under one
 * of the composition's plugin ids, so an index on a core table, or a table outside every plugin's
 * prefix, is refused too.
 */
const ownershipViolations = (
  coreSchema: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string;
  }>,
  schema: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string;
  }>,
  pluginIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const core = new Map(coreSchema.map((row) => [`${row.type}:${row.name}`, row]));
  const violations: Array<string> = [];
  for (const [key, before] of core) {
    const after = schema.find((row) => `${row.type}:${row.name}` === key);
    if (after === undefined) violations.push(`core ${before.type} "${before.name}" was dropped`);
    else if (after.sql !== before.sql) {
      violations.push(`core ${before.type} "${before.name}" was altered`);
    }
  }
  for (const row of schema) {
    if (core.has(`${row.type}:${row.name}`)) continue;
    if (!pluginIds.some((id) => TABLE_PREFIX_PATTERN(id).test(row.tbl_name))) {
      violations.push(
        `${row.type} "${row.name}" is on "${row.tbl_name}", which is outside every plugin's own table prefix`,
      );
    }
  }
  return violations;
};

const TABLE_PREFIX_PATTERN = (id: string): RegExp => new RegExp(`^${id}_`);

/**
 * PV-260: what running a declared tap on a fresh point of its own kind shows — the point's
 * resolved chain (does the plugin's entry sit in it), and, given a stub, how `run` ended for it
 * (a point's own failure semantics: observe swallows a failing tap, veto surfaces `HookAbort`).
 */
const runOnScratchPoint = (
  owner: AuthPlugin.Any,
  tap: AuthPlugin.DeclaredTap,
  stub: { readonly input: unknown } | undefined,
) => {
  const prefix = "awthaq/hook/";
  const id = tap.point.startsWith(prefix) ? tap.point.slice(prefix.length) : tap.point;
  const installed = tap.install(owner);
  switch (tap.kind) {
    case "veto": {
      const point = HookPoint.veto<unknown>()(id, Schema.Unknown);
      return Effect.gen(function* () {
        const shape = yield* point;
        return {
          resolved: yield* shape.resolved,
          run: stub === undefined ? undefined : yield* Effect.exit(shape.run(stub.input)),
        };
      }).pipe(Effect.provide(Layer.provideMerge(installed, point.layer)));
    }
    case "observe": {
      const point = HookPoint.observe<unknown>()(id, Schema.Unknown);
      return Effect.gen(function* () {
        const shape = yield* point;
        return {
          resolved: yield* shape.resolved,
          run: stub === undefined ? undefined : yield* Effect.exit(shape.run(stub.input)),
        };
      }).pipe(Effect.provide(Layer.provideMerge(installed, point.layer)));
    }
    case "divert": {
      const point = HookPoint.divert<unknown>()(id, Schema.Unknown, Schema.Unknown);
      return Effect.gen(function* () {
        const shape = yield* point;
        return {
          resolved: yield* shape.resolved,
          run: stub === undefined ? undefined : yield* Effect.exit(shape.run(stub.input)),
        };
      }).pipe(Effect.provide(Layer.provideMerge(installed, point.layer)));
    }
  }
};

/** The `HookAbort` a failed `Exit` carries, if its failure is one (a defect or another error is not an abort). */
const abortOf = (exit: Exit.Exit<unknown, unknown>): HookPoint.HookAbort | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === "Some" && failure.value instanceof HookPoint.HookAbort
    ? failure.value
    : undefined;
};

/** A plugin's transitive `dependsOn` closure, dependencies before dependents (the order `Auth.make` requires). */
const dependencyClosure = (plugin: AuthPlugin.Any): ReadonlyArray<AuthPlugin.Any> => {
  const ordered: Array<AuthPlugin.Any> = [];
  const visit = (candidate: AuthPlugin.Any) => {
    for (const dependency of candidate.dependsOn) {
      if (!ordered.some((installed) => installed.id === dependency.id)) {
        visit(dependency);
        ordered.push(dependency);
      }
    }
  };
  visit(plugin);
  return ordered;
};

/** Runs an effect whose requirements are known to be discharged but cannot be proven by the type of a widened layer. */
const runClosed = <A, E>(effect: Effect.Effect<A, E, unknown>) =>
  Effect.runPromiseWith(Context.makeUnsafe<unknown>(new Map()))(effect);

/** The service keys a built context holds. */
const keysOf = (context: Context.Context<never>): ReadonlyArray<string> =>
  Array.from(context.mapUnsafe.keys()).sort();

/**
 * BEH-EA-T4/T6: the runtime half of `RecordsLegal`, for a hand-built `AuthPlugin.Any`. Builds `records.memory`
 * over the memory foundation, and `records.sql` over a fresh SQLite migrated with core and the composition's
 * migrations; both must build, and the two contexts must hold the same service keys. Resolves to the problems
 * found (empty when the bundle is matched).
 */
const recordsParityProblems = (
  plugin: AuthPlugin.Any,
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
): Promise<ReadonlyArray<string>> => {
  const bundle = plugin.records;
  if (bundle === undefined) return Promise.resolve([]);
  const memory = Layer.build(
    bundle.memory.pipe(Layer.provide(Layer.merge(memoryFoundation, TestEncryption.layer))),
  ).pipe(Effect.map(keysOf), Effect.scoped);
  const sql = Layer.build(
    bundle.sql.pipe(Layer.provide(Layer.merge(memoryFoundation, TestEncryption.layer))),
  ).pipe(
    Effect.map(keysOf),
    Effect.provideServiceEffect(
      SqlClient.SqlClient,
      Effect.gen(function* () {
        const sqlClient = yield* SqlClient.SqlClient;
        yield* Migrator.make({})({
          loader: CoreMigrations.coreMigrations,
          table: "effect_sql_migrations",
        });
        yield* Migrations.run(migrations);
        return sqlClient;
      }),
    ),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.scoped,
  );
  return runClosed(
    Effect.gen(function* () {
      const memoryExit = yield* Effect.exit(memory);
      const sqlExit = yield* Effect.exit(sql);
      const problems: Array<string> = [];
      if (Exit.isFailure(memoryExit)) {
        problems.push(`records.memory failed to build: ${Cause.pretty(memoryExit.cause)}`);
      }
      if (Exit.isFailure(sqlExit)) {
        problems.push(`records.sql failed to build: ${Cause.pretty(sqlExit.cause)}`);
      }
      if (Exit.isSuccess(memoryExit) && Exit.isSuccess(sqlExit)) {
        const onlyMemory = memoryExit.value.filter((key) => !sqlExit.value.includes(key));
        const onlySql = sqlExit.value.filter((key) => !memoryExit.value.includes(key));
        if (onlyMemory.length > 0) {
          problems.push(
            `records.memory provides stores records.sql does not: ${onlyMemory.join(", ")}`,
          );
        }
        if (onlySql.length > 0) {
          problems.push(
            `records.sql provides stores records.memory does not: ${onlySql.join(", ")}`,
          );
        }
      }
      return problems;
    }),
  );
};

/**
 * BEH-EA-198/199: the mechanically-verifiable subset of the plugin contract
 * suite — see this module's own header comment for BEH-EA-199's other half
 * (redaction), which is not.
 *
 * A third-party plugin author runs this against their own `makePlugin`
 * factory with no dependency on `@awthaq/*`'s own test files — only on
 * this package and their own `AuthPlugin.Any`-shaped plugin classes.
 */
export const runPluginContractTests = <O, P extends AuthPlugin.Any, R = never>(
  framework: TestFramework,
  makePlugin: (options: O) => P,
  config: ContractTestOptions<O, R> & RecordsOption<P>,
): void => {
  framework.describe("runPluginContractTests", () => {
    let previousContract: AuthPlugin.Any["contract"] | undefined;

    for (const [optionIndex, options] of config.options.entries()) {
      const plugin: AuthPlugin.Any = makePlugin(options);
      const host = config.host ?? dependencyClosure(plugin);
      const hostIds = new Set(host.map((installed) => installed.id));
      const label = JSON.stringify(options);

      framework.it(`${label}: id does not collide with a host plugin`, () => {
        if (hostIds.has(plugin.id)) {
          framework.fail(`E_PLUGIN_DUPLICATE_ID: "${plugin.id}" also names a host plugin`);
        }
      });

      // ADR-EA-047: the request context is captured outermost on every endpoint the plugin contributes, so every
      // middleware and handler of the endpoint reads its facts.
      framework.it(
        `${label}: every endpoint declares Api.RequestContext as its last middleware`,
        () => {
          const missing: Array<string> = [];
          const [first, ...rest] = [...host, plugin];
          if (first === undefined) return;
          const own = new Set(
            Object.values(plugin.contract.groups).map((group) => group.identifier),
          );
          HttpApi.reflect(Auth.make([first, ...rest]).api, {
            onGroup: () => {},
            onEndpoint: ({ group, endpoint, middleware }) => {
              if (
                own.has(group.identifier) &&
                [...middleware].at(-1)?.key !== Api.RequestContext.key
              ) {
                missing.push(`${group.identifier}.${endpoint.identifier}`);
              }
            },
          });
          if (missing.length > 0) {
            framework.fail(
              `plugin "${plugin.id}": these endpoints do not declare Api.RequestContext last: ${missing.join(", ")}`,
            );
          }
        },
      );

      // ADR-EA-049: the plugin's own events, always (vacuous for a plugin that publishes none).
      framework.it(`${label}: every declared event is well-formed`, () => {
        const problems = EventDefinition.problems(plugin.events ?? [], {
          notPersonal: config.events?.notPersonal ?? [],
        });
        if (problems.length > 0) {
          framework.fail(`plugin "${plugin.id}": ${problems.join("; ")}`);
        }
      });

      framework.it(
        `${label}: every declared event survives erasure and names an actor it carries (sampled)`,
        async () => {
          const problems = await Effect.runPromise(sampledEventProblems(plugin.events ?? []));
          if (problems.length > 0) {
            framework.fail(`plugin "${plugin.id}": ${problems.join("; ")}`);
          }
        },
      );

      framework.it(`${label}: every declared table carries this plugin's own id prefix`, () => {
        const prefix = TABLE_PREFIX_PATTERN(plugin.id);
        for (const table of plugin.tables) {
          if (!prefix.test(table)) {
            framework.fail(`table "${table}" does not carry plugin "${plugin.id}"'s own prefix`);
          }
        }
      });

      framework.it(`${label}: every dependsOn entry is present among the host plugins`, () => {
        const missing = plugin.dependsOn.filter((dep) => !hostIds.has(dep.id));
        if (missing.length > 0) {
          framework.fail(
            `E_PLUGIN_MISSING_DEP: plugin "${plugin.id}" depends on ` +
              `${missing.map((dep) => `"${dep.id}"`).join(", ")}, not present in host`,
          );
        }
      });

      framework.it(`${label}: migration declarations are deterministic across builds`, () => {
        const [first, ...rest] = [...host, plugin];
        if (first === undefined) {
          framework.fail("runPluginContractTests: host plus plugin under test was empty");
          return;
        }
        // Only what a build declares (names and their order) — the `up` effects are not
        // comparable as data; the check below applies them.
        const names = (built: ReturnType<typeof Auth.make>) =>
          JSON.stringify(built.migrations.map((migration) => migration.name));
        if (names(Auth.make([first, ...rest])) !== names(Auth.make([first, ...rest]))) {
          framework.fail(
            `plugin "${plugin.id}"'s migration declarations are not deterministic across two identical builds`,
          );
        }
      });

      // SSMS-004/REQ-EA-563: an actual double application, not a JSON comparison.
      framework.it(`${label}: migrations apply identically on two fresh databases`, async () => {
        const [first, ...rest] = [...host, plugin];
        if (first === undefined) {
          framework.fail("runPluginContractTests: host plus plugin under test was empty");
          return;
        }
        const outcome = await Effect.runPromise(
          Effect.exit(
            Effect.all([
              applyMigrations(Auth.make([first, ...rest]).migrations),
              applyMigrations(Auth.make([first, ...rest]).migrations),
            ]),
          ),
        );
        if (Exit.isFailure(outcome)) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations failed to apply: ${Cause.pretty(outcome.cause)}`,
          );
          return;
        }
        const [a, b] = outcome.value;
        if (JSON.stringify(a.shape) !== JSON.stringify(b.shape)) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations produced different schemas on two fresh databases — an \`up\` is not deterministic`,
          );
        }
        if (a.reapplied !== 0) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations were applied again on an already-migrated database (${a.reapplied} re-run)`,
          );
        }
      });

      // Plan 22 (D3, BEH-EA-198): the tables and tenancy columns a plugin declares exist after its migrations.
      framework.it(`${label}: every declared table and tenancy column exists`, async () => {
        const [first, ...rest] = [...host, plugin];
        if (first === undefined) {
          framework.fail("runPluginContractTests: host plus plugin under test was empty");
          return;
        }
        const outcome = await Effect.runPromise(
          Effect.exit(applyMigrations(Auth.make([first, ...rest]).migrations)),
        );
        if (Exit.isFailure(outcome)) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations failed to apply: ${Cause.pretty(outcome.cause)}`,
          );
          return;
        }
        const problems = declarationProblems(plugin, outcome.value.shape);
        if (problems.length > 0) {
          framework.fail(
            `plugin "${plugin.id}" declares tenancy its schema does not have: ${problems.join("; ")}`,
          );
        }
      });

      // Plan 22 (BEH-EA-198): under `AWTHAQ_POSTGRES_URL`, Postgres and SQLite build the same logical schema.
      if (process.env["AWTHAQ_POSTGRES_URL"] !== undefined) {
        framework.it(`${label}: Postgres and SQLite build the same logical schema`, async () => {
          const [first, ...rest] = [...host, plugin];
          if (first === undefined) {
            framework.fail("runPluginContractTests: host plus plugin under test was empty");
            return;
          }
          const migrations = Auth.make([first, ...rest]).migrations;
          const outcome = await Effect.runPromise(
            Effect.exit(
              Effect.all([
                // One schema per option set: a framework may run these checks concurrently, and
                // two builds sharing a schema race on its DROP/CREATE.
                applyMigrationsOn(
                  migrations,
                  TestSql.layer(`schema_parity_${plugin.id}_${optionIndex}`),
                ),
                applyMigrations(migrations),
              ]),
            ),
          );
          if (Exit.isFailure(outcome)) {
            framework.fail(
              `plugin "${plugin.id}"'s migrations failed to apply: ${Cause.pretty(outcome.cause)}`,
            );
            return;
          }
          const [onPostgres, onSqlite] = outcome.value;
          const differences = TestSql.parityDifferences(onPostgres.shape, onSqlite.shape);
          if (differences.length > 0) {
            framework.fail(
              `plugin "${plugin.id}" builds different logical schemas: ${differences.join("; ")}`,
            );
          }
        });
      }

      // PV-252/INV-EA-016: a plugin migration may create its own tables and nothing else. A shared
      // (core-owned) table is extended only through a declared extension point, never by an ALTER.
      framework.it(
        `${label}: migrations leave every core-owned table untouched (INV-EA-016)`,
        async () => {
          const [first, ...rest] = [...host, plugin];
          if (first === undefined) {
            framework.fail("runPluginContractTests: host plus plugin under test was empty");
            return;
          }
          const outcome = await Effect.runPromise(
            Effect.exit(applyMigrations(Auth.make([first, ...rest]).migrations)),
          );
          if (Exit.isFailure(outcome)) {
            framework.fail(
              `plugin "${plugin.id}"'s migrations failed to apply: ${Cause.pretty(outcome.cause)}`,
            );
            return;
          }
          const violations = ownershipViolations(
            outcome.value.coreSchema,
            outcome.value.schema,
            [...host, plugin].map((installed) => installed.id),
          );
          if (violations.length > 0) {
            framework.fail(
              `plugin "${plugin.id}"'s migrations break INV-EA-016 (shared tables are core's): ${violations.join("; ")}`,
            );
          }
        },
      );

      // BEH-EA-T4/T6: a plugin that declares `records` declares a *matched* pair: both build, same stores.
      if (plugin.records !== undefined) {
        framework.it(
          `${label}: records.memory and records.sql provide the same stores (BEH-EA-T4)`,
          async () => {
            const [first, ...rest] = [...host, plugin];
            if (first === undefined) {
              framework.fail("runPluginContractTests: host plus plugin under test was empty");
              return;
            }
            const problems = await recordsParityProblems(
              plugin,
              Auth.make([first, ...rest]).migrations,
            );
            if (problems.length > 0) {
              framework.fail(
                `plugin "${plugin.id}"'s records bundle is not matched: ${problems.join("; ")}`,
              );
            }
          },
        );
      }

      // BEH-EA-T6 (opt-in): the whole composition builds in both record modes, which catches a plugin that
      // composes over memory but not over SQL.
      const buildCheck = config.build;
      if (buildCheck !== undefined) {
        for (const mode of recordModes) {
          framework.it(`${label}: the composition builds over ${mode} records`, async () => {
            const [first, ...rest] = [...host, plugin];
            if (first === undefined) {
              framework.fail("runPluginContractTests: host plus plugin under test was empty");
              return;
            }
            const built = Auth.make([first, ...rest]);
            const composed =
              mode === "sql"
                ? makeLayer(built, {
                    services: buildCheck.services,
                    records: "sql",
                    suite: `contract_${plugin.id}`,
                  })
                : makeLayer(built, { services: buildCheck.services });
            const outcome = await runClosed(Effect.exit(Layer.build(composed).pipe(Effect.scoped)));
            if (Exit.isFailure(outcome)) {
              framework.fail(
                `plugin "${plugin.id}" does not compose over ${mode} records: ${Cause.pretty(outcome.cause)}`,
              );
            }
          });
        }
      }

      // PV-260/BEH-EA-200: the plugin's declared taps, checked as the plugin's own handlers.
      const stubs = config.hooks ?? [];
      for (const stub of stubs) {
        const point = `awthaq/hook/${stub.point.id}`;
        framework.it(
          `${label}: the hooks stub for "${stub.point.id}" names a tap this plugin declares`,
          () => {
            if (!plugin.taps?.some((tap) => tap.point === point)) {
              framework.fail(
                `plugin "${plugin.id}" declares no tap on hook point "${stub.point.id}", but a hooks stub was supplied for it`,
              );
            }
          },
        );
      }
      for (const tap of plugin.taps ?? []) {
        const stub = stubs.find((candidate) => `awthaq/hook/${candidate.point.id}` === tap.point);
        framework.it(
          `${label}: the tap on "${tap.point}" registers this plugin's handler at that point`,
          async () => {
            const outcome = await Effect.runPromise(
              Effect.exit(runOnScratchPoint(plugin, tap, undefined).pipe(Effect.scoped)),
            );
            if (Exit.isFailure(outcome)) {
              framework.fail(
                `the tap on "${tap.point}" could not be installed: ${Cause.pretty(outcome.cause)}`,
              );
              return;
            }
            if (
              !outcome.value.resolved.some(
                (entry) => entry.owner === plugin.id && entry.order === tap.order,
              )
            ) {
              framework.fail(
                `plugin "${plugin.id}"'s tap (order ${tap.order}) is not in "${tap.point}"'s resolved chain`,
              );
            }
          },
        );
        if (stub === undefined) continue;
        framework.it(
          `${label}: the ${tap.kind} tap on "${tap.point}" obeys its point's kind (BEH-EA-200)`,
          async () => {
            // What the handler does on its own, before any point's semantics apply.
            const direct = await Effect.runPromise(Effect.exit(tap.exercise(stub.input)));
            if (Exit.isFailure(direct)) {
              framework.fail(
                `the hooks stub for "${tap.point}" does not match the point's input: ${Cause.pretty(direct.cause)}`,
              );
              return;
            }
            const ended = direct.value;
            const abort = abortOf(ended);
            if (tap.kind === "observe" && abort !== undefined) {
              framework.fail(
                `plugin "${plugin.id}"'s tap on the observe point "${tap.point}" tried to abort the operation it observes (HookAbort "${abort.code}") — only a veto point's tap may abort`,
              );
            }
            if (tap.kind === "divert" && Exit.isFailure(ended)) {
              framework.fail(
                `plugin "${plugin.id}"'s tap on the divert point "${tap.point}" failed instead of returning Option.none()/Option.some(...): ${Cause.pretty(ended.cause)}`,
              );
            }
            if (tap.kind === "veto" && Exit.isFailure(ended) && abort === undefined) {
              framework.fail(
                `plugin "${plugin.id}"'s tap on the veto point "${tap.point}" failed with something other than HookAbort: ${Cause.pretty(ended.cause)}`,
              );
            }
            // Then through a point of the same kind: the operation must come out as the kind promises.
            const viaPoint = await Effect.runPromise(
              Effect.exit(runOnScratchPoint(plugin, tap, stub).pipe(Effect.scoped)),
            );
            if (Exit.isFailure(viaPoint)) {
              framework.fail(
                `the tap on "${tap.point}" could not be run: ${Cause.pretty(viaPoint.cause)}`,
              );
              return;
            }
            const run = viaPoint.value.run;
            if (run === undefined) return;
            if (tap.kind === "observe" && Exit.isFailure(run)) {
              framework.fail(
                `a failure in plugin "${plugin.id}"'s observer on "${tap.point}" reached the operation it observes: ${Cause.pretty(run.cause)}`,
              );
            }
            if (tap.kind === "veto" && Exit.isFailure(run) && abortOf(run) === undefined) {
              framework.fail(
                `plugin "${plugin.id}"'s veto tap on "${tap.point}" ended the operation with something other than HookAbort: ${Cause.pretty(run.cause)}`,
              );
            }
            if (tap.kind === "divert" && Exit.isFailure(run)) {
              framework.fail(
                `plugin "${plugin.id}"'s divert tap on "${tap.point}" ended the operation abnormally: ${Cause.pretty(run.cause)}`,
              );
            }
          },
        );
      }

      const redaction = config.redaction;
      if (redaction !== undefined) {
        // EOTS-002/BEH-EA-199: the mechanical half — nothing secret reaches a span, log or event.
        framework.it(
          `${label}: no Redacted value or watched secret reaches a span, log line or event`,
          async () => {
            const outcome = await Effect.runPromise(
              Effect.exit(
                Effect.scoped(
                  Effect.gen(function* () {
                    const context = yield* Layer.build(redaction.app);
                    const guard = Context.get(context, RedactionGuard.RedactionGuard);
                    yield* redaction.exercise(guard).pipe(Effect.provide(context));
                    // Let subscriber fibers drain what the flows just published.
                    yield* Effect.sleep("10 millis");
                    yield* guard.assertNoLeaks;
                  }),
                ),
              ),
            );
            if (Exit.isFailure(outcome)) {
              const failure = Cause.squash(outcome.cause);
              framework.fail(
                failure instanceof RedactionGuard.RedactionLeak
                  ? failure.message
                  : `the redaction check could not run: ${Cause.pretty(outcome.cause)}`,
              );
            }
          },
        );
      }

      framework.it(`${label}: this option value does not change the plugin's own contract`, () => {
        if (previousContract !== undefined && previousContract !== plugin.contract) {
          framework.fail(
            `plugin "${plugin.id}"'s contract changed with a different option value — ` +
              "a plugin's contract must be a fixed value its options never influence (ADR-EA-011)",
          );
        }
        previousContract = plugin.contract;
      });
    }

    // Plan 25 (ADR-EA-041 decision 9): every store the plugin's bundle provides passes its RecordsContract
    // suite on memory and SQL. Run once, over the first option value (the suites do not depend on options).
    const records = config.records;
    const [firstOptions] = config.options;
    if (records !== undefined && firstOptions !== undefined) {
      const plugin = makePlugin(firstOptions);
      RecordsContract.run(framework, plugin, config.host ?? dependencyClosure(plugin), records);
    }
  });
};

// Plan 05: the plugin-table conformance suites, beside `runPluginContractTests` so a third-party
// plugin runs them the same way (`TestAuth.runTenantIsolationTests`, `TestAuth.runSealedColumnTests`).
export { runSealedColumnTests } from "./SealedConformance.ts";
export type { SealedColumnConfig } from "./SealedConformance.ts";
export { runTenantIsolationTests } from "./TenantConformance.ts";
export type {
  KeyedProbe,
  MethodClass,
  Probe,
  TableCase,
  TenantIsolationConfig,
} from "./TenantConformance.ts";
