// SCP-001/BAM-005: `Passkey.authenticateVerify` consults the one shared sign-in
// gate (`Users.assertCanSignIn`) after the assertion verifies and before any
// session exists. A dedicated file, like `PasskeyHooksSignIn.test.ts`, so its
// layers carry no unrelated `BeforeSessionIssue` tap.
import { AuditLog, Hooks, AuthEvents, Accounts, RateLimits, Sessions, Users } from "@awthaq/core";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import * as PasskeyUserHandles from "../src/PasskeyUserHandles.ts";
import {
  ORIGIN,
  RP_ID,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
} from "./passkeyTestFixtures.ts";

const CoreLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(RateLimiter.layerPermissive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("passkey-suspended-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const PortsLive = Layer.mergeAll(
  mockWebAuthn(),
  ChallengeStore.layerMemory,
  PasskeyCredentials.layerMemory,
  PasskeyUserHandles.layerMemory,
  ClientAddress.layerDirect,
).pipe(Layer.provideMerge(NodeCrypto.layer));

const TestLayer = Passkey.Passkey.layer.pipe(
  Layer.provide(Passkey.config({ rpId: RP_ID, origins: [ORIGIN] })),
  Layer.provide(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(PortsLive),
);

describe("Passkey authenticateVerify sign-in gate (SCP-001)", () => {
  it.effect(
    "a suspended user's valid assertion is refused with UserSuspended and issues no session; reactivating restores it",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;

        const user = yield* users.create({
          identity: { _tag: "Email", email: "gate@example.com" },
          name: "Gate",
        });
        const registerSession = yield* sessions.issue({ userId: user.id });
        const registerOptions = yield* passkey.registerOptions(user.id, registerSession.session.id);
        yield* passkey.registerVerify(user.id, registerSession.session.id, {
          credential: {
            id: "cred-gate-1",
            rawId: "cred-gate-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge: extractChallenge(registerOptions),
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        });

        const signIn = Effect.gen(function* () {
          const { ceremonyId, options } = yield* passkey.authenticateOptions({});
          return yield* passkey.authenticateVerify({
            ceremonyId,
            credential: {
              id: "cred-gate-1",
              rawId: "cred-gate-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.get",
                  challenge: extractChallenge(options),
                  origin: ORIGIN,
                }),
                authenticatorData: "",
                signature: "",
              },
            },
          });
        });

        yield* users.setStatus(user.id, "suspended", { reason: "abuse" });
        const before = (yield* sessions.list(user.id)).length;
        const refused = yield* signIn.pipe(Effect.flip);
        assert.strictEqual(refused._tag, "UserSuspended");
        assert.strictEqual((yield* sessions.list(user.id)).length, before);

        yield* users.setStatus(user.id, "active");
        const restored = yield* signIn;
        assert.strictEqual(restored.session.userId, user.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});
