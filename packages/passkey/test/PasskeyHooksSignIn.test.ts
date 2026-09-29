// BCR-004/THS-002 (.issues/high, wayfinder ticket 03): proves
// `Passkey.authenticateVerify` genuinely consults
// `Hooks.BeforeSessionIssue` — a dedicated file, not folded into
// `Passkey.test.ts`, for the same reason
// `packages/password/test/PasswordHooksSignUp.test.ts`'s own header
// comment gives.
import { AuditLog, Hooks, AuthEvents, Accounts, RateLimits, Sessions, Users } from "@awthaq/core";
import { ClientAddress, RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  // BEH-EA-093: unconditionally diverts — enough to prove the wiring is
  // real; the mechanism itself is proven generically elsewhere (see this
  // file's own header comment).
  Layer.provideMerge(
    Hooks.BeforeSessionIssue.tap((input) =>
      Effect.succeed(
        Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "chal-1" })),
      ),
    ),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("passkey-hooks-test-csrf-secret"),
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

describe("Passkey authenticateVerify hook (BEH-EA-093)", () => {
  it.effect(
    "a BeforeSessionIssue divert tap redirects authenticateVerify's own sign-in to TwoFactorRequired",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;

        const user = yield* users.create({ email: "bo@example.com", name: "Bo" });
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

        const diverted = yield* passkey
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
              error._tag === "TwoFactorRequired" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(diverted.challengeId, "chal-1");
      }).pipe(Effect.provide(TestLayer)),
  );
});
