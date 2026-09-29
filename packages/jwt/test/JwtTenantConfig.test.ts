// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): issuer, audience and ttl are read per operation, so
// one composition (one key ring) mints and verifies tokens for tenants with different
// `Jwt.config(...)`. With no override the build-time configuration applies exactly as before.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Sessions } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const caller = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "user-1" }),
  sessionId: "session-1",
});

const buildLayer = () =>
  Jwt.Jwt.layer.pipe(
    Layer.provide(KeyRing.KeyRing.layer),
    Layer.provide(SigningKeyRecords.layerMemory),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(AuthenticationLive),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(RevocationStore.layerMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(JwtConfig.config({ issuer: "https://issuer.test" })),
  );

/** The application's own map: tenant id -> that tenant's `Jwt.config(...)`. */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/JwtTenantConfig", {
  lookup: (tenantId: string) =>
    JwtConfig.config({
      issuer: `https://${tenantId}.issuer.test`,
      ttl: tenantId === "short" ? Duration.minutes(1) : Duration.hours(1),
    }),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

const withTenants = () => Layer.merge(buildLayer(), TenantConfig.layer);

describe("EP-007: per-tenant Jwt.config in one composition", () => {
  it.effect("each tenant mints under its own issuer and ttl, verifies only its own tokens", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const shortToken = yield* jwt.sign(caller).pipe(inTenant("short"));
      const longToken = yield* jwt.sign(caller).pipe(inTenant("long"));
      const short = yield* jwt.verify(shortToken).pipe(inTenant("short"));
      const long = yield* jwt.verify(longToken).pipe(inTenant("long"));
      assert.strictEqual(short["iss"], "https://short.issuer.test");
      assert.strictEqual(long["iss"], "https://long.issuer.test");
      assert.strictEqual(Number(short["exp"]) - Number(short["iat"]), 60);
      assert.strictEqual(Number(long["exp"]) - Number(long["iat"]), 3600);
      // A token minted for one tenant is not accepted by another (issuer/audience mismatch).
      const crossed = yield* jwt.verify(shortToken).pipe(inTenant("long"), Effect.flip);
      assert.strictEqual(crossed._tag, "JwtInvalidError");
    }).pipe(Effect.provide(withTenants())),
  );

  it.effect("with no tenant override the build-time configuration applies, exactly as before", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.sign(caller);
      const claims = yield* jwt.verify(token);
      assert.strictEqual(claims["iss"], "https://issuer.test");
      assert.strictEqual(Number(claims["exp"]) - Number(claims["iat"]), 900);
      // A tenant-minted token is foreign to the default configuration.
      const foreign = yield* jwt.sign(caller).pipe(inTenant("short"));
      const refused = yield* jwt.verify(foreign).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "JwtInvalidError");
    }).pipe(Effect.provide(withTenants())),
  );
});
