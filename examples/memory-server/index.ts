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
import { Auth, AuthEvents, Verification } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as TestAuth from "@awthaq/test/TestAuth";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import * as Layer from "effect/Layer";
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
).pipe(Layer.provideMerge(AuthEvents.layer));

// 3. `TestAuth.layer` is the whole pipeline over memory — the same
//    machinery `packages/*/test/AuthHttp.test.ts` files and this repo's
//    own BDD suite already exercise for real, just not previously
//    packaged as something runnable on its own.
const AppLayer = TestAuth.layer(
  built,
  Layer.mergeAll(AuthenticationLive, OrganizationMemory, PasswordExtras),
);

// 4. A real listening server — the same `HttpRouter.serve` +
//    `NodeHttpServer.layer` pair the README's own quickstart uses, not an
//    in-process test client.
const ServerLive = HttpRouter.serve(AppLayer).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3001 })),
);

console.log("awthaq example (memory-backed, Password + Organization) listening on :3001");
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
