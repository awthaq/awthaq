// @awthaq/example-memory-server — the composition
//
// The app's layers, without starting anything: `index.ts` serves them on :3001 and
// `test/smoke.test.ts` boots the very same `AppLayer` in-process (TS-007), so the example
// cannot drift from what its smoke test proves — a `RequirePermission`-guarded endpoint
// that refuses a subject without the permission and admits one with it, and a
// `BeforeSignUp` allow-list tap that refuses a disallowed e-mail domain.

import { Organization, OrganizationHooks, OrganizationMemory } from "@awthaq/organization";
import { Password } from "@awthaq/password";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Auth, HookPoint, Hooks, Retention, SecuritySignals, Slots, Users } from "@awthaq/core";
import { AuthorizationAudit, SubjectExtractor } from "@awthaq/qadi";
import { Roles, RolesAdmin, RolesAdminApi } from "@awthaq/roles";
import { AuthHttp, Authentication, BodyLimit, Csrf, RequestContext } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import { EvaluationServicesNone, role } from "@qadi/core";
import { RequirePermissionLive } from "@qadi/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

// 1. Compose Password and Organization together — `Auth.make` folds both
//    plugins' own HttpApi contracts and Layers into one `api`/`layer`
//    pair, the same call the README's own quickstart makes with just
//    `[Password.Password]`. `dependsOn` is left unset on both: neither
//    requires the other to exist first.
//    `Roles` + `RolesAdmin` (YL-009) add global role administration guarded
//    by qadi's Path B: the in-repo dogfood for `RequirePermission` (YL-004).
//    `GET /roles/catalog` answers 403 without `roles:read`.
const built = Auth.make([
  Password.Password,
  Organization.Organization,
  Roles.Roles,
  RolesAdmin.RolesAdmin,
]);

// The role catalog the demo ships: a platform admin who may manage roles.
// Bootstrap the first admin by assigning `platform:admin` to a user id
// (`Roles.assign` is the trusted primitive; the HTTP surface needs the role).
const platformAdmin = role({
  name: "platform:admin",
  permissions: [RolesAdminApi.rolesManage],
});

// Path B: `RequirePermission` resolves the subject itself through the Roles
// resolver, evaluating with qadi's fail-closed default ports. `SubjectResolver` is a slot
// (a `Context.Reference` with a fail-closed default) that `Roles.layer` overrides, so the
// guard must be *built with `Roles.layer` beneath it*: a guard built beside it would read the
// default and refuse everyone (TS-007's smoke test is what caught this). `Roles.layer` is the
// very reference `Auth.make` installs, so the layer graph builds it once and the guard, the
// `Roles` service handlers use and the plugin all share one instance.
const GuardLive = RequirePermissionLive.pipe(
  Layer.provide(EvaluationServicesNone),
  Layer.provide(SubjectExtractor.SubjectExtractorLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provide(Roles.Roles.layer),
);

// 2. `Authentication` is `@awthaq/test`'s own required second parameter
//    (see `TestAuth.layer`'s own doc comment) — every plugin below that
//    guards an endpoint with `Api.Authentication` needs it. `TestAuth`'s
//    own bundled memory ports (`Users`/`Accounts`/`Sessions`/`Mailer`/a
//    permissive rate limiter) are deliberately lean — real, but not the
//    whole set either plugin's own `make` resolves — so Organization's
//    record services and Password's own `Verification`/`PasswordHasher`/
//    `AuthEvents`/`HttpClient` (the breach-check transport, unused since
//    `breachCheck` defaults `false`, but still a required service) are
//    supplied here, in the same position, for the identical reason.
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
// CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: every mutating group
// `Password`/`Organization` compose now carries `Api.CsrfProtection`
// (see each plugin's own `*Api.ts`), so this composition must supply its
// implementation the same way it supplies `Authentication`'s. The secret
// below is a fixed, checked-in placeholder fit only for this local demo —
// `CsrfConfig`'s own doc comment is explicit that a real deployment must
// never default it.
export const demoCsrfSecret = "memory-server-example-dev-only-csrf-secret";
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(demoCsrfSecret),
      allowedOrigins: [],
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);
const OrganizationStores = Layer.mergeAll(
  OrganizationMemory.layer,
  // Every lifecycle-hook point's own default (no-tap) layer — required
  // once per composition, per `OrganizationHooksLive`'s own doc comment.
  OrganizationHooks.OrganizationHooksLive,
);
// The one thing `Password` needs that `TestAuth`'s bundle deliberately leaves to the caller:
// the HTTP transport for the breach-check lookup (on by default: a sign-up asks the
// pwnedpasswords range API whether the password is known). `Verification`, the
// `PasswordHasher`, `AuthEvents` and `AuditLog` all come from the bundle (ETVS-004) — `Roles`
// below is built over that same `AuthEvents`/`AuditLog`, so its audit events land next to
// everyone else's. A test passes its own client so it never touches the network.

// The catalog `Roles` reads when it is built (a `Context.Reference`, so it must be in the
// context of whatever builds `Roles.layer` first: the services below are all built under it).
const RolesConfigLive = Roles.config([platformAdmin]);

// The hook seam a host uses for policy the library does not own (TS-007): a `BeforeSignUp` veto
// tap that refuses any e-mail outside an allow-list, so a private deployment stays private. A
// veto surfaces as the typed `HookAborted` (403) naming the point. `TestAuth.layer` builds the
// point in its own bundle and provides it to `services`, so the tap registers in the same
// per-composition registry the sign-up flow consults (ADR-EA-033).
const allowedEmailDomains: ReadonlyArray<string> = ["example.com"];

