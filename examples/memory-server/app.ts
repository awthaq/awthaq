// @awthaq/example-memory-server — the composition
//
// The app's layers, without starting anything: `index.ts` serves them on :3001 and
// `test/smoke.test.ts` boots the very same `AppLayer` in-process (TS-007), so the example
// cannot drift from what its smoke test proves — a `RequirePermission`-guarded endpoint
// that refuses a subject without the permission and admits one with it, and a
// `BeforeSignUp` allow-list tap that refuses a disallowed e-mail domain.

import {
  Organization,
  type OrganizationActiveContext,
  type OrganizationAuthority,
  type OrganizationDeletion,
  type OrganizationDirectory,
  type OrganizationInvitations,
  type OrganizationMembers,
  type OrganizationRoles,
  type OrganizationTeams,
} from "@awthaq/organization";
import { Password, type PasswordCredential } from "@awthaq/password";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  Mailer,
  PasswordHasher,
  RateLimiter,
} from "@awthaq/ports";
import { Auth, HookPoint, Hooks, Retention, SecuritySignals, type Slots } from "@awthaq/core";
import { AuthorizationAudit, SubjectExtractor } from "@awthaq/qadi";
import { Roles, RolesAdmin, RolesAdminApi } from "@awthaq/roles";
import { AuthHost, AuthHttp, Credentials, Csrf } from "@awthaq/server";
import { EvaluationServicesNone, role } from "@qadi/core";
import { RequirePermissionLive } from "@qadi/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

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
  Layer.provide(Credentials.PrincipalResolverLive),
  Layer.provide(Roles.Roles.layer),
);

// 2. The CSRF configuration is this app's own. The secret below is a fixed, checked-in placeholder fit only for this
//    local demo: `CsrfConfig`'s own doc comment is explicit that a real deployment must never default it (it reads
//    `Csrf.layerConfig` from the environment).
const demoCsrfSecret = "memory-server-example-dev-only-csrf-secret";
const DemoCsrfConfig = Layer.succeed(Csrf.CsrfConfig, {
  secret: Redacted.make(demoCsrfSecret),
  allowedOrigins: [],
});

// The ports: what only this application can choose (ADR-EA-010). `AuthHost` leaves each of them in the layer's
// requirements until it is provided here, so a missing one is a compile error.
const Ports = Layer.mergeAll(
  // The production-cost hasher: `Password` reads it from the environment's `AUTH_ARGON2_*` knobs.
  PasswordHasher.layerArgon2id,
  // DESS-002: a development mailer that prints every message, including the verification token, to the
  // log, so a sign-up can be finished without an inbox. Never for production: a real deployment provides
  // its own `Mailer` here.
  Mailer.layerConsole,
  // CSD-010: the real single-process limiter (RBS-007), so the sign-in budget (5 per account per 15
  // minutes) answers 429. One `Ref` per process: a deployment with several instances swaps in a shared store
  // (`RateLimiter.layer` over `RateLimiterStoreSql.layerStoreSql`).
  RateLimiter.layerMemory,
  ClientAddress.layerDirect,
  // A throwaway key generated at boot: nothing encrypted under it survives a restart, which is exactly
  // what an in-memory server is (`KeyProvider.layerEnv` is the production path).
  Encryption.layer.pipe(Layer.provide(KeyProvider.layerEphemeral)),
).pipe(Layer.provideMerge(NodeCrypto.layer));

// The catalog `Roles` reads when it is built (a `Context.Reference`, so it must be in the
// context of whatever builds `Roles.layer` first: the services below are all built under it).
const RolesConfigLive = Roles.config([platformAdmin]);

// The hook seam a host uses for policy the library does not own (TS-007): a `BeforeSignUp` veto
// tap that refuses any e-mail outside an allow-list, so a private deployment stays private. A
// veto surfaces as the typed `HookAborted` (403) naming the point. `AuthHost` builds the taps over the
// composition's own point instances, so it registers where the sign-up flow consults (ADR-EA-033).
const allowedEmailDomains: ReadonlyArray<string> = ["example.com"];

const SignUpAllowList = Hooks.BeforeSignUp.tap((input) =>
  allowedEmailDomains.includes(input.email?.split("@").at(-1)?.toLowerCase() ?? "")
    ? Effect.succeed(input)
    : Effect.fail(new HookPoint.HookAbort({ code: "EMAIL_DOMAIN_NOT_ALLOWED" })),
);

// 3. The servable layer over memory (ADR-EA-044): `AuthHost` derives the routes, core's handlers, each plugin's
//    `records.memory` and hook points, the core services and registries, the middleware the groups declare, the
//    user fields, `RequestContext` and `BodyLimit`. What is left is this app's: the breach-check transport, the
//    guard (built over `Roles.layer`), the sign-up tap, its ports and the HTTP platform.
export const makeAppLayer = (httpClient: Layer.Layer<HttpClient.HttpClient>) =>
  AuthHost.layer(built, {
    persistence: { records: "memory" },
    csrf: DemoCsrfConfig,
    services: Layer.mergeAll(httpClient, GuardLive).pipe(Layer.provideMerge(RolesConfigLive)),
    taps: SignUpAllowList,
  }).pipe(
    Layer.provide(Ports),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = makeAppLayer(FetchHttpClient.layer);

// Composition-time counterpart of `RequirePermission`'s per-request refusal
// (BEH-EA-156): refuse to start if an endpoint in a guarded group declares
// neither a permission requirement nor `publicEndpoint(...)`.
const audited = AuthorizationAudit.auditAuthorizationAnnotations(built.api);

// 4. A real listening server (`HttpRouter.serve` + `NodeHttpServer.layer`, as the README quickstart). `AuthHost`
//    already installs `BodyLimit.layer` and derives the request context; `HttpRouter.serve` logs one structured line per
//    request (EOTS-006) and `AuthHttp.layerRedactedHeaders` keeps the session cookie and rotated token out of it.
//    Host jobs stay beside the layer and share its stores: `Retention.layerScheduled` is the opt-in retention sweep
//    (CSG-003), `SecuritySignals.layer` turns breach signals into incidents (CSG-008).
const serverLayer = (port: number) =>
  HttpRouter.serve(
    Layer.mergeAll(Retention.layerScheduled, SecuritySignals.layer).pipe(
      Layer.provideMerge(AppLayer),
    ),
  ).pipe(
    Layer.provide(AuthHttp.layerRedactedHeaders),
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
  );

// Structured JSON logs in production, pretty logs otherwise; a logging *backend* is the
// host's choice, never the library's (ticket 27 §4).
const LoggingLive = Logger.layer([
  process.env["NODE_ENV"] === "production" ? Logger.consoleJson : Logger.consolePretty(),
]);

/** Keeps `SlotConflict` (a build-time failure `main` can end with) nameable for declaration emit. @public */
export type StartupConflict = Slots.SlotConflict;

/** Keeps Password's exposed credential module (in `makeAppLayer`'s output) nameable for declaration emit. @public */
export type PasswordServices = PasswordCredential.PasswordCredential;

/** Keeps Organization's exposed services (in `makeAppLayer`'s output) nameable for declaration emit. @public */
export type OrganizationServices =
  | OrganizationActiveContext.OrganizationActiveContext
  | OrganizationAuthority.OrganizationAuthority
  | OrganizationDeletion.OrganizationDeletion
  | OrganizationDirectory.OrganizationDirectory
  | OrganizationInvitations.OrganizationInvitations
  | OrganizationMembers.OrganizationMembers
  | OrganizationRoles.OrganizationRoles
  | OrganizationTeams.OrganizationTeams;

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
