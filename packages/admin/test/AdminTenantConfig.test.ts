// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): the admin gates are read per operation, so one
// composition serves tenants with different `Admin.config(...)`. Deny-all stays the default.
import { Api } from "@awthaq/api";
import { Accounts, AuditChain, Auth, Tenant, Users } from "@awthaq/core";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Redacted from "effect/Redacted";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import { TestAuth } from "@awthaq/test";

const buildLayer = (config: Partial<Admin.AdminConfigShape>) =>
  TestAuth.layer(Auth.make([Admin.Admin]), {
    services: Layer.mergeAll(
      Admin.config(config),
      AuditChain.config({ key: Redacted.make("admin-tenant-config-chain-key-0123456789") }),
    ),
  });

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

// ---- AdminAccounts reads the tenant's configuration per operation (plan 13 phase 0) ------------

const accountsLayer = (config: Partial<Admin.AdminConfigShape>) =>
  TestAuth.layer(Auth.make([Admin.Admin, AdminAccounts.AdminAccounts]), {
    services: Layer.mergeAll(Admin.config(config)),
  });

const allow = () => Effect.succeed(true);

/** Tenant "ops" opens deletion and credentials and brings its own policy and link; every other tenant has nothing. */
class AccountsTenantConfig extends LayerMap.Service<AccountsTenantConfig>()(
  "test/AdminAccountsTenantConfig",
  {
    lookup: (tenantId: string) =>
      Layer.merge(
        tenantId === "ops"
          ? Admin.config({
              canDeleteUsers: allow,
              canManageCredentials: allow,
              passwordPolicy: (password) =>
                Effect.succeed(/\d/.test(Redacted.value(password)) ? [] : ["must contain a digit"]),
              links: { changeEmail: (token) => `https://ops.example/confirm?token=${token}` },
            })
          : Admin.config({}),
        Tenant.configApplied(tenantId),
      ),
    idleTimeToLive: "1 minute",
  },
) {}

const inAccountsTenant = (tenantId: string) => Effect.provide(AccountsTenantConfig.get(tenantId));

const withAccountsTenants = (config: Partial<Admin.AdminConfigShape>) =>
  Layer.merge(accountsLayer(config), AccountsTenantConfig.layer);

const seedPair = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const hasher = yield* PasswordHasher.PasswordHasher;
  const admin = yield* users.create({
    identity: { _tag: "Email", email: "admin@example.com" },
    name: "Admin",
  });
  const target = yield* users.create({
    identity: { _tag: "Email", email: "target@example.com" },
    name: "Target",
  });
  yield* accounts.link({
    userId: target.id,
    providerId: Accounts.PASSWORD_PROVIDER_ID,
    subject: target.id,
    credentialHash: Redacted.make(
      yield* hasher.hash(Redacted.make("the old password of the target")),
    ),
  });
  const principal = new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: admin.id }),
    sessionId: "admin-session",
  });
  return { principal, targetId: target.id, users };
});

describe("ADR-EA-018 D8: AdminAccounts reads the tenant's configuration per operation", () => {
  it.effect(
    "a tenant may tighten a permissive build-time canDeleteUsers: the account survives",
    () =>
      Effect.gen(function* () {
        const { principal, targetId, users } = yield* seedPair;
        const accounts = yield* AdminAccounts.AdminAccounts;
        const refused = yield* accounts
          .deleteUser(principal, targetId)
          .pipe(inAccountsTenant("other"), Effect.flip);
        assert.strictEqual(refused._tag, "AdminActionDenied");
        const survivor = yield* users.findById(targetId);
        assert.strictEqual(survivor.id, targetId);
      }).pipe(Effect.scoped, Effect.provide(withAccountsTenants({ canDeleteUsers: allow }))),
  );

  it.effect("a tenant may open canManageCredentials over a deny-all build", () =>
    Effect.gen(function* () {
      const { principal } = yield* seedPair;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const ghost = Users.UserId("ghost");
      const denied = yield* accounts
        .setUserPassword(principal, ghost, { password: Redacted.make("whatever 1 password") })
        .pipe(Effect.flip);
      assert.strictEqual(denied._tag, "AdminActionDenied");
      const pastGate = yield* accounts
        .setUserPassword(principal, ghost, { password: Redacted.make("whatever 1 password") })
        .pipe(inAccountsTenant("ops"), Effect.flip);
      assert.strictEqual(pastGate._tag, "AdminTargetNotFound");
    }).pipe(Effect.scoped, Effect.provide(withAccountsTenants({}))),
  );

  it.effect("a tenant's passwordPolicy governs an administrator-set password", () =>
    Effect.gen(function* () {
      const { principal, targetId } = yield* seedPair;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const weak = yield* accounts
        .setUserPassword(principal, targetId, {
          password: Redacted.make("a thirty character password no digit"),
        })
        .pipe(inAccountsTenant("ops"), Effect.flip);
      assert.strictEqual(weak._tag, "AdminWeakPassword");
      if (weak._tag === "AdminWeakPassword") {
        assert.deepStrictEqual(weak.hints, ["must contain a digit"]);
      }
    }).pipe(Effect.scoped, Effect.provide(withAccountsTenants({ canManageCredentials: allow }))),
  );

  it.effect("a tenant's links.changeEmail builds the mailed confirmation link", () =>
    Effect.gen(function* () {
      const { principal, targetId } = yield* seedPair;
      const accounts = yield* AdminAccounts.AdminAccounts;
      const mailer = yield* Mailer.Mailer;
      yield* accounts
        .setUserEmail(principal, targetId, { email: "new@example.com" })
        .pipe(inAccountsTenant("ops"));
      const mail = (yield* mailer.sent)[0];
      assert.match(String(mail?.data?.["url"]), /^https:\/\/ops\.example\/confirm\?token=/);
    }).pipe(Effect.scoped, Effect.provide(withAccountsTenants({}))),
  );
});
