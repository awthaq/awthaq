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
  Accounts,
  AuditChain,
  AuditLog,
  Auth,
  AuthEvents,
  AuthPlugin,
  DataExport,
  Erasure,
  HookPoint,
  Hooks,
  Migrations,
  Persistence,
  RateLimits,
  type Retention,
  Sessions,
  Slots,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ClientAddress,
  type Encryption,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { AuthHttp, Authentication, Csrf } from "@awthaq/server";
import { CoreMigrations } from "@awthaq/sql";
import * as RedactionGuard from "./RedactionGuard.ts";
import * as TestEncryption from "./TestEncryption.ts";
import * as TestSql from "./TestSql.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { createHmac, randomBytes } from "node:crypto";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

/**
 * ELC-004: what every memory layer (`Users`/`Accounts`/`Sessions`/`Verification`, each plugin's
 * record stores) needs beneath it, as one layer: the platform `Crypto` (ids and secrets),
 * `AuthEvents` over an in-memory `AuditLog`, and every hook point's default (no-tap) layer.
 * `Users.layer.pipe(Layer.provideMerge(TestAuth.memoryFoundation))` replaces the four
 * `Layer.provideMerge(NodeCrypto.layer | AuthEvents.layer | AuditLog.layer |
 * Hooks.HooksLive)` lines each suite used to repeat. The services stay in the output, so a test
 * can `yield*` the very instances the stores were built over. Raw layers stay available for a
 * suite that injects its own `Crypto` or hook taps. It is the low-level seam for a store suite
 * that builds one store alone; a whole composition goes through `TestAuth.layer`.
 */
