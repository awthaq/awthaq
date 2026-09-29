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
import { AuditLog, Auth, AuthEvents, Verification } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

// 1. Compose Password and Organization together — `Auth.make` folds both
//    plugins' own HttpApi contracts and Layers into one `api`/`layer`
//    pair, the same call the README's own quickstart makes with just
//    `[Password.Password]`. `dependsOn` is left unset on both: neither
//    requires the other to exist first.
const built = Auth.make([Password.Password, Organization.Organization]);

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
const PasswordExtras = Layer.mergeAll(
  Verification.layerMemory,
  PasswordHasher.layerArgon2id,
  FetchHttpClient.layer,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(AuditLog.layerMemory));

// 3. `TestAuth.layer` is the whole pipeline over memory — the same
//    machinery `packages/*/test/AuthHttp.test.ts` files and this repo's
//    own BDD suite already exercise for real, just not previously
//    packaged as something runnable on its own.
const AppLayer = TestAuth.layer(
  built,
  Layer.mergeAll(AuthenticationLive, CsrfProtectionLive, OrganizationMemory, PasswordExtras),
);

// 4. A real listening server — the same `HttpRouter.serve` +
//    `NodeHttpServer.layer` pair the README's own quickstart uses, not an
//    in-process test client.
const ServerLive = HttpRouter.serve(AppLayer).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3001 })),
);

console.log("awthaq example (memory-backed, Password + Organization) listening on :3001");
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
