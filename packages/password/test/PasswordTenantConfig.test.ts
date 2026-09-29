// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): per-tenant configuration in one composition. A
// tenant's `Password.config(...)` provided in the calling fiber decides that request; with none,
// the build-time configuration applies exactly as before.
import { Tenant } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { makeTestLayer } from "./harness.ts";

/** The application's own map: tenant id -> that tenant's `Password.config(...)`. */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/PasswordTenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Password.config({
        minLength: tenantId === "strict" ? 16 : 8,
        requireVerifiedEmail: tenantId !== "lax",
        signInTimingFloor: "off",
      }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

// Ten characters: over tenant "lax" (8), under the default (12) and tenant "strict" (16).
const tenCharacters = Redacted.make("qzxv-k7Jm2");

const withTenants = (
  options: Parameters<typeof makeTestLayer>[0] = {},
): Layer.Layer<Password.Password | TenantConfig, unknown> =>
  Layer.merge(makeTestLayer(options), TenantConfig.layer);

describe("EP-007: per-tenant Password.config in one composition", () => {
  it.effect("two tenants with different minLength, same Password layer instance", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const strict = yield* password
        .signUp({ email: "a@strict.example", password: tenCharacters })
        .pipe(inTenant("strict"), Effect.flip);
      assert.strictEqual(strict._tag, "WeakPassword");
      const lax = yield* password
        .signUp({ email: "a@lax.example", password: tenCharacters })
        .pipe(inTenant("lax"));
      assert.isDefined(lax.token);
    }).pipe(Effect.provide(withTenants())),
  );

  it.effect("with no tenant override the build-time configuration applies, exactly as before", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      // The build-time minLength (10) accepts the ten-character password.
      const issued = yield* password.signUp({ email: "a@example.com", password: tenCharacters });
      assert.isDefined(issued.token);
    }).pipe(Effect.provide(withTenants({ config: { minLength: 10 } }))),
  );

  it.effect("the default configuration still refuses the same password when nothing is overridden", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password
        .signUp({ email: "a@example.com", password: tenCharacters })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(Effect.provide(withTenants())),
  );

  it.effect("a tenant override beats the build-time configuration", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password
        .signUp({ email: "a@strict.example", password: tenCharacters })
        .pipe(inTenant("strict"), Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(Effect.provide(withTenants({ config: { minLength: 10 } }))),
  );

  it.effect("a tenant's sign-in policy (requireVerifiedEmail) applies to its own sign-ins", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const strongEnough = Redacted.make("qzxv-k7Jm2-long-enough");
      yield* password.signUp({ email: "u@example.com", password: strongEnough });
      // The account's email is unverified: the build-time default refuses the sign-in ...
      const refused = yield* password
        .signIn({ email: "u@example.com", password: strongEnough })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "EmailNotVerified");
      // ... the `lax` tenant's own configuration lets it through.
      const signedIn = yield* password
        .signIn({ email: "u@example.com", password: strongEnough })
        .pipe(inTenant("lax"));
      assert.isDefined(signedIn.token);
    }).pipe(Effect.provide(withTenants({ config: { signInTimingFloor: Duration.zero } }))),
  );
});