export const memoryFoundation = AuthEvents.layer.pipe(
  // BEH-EA-100: `AuthEvents.layer` needs `AuditLog` — see its own header comment.
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  // AOMS-006/BCR-004/CSG-002/THS-002 (wayfinder ticket 03): every hook point's own default
  // (no-tap) layer — `Users.layer` and every plugin's own `make` consult one directly. See
  // `Hooks.HooksLive`'s own doc comment.
  Layer.provideMerge(Hooks.HooksLive),
  // Plan 08: the hash chain `Admin`'s impersonation records link their rows with (unkeyed unless a test
  // provides `AuditChain.config`); it needs only `Crypto`, so it rides here, beside the other things stores read.
  Layer.provideMerge(AuditChain.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/** Plan 02's SQL stores over the ambient `SqlClient`, sealing provider tokens with the test `Encryption`. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

/** The same foundation over a SQL audit log (`sqlBase`): `AuthEvents` writes through the one `SqlClient`. */
const sqlFoundation = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(AuditChain.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * The ports and registries both bases carry. `rateLimiter` is `RateLimiter.layerPermissive` (BEH-EA-112,
 * a test that signs in fifty times in a loop should not fail for a reason unrelated to what it tests)
 * unless a suite asks for `"enforcing"`: the real limiter over the in-memory store, so lockout and
 * throttle behaviour is the production behaviour. `RateLimits.layer` (the per-plugin rule registry),
 * `Slots.layer` and the credential-resolver registry are not ports but every composition needs them.
 */
const testPorts = (rateLimiter: "permissive" | "enforcing" | undefined) =>
  Layer.mergeAll(
    TestHasher,
    Mailer.layerMemory,
    rateLimiter === "enforcing" ? RateLimiter.layerMemory : RateLimiter.layerPermissive,
    RateLimits.layer,
    // MA-005: `Auth.make` provides its own `SlotsRegistry`; this one is for a plugin layer a
    // test composes standalone (outside `Auth.make`), whose `Slots.override` requires one.
    Slots.layer,
    // AGA-001/NHS-003: the raw-`remoteAddress` passthrough every zero-config app gets by default.
    ClientAddress.layerDirect,
    // ADR-EA-012: the one registry plugins contribute credential resolvers to and `Authentication` reads.
    Authentication.CredentialResolversLive,
    TestEncryption.layer,
  );

/** `Users`, `Accounts`, `Sessions` and `Verification`, written once over whichever stores sit beneath them. */
const coreServices = Layer.mergeAll(
  Users.layer,
  Accounts.layer,
  Sessions.layer,
  // ETVS-004/MW-002: what every password-style composition needs beyond the core stores
  // (also `AuthHttp.coreHandlers`' always-served `account` group).
  Verification.layer,
);

/**
 * BEH-EA-193: the whole base over memory: plan 02's `Persistence.memory` bundle (the five stores and the
 * no-op transaction), the core services over it, the test ports, and CSG-001's `AccountErasure` /
 * `AccountExport` built over those same stores and over the registries `Hooks.HooksLive` provides (the ones
 * every plugin's erasure contribution registers into), so a plugin installed in a composition is erased like
 * any other.
 */
const memoryBase = (rateLimiter: "permissive" | "enforcing" | undefined) =>
  Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(coreServices, testPorts(rateLimiter), SqlTransaction.layerNoop).pipe(
        Layer.provide(Persistence.memory),
      ),
    ),
    // RRS-003: `Sessions.layer` also needs `AuthEvents`.
    Layer.provideMerge(memoryFoundation),
  );

/**
 * BEH-EA-T2: the same services over a database migrated with core's migrations and then the composition's
 * (`built.migrations`): SQLite `:memory:` by default, a per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`
 * (`TestSql.layer(suite)`). The migrations run before anything is built over the client, because everything
 * is provided through the one `Ready` layer.
 */
const sqlBase = (
  rateLimiter: "permissive" | "enforcing" | undefined,
  migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"],
  suite: string,
) => {
  const Ready = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Migrator.make({})({
        loader: CoreMigrations.coreMigrations,
        table: "effect_sql_migrations",
      });
      yield* Migrations.run(migrations);
    }),
  ).pipe(Layer.provideMerge(TestSql.layer(suite)));
  return Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(coreServices, testPorts(rateLimiter), SqlTransaction.layerSql).pipe(
        Layer.provide(SqlStores),
      ),
    ),
    Layer.provideMerge(sqlFoundation),
    Layer.provideMerge(Ready),
  );
};

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
export interface CommonOptions<S, SE, SR, D, DR> {
  /**
   * What is genuinely the test's own: plugin configuration (`Plugin.config(...)`), adapters (`XmlSignature`,
   * `WebAuthn`, `HttpClient`, a fake fetcher, a transport), and doubles. It is **merged into the output**, so
   * a test that `yield*`s a service only this provides gets the very instance the plugins used (a capturing
   * `Mailer` given here is the one the plugin sends through and the one the test reads). It sits closest to
   * the plugins, so it may override a derived middleware or a base service *for the plugins*; a base service
   * captured by a core store (a custom `Crypto`) is not seen by it: use `decorate` or `memoryFoundation` for
   * that. Never put a core store, a plugin record layer or host middleware here: the harness provides them.
   */
  readonly services?: Layer.Layer<S, SE, SR>;
  /**
   * Wraps base services in place (a `Users` that fails, a `Sessions` spy): built over the base, it shadows
   * the base service for the plugins and for the test alike.
   */
  readonly decorate?: Layer.Layer<D, never, DR>;
  /** Application taps. They receive the same point instances the plugins run (core's and the declared `hookPoints`). */
  readonly taps?: Layer.Layer<never, never, unknown>;
  /** Overrides fields of `TestCsrfConfig`. */
  readonly csrf?: Partial<Csrf.CsrfConfigShape>;
  /** Defaults to `Authentication.PrincipalResolverLive`; `PrincipalResolverWithUserFactsLive` opts into `emailVerified`. */
  readonly principalResolver?: Layer.Layer<
    Authentication.PrincipalResolver,
    never,
    Users.Users | Sessions.Sessions
  >;
  /** `"permissive"` (default) never refuses; `"enforcing"` is the real limiter over the in-memory store. */
  readonly rateLimiter?: "permissive" | "enforcing";
  /** P20a (BEH-EA-084): serve the generated OpenAPI document at this path. */
  readonly openapiPath?: `/${string}`;
  /** P20a (BEH-EA-084): serve the Scalar docs page at this path. */
  readonly docsPath?: `/${string}`;
}

/** BEH-EA-T2: `records: "sql"` needs a `suite` (one distinct name per test file; it names the Postgres schema). */
export type SqlMode = { readonly records: "sql"; readonly suite: string };
export type MemoryMode = { readonly records?: "memory" };

/** Named so the bases' inferred types can be emitted (TS2883 needs the `Encryption` namespace in scope). */
export type BaseEncryption = Encryption.Encryption;
type MemoryBaseOut = Layer.Success<ReturnType<typeof memoryBase>>;
type SqlBaseOut = Layer.Success<ReturnType<typeof sqlBase>>;
type BaseOut<M extends "memory" | "sql"> = M extends "memory" ? MemoryBaseOut : SqlBaseOut;

