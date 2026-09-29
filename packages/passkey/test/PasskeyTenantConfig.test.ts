// EP-007 (ADR-EA-018 Decision 8, BEH-EA-236): the ceremony policy (rpId, origins, ...) is read per
// operation, so one composition serves tenants on different relying-party domains. With no
// override the build-time configuration applies exactly as before.
import { Sessions, Tenant, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Passkey from "../src/Passkey.ts";
import { buildLayer } from "./passkeyTestLayers.ts";
import {
  ORIGIN,
  RP_ID,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
} from "./passkeyTestFixtures.ts";

/** The application's own map: tenant id -> that tenant's `Passkey.config(...)` (its own domain). */
class TenantConfig extends LayerMap.Service<TenantConfig>()("test/PasskeyTenantConfig", {
  lookup: (tenantId: string) =>
    Layer.merge(
      Passkey.config({
        rpId: `${tenantId}.test`,
        origins: [`https://${tenantId}.test`],
      }),
      Tenant.configApplied(tenantId),
    ),
  idleTimeToLive: "1 minute",
}) {}

const inTenant = (tenantId: string) => Effect.provide(TenantConfig.get(tenantId));

const TestLayer = Layer.merge(buildLayer(mockWebAuthn()), TenantConfig.layer);

const setup = Effect.gen(function* () {
  const users = yield* Users.Users;
  const sessions = yield* Sessions.Sessions;
  const user = yield* users.create({
    identity: { _tag: "Email", email: "tenant@example.com" },
    name: "Tenant",
  });
  const issued = yield* sessions.issue({ userId: user.id });
  return { userId: user.id, sessionId: issued.session.id };
});

describe("EP-007: per-tenant Passkey.config in one composition", () => {
  it.effect("registration options carry the tenant's own rpId; the default is untouched", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* setup;
      const acme = yield* passkey.registerOptions(userId, sessionId).pipe(inTenant("acme"));
      assert.strictEqual(acme.rp.id, "acme.test");
      const fallback = yield* passkey.registerOptions(userId, sessionId);
      assert.strictEqual(fallback.rp.id, RP_ID);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a tenant's origin allow-list decides its own registrations", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* setup;
      const credentialFor = (origin: string, challenge: string) => ({
        credential: {
          id: "cred-tenant-1",
          rawId: "cred-tenant-1",
          type: "public-key" as const,
          response: {
            clientDataJSON: buildClientDataJSON({ type: "webauthn.create", challenge, origin }),
            attestationObject: "",
          },
        },
      });
      // The default (build-time) origin is refused under the tenant's configuration ...
      const options = yield* passkey.registerOptions(userId, sessionId).pipe(inTenant("acme"));
      const refused = yield* passkey
        .registerVerify(userId, sessionId, credentialFor(ORIGIN, extractChallenge(options)))
        .pipe(inTenant("acme"), Effect.flip);
      assert.strictEqual(refused._tag, "PasskeyOriginMismatch");
      // ... and the tenant's own origin is accepted.
      const again = yield* passkey.registerOptions(userId, sessionId).pipe(inTenant("acme"));
      const record = yield* passkey
        .registerVerify(
          userId,
          sessionId,
          credentialFor("https://acme.test", extractChallenge(again)),
        )
        .pipe(inTenant("acme"));
      assert.strictEqual(record.id, "cred-tenant-1");
    }).pipe(Effect.provide(TestLayer)),
  );
});
