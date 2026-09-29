// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): OAuth's per-request policy (trusted callback origins,
// default callback, auto-link list, timeouts, rate-limit budgets) is read per operation, so one
// composition serves tenants with different `OAuth.config(...)`. With no override the build-time
// configuration applies exactly as before.
import {
  AuditLog,
  Hooks,
  AuthEvents,
  Accounts,
  RateLimits,
  Sessions,
  Tenant,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Redacted from "effect/Redacted";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import { fakeHttpClient } from "./FakeProvider.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const acme = OAuthProvider.oauth2({
  id: "acme",
  clientId: Config.succeed("acme-client-id"),
  clientSecret: Config.succeed(Redacted.make("acme-secret")),
  scopes: ["read"],
  endpoints: {
    authorizationEndpoint: "https://acme.example.com/authorize",
    tokenEndpoint: "https://acme.example.com/token",
    userinfoEndpoint: "https://acme.example.com/userinfo",
  },
  mapProfile: (claims) => ({ subject: String(claims["id"]) }),
});

const baseConfig = {
  providers: [acme],
  baseUrl: "https://app.example.com",
  retry: { base: Duration.zero },
};

const buildLayer = (config: Partial<OAuth.OAuthConfigInput> = {}) =>
  OAuth.OAuth.layer.pipe(
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(
      fakeHttpClient({
        "/token": { access_token: "at-1" },
        "/userinfo": { id: "tenant-user-1" },
      }),
    ),
    Layer.provide(OAuth.config({ ...baseConfig, ...config })),
  );

/** The application's own map: tenant id -> that tenant's `OAuth.config(...)`. */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/OAuthTenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      OAuth.config({
        ...baseConfig,
        trustedOrigins: [`https://${tenantId}.example.com`],
        defaultCallbackURL: `/${tenantId}/home`,
      }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

/** Runs the flow up to the callback and returns where it redirected. */
const finishAt = (callbackURL: string, tenantId: string | undefined) =>
  Effect.gen(function* () {
    const oauth = yield* OAuth.OAuth;
    const run = Effect.gen(function* () {
      const { state } = yield* oauth.authorize("acme", { callbackURL, link: undefined });
      return yield* oauth.callback("acme", {
        code: "c1",
        state,
        iss: undefined,
        cookieState: state,
      });
    });
    const outcome = yield* tenantId === undefined ? run : run.pipe(inTenant(tenantId));
    return outcome.callbackURL;
  });

const withTenants = (config: Partial<OAuth.OAuthConfigInput> = {}) =>
  Layer.merge(buildLayer(config), TenantConfig.layer);

describe("EP-007: per-tenant OAuth.config in one composition", () => {
  it.effect("each tenant's trusted origins and default callback apply to its own flows", () =>
    Effect.gen(function* () {
      // Tenant "a" trusts its own origin; tenant "b" does not trust "a"'s and falls back to its default.
      assert.strictEqual(
        yield* finishAt("https://a.example.com/dash", "a"),
        "https://a.example.com/dash",
      );
      assert.strictEqual(yield* finishAt("https://a.example.com/dash", "b"), "/b/home");
    }).pipe(Effect.provide(withTenants())),
  );

  it.effect("with no tenant override the build-time configuration applies, exactly as before", () =>
    Effect.gen(function* () {
      // Nothing trusted, default "/": the same request lands on the build-time default.
      assert.strictEqual(yield* finishAt("https://a.example.com/dash", undefined), "/");
    }).pipe(Effect.provide(withTenants())),
  );

  it.effect("a build-time trusted origin still works when no tenant is in play", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* finishAt("https://built.example.com/x", undefined),
        "https://built.example.com/x",
      );
    }).pipe(Effect.provide(withTenants({ trustedOrigins: ["https://built.example.com"] }))),
  );
});
