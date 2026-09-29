// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): the admin gates are read per operation, so one
// composition serves tenants with different `Admin.config(...)`. Deny-all stays the default.
import { Api } from "@awthaq/api";
import { AuditChain, Sessions, Tenant, Users } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Redacted from "effect/Redacted";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";
import { TestAuth } from "@awthaq/test";

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("admin-tenant-config-test-csrf-secret-padded-to-32-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayer = (config: Partial<Admin.AdminConfigShape>) =>
  Admin.Admin.layer.pipe(
    Layer.provide(Admin.config(config)),
    Layer.provide(
      AuditChain.config({ key: Redacted.make("admin-tenant-config-chain-key-0123456789") }),
    ),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      ImpersonationRecords.layerMemory.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer))),
      ),
    ),
  );

/** The application's own map: tenant id -> that tenant's `Admin.config(...)`. */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/AdminTenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Admin.config({ canManageUsers: () => Effect.succeed(tenantId === "ops") }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

const caller = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
  sessionId: "admin-session",
});

const withTenants = (config: Partial<Admin.AdminConfigShape>) =>
  Layer.merge(buildLayer(config), TenantConfig.layer);

describe("EP-007: per-tenant Admin.config in one composition", () => {
  it.effect("a tenant's gate applies to its own requests, the default stays deny-all", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      // Build-time: deny-all.
      const denied = yield* admin.effectiveConfig(caller).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "AdminActionDenied");
      // Tenant "ops" opts in for its own requests ...
      const items = yield* admin.effectiveConfig(caller).pipe(inTenant("ops"));
      assert.isAbove(items.length, 0);
      // ... tenant "other" stays denied.
      const other = yield* admin.effectiveConfig(caller).pipe(inTenant("other"), Effect.flip);
      assert.strictEqual(other._tag, "AdminActionDenied");
    }).pipe(Effect.scoped, Effect.provide(withTenants({}))),
  );

  it.effect("a tenant may tighten a permissive build-time gate", () =>
    Effect.gen(function* () {
      const admin = yield* Admin.Admin;
      const items = yield* admin.effectiveConfig(caller);
      assert.isAbove(items.length, 0);
      const refused = yield* admin.effectiveConfig(caller).pipe(inTenant("other"), Effect.flip);
      assert.strictEqual(refused._tag, "AdminActionDenied");
    }).pipe(
      Effect.scoped,
      Effect.provide(withTenants({ canManageUsers: () => Effect.succeed(true) })),
    ),
  );
});