/** Everything a composition provides beneath its plugins, besides the middleware it derives. */
type Provided<P extends ReadonlyArray<AuthPlugin.Any>, M extends "memory" | "sql", S, D> =
  | BaseOut<M>
  | Layer.Success<typeof GuardLive>
  | Layer.Success<typeof HttpServer.layerServices>
  | Layer.Success<typeof HttpRouter.layer>
  | Csrf.CsrfConfig
  | AuthPlugin.RecordsOut<P[number]>
  | AuthPlugin.HookPointsOut<P[number]>
  | S
  | D;

/**
 * The one implementation behind every `layer` overload, over the widest shapes. Contract tests use it directly
 * (`runPluginContractTests`' `build` check), where the plugin tuple is only known as `AuthPlugin.Any`.
 */
const makeLayer = <P extends ReadonlyArray<AuthPlugin.Any>, Extra extends HttpApiGroup.Constraint>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<never, unknown, unknown, never, unknown> & (MemoryMode | SqlMode) = {},
): Layer.Layer<never, unknown, unknown> => {
  const sqlSuite = options.records === "sql" && "suite" in options ? options.suite : undefined;
  const select = (plugin: AuthPlugin.Any) =>
    sqlSuite === undefined ? plugin.records?.memory : plugin.records?.sql;
  const records = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>((acc, plugin) => {
    const bundle = select(plugin);
    return bundle === undefined ? acc : Layer.merge(acc, bundle);
  }, Layer.empty);
  const points = built.plugins.reduce<Layer.Layer<never, unknown, unknown>>(
    (acc, plugin) => (plugin.hookPoints === undefined ? acc : Layer.merge(acc, plugin.hookPoints)),
    Layer.empty,
  );
  // The one `CsrfConfig` layer: the derived `CsrfProtection` reads it, and it is also merged into the
  // output so `TestAuth.app` can mint a token against the very secret the composition checks.
  const csrf = Layer.succeed(Csrf.CsrfConfig, { ...TestCsrfConfig, ...options.csrf });
  const middleware = AuthHttp.middlewareFor(built.api, {
    csrf,
    ...(options.principalResolver === undefined
      ? {}
      : { principalResolver: options.principalResolver }),
  });
  const base =
    sqlSuite === undefined
      ? memoryBase(options.rateLimiter)
      : sqlBase(options.rateLimiter, built.migrations, sqlSuite);
  // MW-002: `built.api` always carries core's session/account groups, so their handlers are part of every
  // test pipeline. BEH-EA-084: the docs page (when asked for) is mounted on the same router, over the same api.
  const docs =
    options.docsPath === undefined
      ? Layer.empty
      : AuthHttp.docs(built.api, { path: options.docsPath });
  return Layer.merge(AuthHttp.routes(built.api, { openapiPath: options.openapiPath }), docs).pipe(
    Layer.provide(AuthHttp.coreHandlers),
    // The plugins' own services stay in the output (`provideMerge`), so a test can
    // `yield* Password.Password` from the same composition it serves over HTTP.
    Layer.provideMerge(built.layer),
    // `services` sit closest to the plugins, so they override the derived middleware and the base for the
    // plugins, and are *merged*, so the output holds the very instances the plugins used.
    Layer.provideMerge(options.services ?? Layer.empty),
    Layer.provide(middleware),
    Layer.provideMerge(csrf),
    Layer.provideMerge((options.taps ?? Layer.empty).pipe(Layer.provideMerge(points))),
    Layer.provideMerge(records),
    Layer.provideMerge(options.decorate ?? Layer.empty),
    // EOTS-002: the recording tracer/logger (and the `AuthEvents` inspector) are part of every
    // `TestAuth` composition; they only record, `assertNoLeaks` is what fails.
    Layer.provideMerge(GuardLive),
    Layer.provideMerge(base),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
    // SAM-004: the composition's declared user fields, last so `Users` and the account handler both see it.
    Layer.provideMerge(built.userFieldsLayer),
  );
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
 * What it builds, so a test does not:
 * - the host middleware the composed groups declare (`AuthHttp.middlewareFor`): `Authentication`,
 *   `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection` over
 *   `TestCsrfConfig` (BEH-EA-T1);
 * - every composed plugin's `records` bundle for the chosen mode and its declared `hookPoints` (BEH-EA-T4/T5);
 * - the core services over `Persistence.memory` / `Persistence.sql()`, the test ports (a cheap argon2id hasher,
 *   `Mailer.layerMemory`, a permissive `RateLimiter`, `Encryption` over a fixed key, `ClientAddress`), the
 *   erasure and export services, and the recording `RedactionGuard` (EOTS-002).
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
>(
  built: Auth.Built<P, Extra>,
  options?: CommonOptions<S, SE, SR, D, DR> & MemoryMode,
): Layer.Layer<
  Provided<P, "memory", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  SE,
  Exclude<
    | Layer.Services<Auth.Built<P, Extra>["layer"]>
    | Layer.Services<typeof AuthHttp.coreHandlers>
    | AuthPlugin.RecordsIn<P[number], "memory">
    | SR
    | DR,
    Provided<P, "memory", S, D> | AuthHttp.DeclaredMiddleware<Auth.AllGroups<P, Extra>>
  >
>;
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  S = never,
  SE = never,
  SR = never,
  D = never,
  DR = never,
>(
  built: Auth.Built<P, Extra>,
  options: CommonOptions<S, SE, SR, D, DR> & SqlMode,
): Layer.Layer<
  Provided<P, "sql", S, D> | Layer.Success<Auth.Built<P, Extra>["layer"]>,
  SE,
  Exclude<
    | Layer.Services<Auth.Built<P, Extra>["layer"]>
    | Layer.Services<typeof AuthHttp.coreHandlers>
    | AuthPlugin.RecordsIn<P[number], "sql">
    | SR
    | DR,
    Provided<P, "sql", S, D> | AuthHttp.DeclaredMiddleware<Auth.AllGroups<P, Extra>>
  >
>;
export function layer(
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  options: CommonOptions<never, unknown, unknown, never, unknown> & (MemoryMode | SqlMode) = {},
): Layer.Layer<never, unknown, unknown> {
  return makeLayer(built, options);
}

export interface SignedInSession {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
  /** Ready to drop straight into `new Request(url, { headers: { cookie } })`. */
  readonly cookieHeader: string;
}

/**
 * BEH-EA-197: mints a real user and a real session directly against
 * `Users`/`Sessions` — no password, no HTTP round trip — so an
 * authorization test's setup cost is independent of whichever credential
 * plugin (if any) is installed, matching this behavior's own point: testing
 * *authorization*, not sign-up.
 */
export const signInAs = (input: {
  readonly email: string;
  readonly name?: string;
  readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
  /** How the session says the user authenticated (`["pwd"]`, `["fed"]`, ...); none by default. */
  readonly amr?: ReadonlyArray<Sessions.AuthMethod>;
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
    const { token } = yield* sessions
      .issue({ userId: user.id, ...(input.amr === undefined ? {} : { amr: input.amr }) })
      .pipe(Effect.orDie);
    return {
      userId: user.id,
      token,
      cookieHeader: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
    };
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

/** What a request through `TestAuth.app` may carry. */
export interface RequestInit {
  /** An existing `cookie` header value (a session cookie); the CSRF cookie is appended. */
  readonly cookie?: string;
  /** A JSON body (sets `content-type: application/json`). */
  readonly json?: unknown;
  /** A form body (sets `content-type: application/x-www-form-urlencoded`). */
  readonly form?: Readonly<Record<string, string>>;
  /** Extra headers; they win over the ones `request` sets. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * BEH-EA-T3: the composition served and read through one memo map, so the handler and the test's own
 * context share every instance (a session minted through `run` authenticates a request through `handler`).
 */
export interface App<A> {
  /** The raw `(Request) => Promise<Response>` the composition serves. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Runs an effect against the composition's own context (the instances the plugins use). */
  readonly run: <X, XE, XR extends A>(effect: Effect.Effect<X, XE, XR>) => Promise<X>;
  /**
   * A request with the CSRF double-submit pair a browser client would send, minted from the composition's
   * own `CsrfConfig` (read once through `run`).
   */
  readonly request: (method: string, path: string, init?: RequestInit) => Promise<Response>;
  /** Mints a user and a session straight against `Users`/`Sessions` (see `signInAs`). */
  readonly signIn: (
    email: string,
    options?: {
      readonly name?: string;
      readonly amr?: ReadonlyArray<Sessions.AuthMethod>;
      readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
    },
  ) => Promise<SignedInSession>;
  /** Releases everything the composition built. */
  readonly dispose: () => Promise<void>;
}

/** What `app` itself reads from the composition: the CSRF config, and the stores `signIn` writes through. */
export type AppNeeds = Csrf.CsrfConfig | Users.Users | Sessions.Sessions;

/**
 * BEH-EA-T3: serves `appLayer` (normally `TestAuth.layer(Auth.make([...]), ...)`) and returns the handle a
 * wire-level suite uses. It replaces the hand-rolled `Layer.makeMemoMapUnsafe` + `HttpRouter.toWebHandler`
 * + `buildWithMemoMap` blocks and the per-suite CSRF token mint.
 */
export const app = <A, E>(
  appLayer: Layer.Layer<A | AppNeeds, E>,
  options: {
    /** The origin `request` addresses (default `http://localhost`): a plugin that derives a URL from the request's host sees it. */
    readonly baseUrl?: string;
  } = {},
): App<A | AppNeeds> => {
  const baseUrl = options.baseUrl ?? "http://localhost";
  const memoMap = Layer.makeMemoMapUnsafe();
  const scope = Scope.makeUnsafe();
  const web = HttpRouter.toWebHandler(appLayer, { memoMap, disableLogger: true });
  let context: Promise<Context.Context<A | AppNeeds>> | undefined;
  const built = () => {
    context ??= Effect.runPromise(Layer.buildWithMemoMap(appLayer, memoMap, scope));
    return context;
  };
  const run: App<A | AppNeeds>["run"] = (effect) =>
    built().then((services) => Effect.runPromiseWith(services)(effect));
  let token: Promise<string> | undefined;
  const csrf = () => {
    token ??= run(
      Effect.map(Effect.service(Csrf.CsrfConfig), (config) => csrfToken(config.secret)),
    );
    return token;
  };
  return {
    handler: (request) => web.handler(request),
    run,
    request: async (method, path, init = {}) => {
      const minted = await csrf();
      const headers = new Headers({
        cookie: [init.cookie, `${Api.CSRF_COOKIE_NAME}=${minted}`]
          .filter((part) => part !== undefined && part !== "")
          .join("; "),
        [Api.CSRF_HEADER_NAME]: minted,
      });
      let body: string | undefined;
      if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
      } else if (init.form !== undefined) {
        headers.set("content-type", "application/x-www-form-urlencoded");
        body = new URLSearchParams(init.form).toString();
      }
      for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
      return web.handler(
        new Request(`${baseUrl}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
    },
    signIn: (email, options = {}) => run(signInAs({ email, ...options })),
    dispose: async () => {
      await web.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

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
}

export type { TestFramework } from "./TestFramework.ts";

/**
 * SSMS-004: one fresh in-memory SQLite database, core migrations first, then `migrations`
 * on the plugin ledger — applied a second time to prove the migrator skips what it has
 * already applied — resolving to the resulting schema (every table/index and its SQL, minus
 * the two ledgers) so two independent applications can be compared.
 */
const applyMigrations = (migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readSchema = sql<{
      readonly type: string;
      readonly name: string;
      readonly tbl_name: string;
      readonly sql: string;
    }>`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('effect_sql_migrations', ${Migrations.pluginMigrationsTable})
      ORDER BY name`;
    yield* Migrator.make({})({
      loader: CoreMigrations.coreMigrations,
      table: "effect_sql_migrations",
    });
    // PV-252/INV-EA-016: what core alone created, before any plugin migration runs.
    const coreSchema = yield* readSchema;
    yield* Migrations.run(migrations);
    const reapplied = yield* Migrations.run(migrations);
    const schema = yield* readSchema;
    return { schema, coreSchema, reapplied: reapplied.length };
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

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
export const runPluginContractTests = <O, R = never>(
  framework: TestFramework,
  makePlugin: (options: O) => AuthPlugin.Any,
  config: ContractTestOptions<O, R>,
): void => {
  framework.describe("runPluginContractTests", () => {
    let previousContract: AuthPlugin.Any["contract"] | undefined;

    for (const options of config.options) {
      const plugin = makePlugin(options);
      const host = config.host ?? dependencyClosure(plugin);
      const hostIds = new Set(host.map((installed) => installed.id));
      const label = JSON.stringify(options);

      framework.it(`${label}: id does not collide with a host plugin`, () => {
        if (hostIds.has(plugin.id)) {
          framework.fail(`E_PLUGIN_DUPLICATE_ID: "${plugin.id}" also names a host plugin`);
        }
      });

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
        if (JSON.stringify(a.schema) !== JSON.stringify(b.schema)) {
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
