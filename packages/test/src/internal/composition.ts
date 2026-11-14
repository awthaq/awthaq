// @awthaq/test — the TestAuth composition: test ports, the redaction guard and AuthHost.layer behind every layer overload (spec/behaviors/25-testing-harness.md, BEH-EA-193, BEH-EA-342).
import { Auth, AuthEvents, type AuthPlugin, Sessions, Users } from "@awthaq/core";
import {
  ClientAddress,
  type Encryption,
  type Mailer,
  PasswordHasher,
  RateLimiter,
  type SmsSender,
} from "@awthaq/ports";
import { AuthHost, Credentials, Csrf } from "@awthaq/server";
import * as RedactionGuard from "../RedactionGuard.ts";
import * as TestEncryption from "../TestEncryption.ts";
import * as TestMailbox from "../TestMailbox.ts";
import * as TestSql from "../TestSql.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";

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

/**
 * The test ports: a cheap real hasher, the recording `TestMailbox.layer` (`Mailer` and `SmsSender`), a permissive (or the real) limiter, the socket peer, a fixed
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
    TestMailbox.layer,
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

const GuardLive = RedactionGuard.layerEvents.pipe(Layer.provideMerge(RedactionGuard.layer));

/**
 * The default CSRF configuration of every `TestAuth` composition: a fixed secret (at least 32 bytes), no
 * allowed origins. `options.csrf` overrides fields of it. `TestAuth.serve(...).request` reads the composition's
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
   * `Mailer` given here shadows the mailbox for the plugins). It sits closest to
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
  // Named here so the inferred type of `testPorts` stays portable (TS2883).
  | Mailer.Mailer
  | SmsSender.SmsSender
  | Encryption.Encryption
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
export const makeLayer = <
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
>(
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
 * `TestMailbox.layer` (a recording `Mailer` and `SmsSender`, read through `TestMailbox.Mailbox`), a permissive `RateLimiter`, `Encryption` over a fixed key, `ClientAddress`, the platform
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
