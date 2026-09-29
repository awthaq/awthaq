// NAM-002 (.issues/high): `Passkey.authenticateVerify` consults `BeforeSignIn`
// once the assertion is verified, before `BeforeSessionIssue`; a veto surfaces
// as the typed `HookAborted` and no session is issued.
import {
  AuditLog,
  Hooks,
  HookPoint,
  AuthEvents,
  Accounts,
  RateLimits,
  Sessions,
  Users,
} from "@awthaq/core";
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
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(RateLimiter.layerPermissive),
  Layer.provideMerge(
    Hooks.BeforeSignIn.tap((input) =>
      Effect.fail(new HookPoint.HookAbort({ code: `PASSKEY_DENIED:${input.strategy}` })),
    ),
  ),
  // The tap requires its point, so `HooksLive` feeds both (ELC-001).
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("passkey-hooks-test-csrf-secret-padded-to-thirty-two-bytes"),
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

describe("Passkey authenticateVerify BeforeSignIn hook (NAM-002)", () => {
  it.effect(
    "a BeforeSignIn veto tap denies authenticateVerify's sign-in with HookAborted",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;

        const user = yield* users.create({ identity: { _tag: "Email", email: "bo@example.com" }, name: "Bo" });
        const registerSession = yield* sessions.issue({ userId: user.id });
        const registerOptions = yield* passkey.registerOptions(user.id, registerSession.session.id);
        yield* passkey.registerVerify(user.id, registerSession.session.id, {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
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

        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
        const clientDataJSON = buildClientDataJSON({
          type: "webauthn.get",
          challenge: extractChallenge(options),
          origin: ORIGIN,
        });

        const aborted = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
              type: "public-key",
              response: { clientDataJSON, authenticatorData: "", signature: "" },
            },
          })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(aborted.point, "auth.user.signIn");
        assert.strictEqual(aborted.code, "PASSKEY_DENIED:passkey");
      }).pipe(Effect.provide(TestLayer)),
  );

  // CSD-004: a refused assertion is the passkey strategy's failure signal.
  it.effect(
    "a refused assertion publishes auth.user.signInFailed (strategy passkey, reason assertionInvalid)",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const auditLog = yield* AuditLog.AuditLog;
        const refused = yield* passkey
          .authenticateVerify({
            ceremonyId: "no-such-ceremony",
            ip: "203.0.113.4",
            credential: {
              id: "cred-x",
              rawId: "cred-x",
              type: "public-key",
              response: { clientDataJSON: "not-client-data", authenticatorData: "", signature: "" },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "PasskeyChallengeInvalid");
        const [failure] = yield* auditLog.list({ eventTag: "auth.user.signInFailed" });
        assert.deepStrictEqual(failure?.payload, {
          _tag: "auth.user.signInFailed",
          strategy: "passkey",
          reason: "assertionInvalid",
          clientIp: "203.0.113.4",
        });
      }).pipe(Effect.provide(TestLayer)),
  );
});
