// @awthaq/example-memory-server
//
// Upstream-hardening map, ticket 09: a multi-plugin composition the
// README's own quickstart doesn't cover (Password + Organization,
// together), running through `@awthaq/test`'s real, production-quality
// memory backend instead of Postgres — no `DATABASE_URL`, no migration
// run, no `AWTHAQ_ENCRYPTION_KEY`. Additional to, not a replacement for,
// the README's own single-plugin Postgres quickstart (that one stays
// exactly as `shipping-gaps` ticket 29 shipped it).
//
// TRBS-005: this composition is single-process by construction — every
// memory layer here is a per-process `Ref`, so a session revoked on one
// instance is not revoked on another and state is lost on restart. Use the
// `layerSql` variants for anything multi-instance.
//
// Run it:
//   node --experimental-strip-types index.ts
import {
  ActiveContextRecords,
  InvitationRecords,
  MembershipRecords,
  Organization,
  OrganizationHooks,
  OrgRoleRecords,
  OrganizationRecords,
  TeamRecords,
} from "@awthaq/organization";
import { Password } from "@awthaq/password";
import { Auth } from "@awthaq/core";
import { AuthorizationAudit, SubjectExtractor } from "@awthaq/qadi";
import { Roles, RolesAdmin, RolesAdminApi } from "@awthaq/roles";
import { AuthHttp, Authentication, BodyLimit, Csrf, RequestContext } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import { EvaluationServicesNone, role } from "@qadi/core";
import { RequirePermissionLive } from "@qadi/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
// resolver, evaluating with qadi's fail-closed default ports.
const GuardLive = RequirePermissionLive.pipe(
  Layer.provide(EvaluationServicesNone),
  Layer.provide(SubjectExtractor.SubjectExtractorLive),
  Layer.provide(Authentication.PrincipalResolverLive),
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
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("memory-server-example-dev-only-csrf-secret"),
      allowedOrigins: [],
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);
const OrganizationMemory = Layer.mergeAll(
  OrganizationRecords.layerMemory,
  MembershipRecords.layerMemory,
  ActiveContextRecords.layerMemory,
  InvitationRecords.layerMemory,
  OrgRoleRecords.layerMemory,
  TeamRecords.layerMemory,
  // Every lifecycle-hook point's own default (no-tap) layer — required
  // once per composition, per `OrganizationHooksLive`'s own doc comment.
  OrganizationHooks.OrganizationHooksLive,
);
// The one thing `Password` needs that `TestAuth`'s bundle deliberately leaves to the caller:
// the HTTP transport for the breach-check lookup. `Verification`, the `PasswordHasher`,
// `AuthEvents` and `AuditLog` all come from the bundle (ETVS-004) — `Roles` below is built
// over that same `AuthEvents`/`AuditLog`, so its audit events land next to everyone else's.
const PasswordExtras = FetchHttpClient.layer;

const RolesLive = Roles.Roles.layer.pipe(Layer.provide(Roles.config([platformAdmin])));

// 3. `TestAuth.layer` is the whole pipeline over memory — the same
//    machinery `packages/*/test/AuthHttp.test.ts` files and this repo's
//    own BDD suite already exercise for real, just not previously
//    packaged as something runnable on its own.
const AppLayer = TestAuth.layer(
  built,
  Layer.mergeAll(
    AuthenticationLive,
    CsrfProtectionLive,
    OrganizationMemory,
    PasswordExtras,
    RolesLive,
    GuardLive,
  ),
);

// Composition-time counterpart of `RequirePermission`'s per-request refusal
// (BEH-EA-156): refuse to start if an endpoint in a guarded group declares
// neither a permission requirement nor `publicEndpoint(...)`.
const audited = AuthorizationAudit.auditAuthorizationAnnotations(built.api);

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
const ServerLive = HttpRouter.serve(
  Layer.mergeAll(BodyLimit.layer, RequestContext.layer).pipe(Layer.provideMerge(AppLayer)),
).pipe(
  Layer.provide(AuthHttp.layerRedactedHeaders),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3001 })),
);

// Structured JSON logs in production, pretty logs otherwise; a logging *backend* is the
// host's choice, never the library's (ticket 27 §4).
const LoggingLive = Logger.layer([
  process.env["NODE_ENV"] === "production" ? Logger.consoleJson : Logger.consolePretty(),
]);

const Startup = Layer.effectDiscard(
  Effect.logInfo("awthaq example (memory-backed, Password + Organization) listening on :3001"),
);

audited.pipe(
  Effect.andThen(Layer.launch(Layer.merge(ServerLive, Startup))),
  Effect.provide(LoggingLive),
  NodeRuntime.runMain,
);