const SignUpAllowList = Hooks.BeforeSignUp.tap((input) =>
  allowedEmailDomains.includes(input.email?.split("@").at(-1)?.toLowerCase() ?? "")
    ? Effect.succeed(input)
    : Effect.fail(new HookPoint.HookAbort({ code: "EMAIL_DOMAIN_NOT_ALLOWED" })),
);

// 3. `TestAuth.layer` is the whole pipeline over memory — the same
//    machinery `packages/*/test/AuthHttp.test.ts` files and this repo's
//    own BDD suite already exercise for real, just not previously
//    packaged as something runnable on its own.
const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  TestAuth.layer(
    built,
    Layer.mergeAll(
      // `TestAuth`'s bundled limiter is the permissive test one; this example serves real
      // HTTP, so it swaps in the real single-process limiter (RBS-007) through the same param.
      // CSD-010: enforcing, so the sign-in budget (5 per account per 15 minutes) answers 429.
      // It is one `Ref` per process: a deployment with several instances swaps in a shared
      // store (`RateLimiter.layer` over `RateLimiterStoreSql.layerStoreSql`).
      RateLimiter.layerMemory,
      // DESS-002: a development mailer that prints every message, including the
      // verification token, to the log, so a sign-up can be finished without an inbox. Never
      // for production: a real deployment provides its own `Mailer` here.
      Mailer.layerConsole,
      AuthenticationLive,
      CsrfProtectionLive,
      OrganizationStores,
      httpClient,
      GuardLive,
      SignUpAllowList,
    ).pipe(Layer.provideMerge(RolesConfigLive)),
  );

const AppLayer = makeAppLayer(FetchHttpClient.layer);

// Composition-time counterpart of `RequirePermission`'s per-request refusal
// (BEH-EA-156): refuse to start if an endpoint in a guarded group declares
// neither a permission requirement nor `publicEndpoint(...)`.
const audited = AuthorizationAudit.auditAuthorizationAnnotations(built.api);

/**
 * What a caller (the smoke test) gets from a booted `AppLayer`: the web handler, and a way to
 * run an effect against the very same built services it serves from. Declared as an interface
 * because `AppLayer`'s own type is far too large to be a useful public signature.
 */
export interface RunningApp {
  readonly handler: (request: Request) => Promise<Response>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, Users.Users | Roles.Roles>) => Promise<A>;
}

/**
 * Boots the app in-process (no socket) for tests; `httpClient` is the breach-check transport
 * (default: the real one), and `logger` replaces the default loggers (a test uses it to read
 * the mail the console mailer prints).
 */
export const buildApp = (
  httpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
  logger: Layer.Layer<never> = Layer.empty,
): RunningApp => {
  const layer = makeAppLayer(httpClient).pipe(Layer.provideMerge(logger));
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  const run: RunningApp["run"] = (effect) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );
  return { handler, run };
};

// 4. A real listening server — the same `HttpRouter.serve` +
//    `NodeHttpServer.layer` pair the README's own quickstart uses, not an
//    in-process test client.
//    `BodyLimit.layer` bounds every request body (256 KiB by default, 413
//    beyond it) — without it Effect's server reads bodies with no cap.
//    EOTS-006 (wayfinder ticket 27): `HttpRouter.serve` already logs one structured line per
//    request (`http.method`/`http.url`/`http.status`; a host running its own request logger
//    passes `disableLogger`, and `AuthHttp.tracer`/`AuthHttp.requestLogger` are the same
//    middlewares for a `toWebHandler` host). `RequestContext.layer` stamps a correlation id,
//    the client address and the user agent on every audit row a request causes, and
//    `AuthHttp.layerRedactedHeaders` keeps the session cookie and rotated token out of any
//    header a logger or tracer prints.
//    CSG-003: `Retention.layerScheduled` is the opt-in retention sweep (expired sessions,
//    old verification rows; the audit trail is kept for ever unless `Retention.config`
//    sets a window). It shares the app's own stores, so it lives in the same layer graph.
//    CSG-008: `SecuritySignals.layer` turns the published breach signals into incidents (log line,
//    metric, and an `IncidentSink` if one is provided).
const serverLayer = (port: number) =>
  HttpRouter.serve(
    Layer.mergeAll(
      BodyLimit.layer,
      RequestContext.layer,
      Retention.layerScheduled,
      SecuritySignals.layer,
    ).pipe(Layer.provideMerge(AppLayer)),
  ).pipe(
    Layer.provide(AuthHttp.layerRedactedHeaders),
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
  );

// Structured JSON logs in production, pretty logs otherwise; a logging *backend* is the
// host's choice, never the library's (ticket 27 §4).
const LoggingLive = Logger.layer([
  process.env["NODE_ENV"] === "production" ? Logger.consoleJson : Logger.consolePretty(),
]);

/**
 * Keeps `SlotConflict` (a build-time failure `main` can end with) nameable for declaration emit.
 *
 * @public
 */
export type StartupConflict = Slots.SlotConflict;

/** The whole app: audit the guarded groups, then serve on `port` until interrupted. */
export const main = (port: number) =>
  audited.pipe(
    Effect.andThen(
      Layer.launch(
        Layer.merge(
          serverLayer(port),
          Layer.effectDiscard(
            Effect.logInfo(
              `awthaq example (memory-backed, Password + Organization) listening on :${port}`,
            ),
          ),
        ),
      ),
    ),
    Effect.provide(LoggingLive),
  );
