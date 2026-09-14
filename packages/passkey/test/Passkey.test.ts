// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `AuthHttp.test.ts` for the wire-level equivalent, ticket 10): real
// `Users`/`Accounts`/`Sessions`/`AuthEvents`/`ChallengeStore`/
// `PasskeyCredentials`, `WebAuthn` stubbed via `Layer.mock` (BEH-EA-195) —
// this suite proves the plugin's own ceremony/persistence/enumeration-safety
// logic, not `@simplewebauthn/server`'s cryptography (that's
// `packages/ports/test/WebAuthn.test.ts`'s own job).
import { AuthEvents, Accounts, Sessions, Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import {
  ORIGIN,
  RP_ID,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
} from "./passkeyTestFixtures.ts";

const CoreLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * The `passkey`/`passkey.credentials` groups declare `.middleware(Api.Authentication)`
 * (`PasskeyApi.ts`) — merged into `Passkey.Passkey.layer` regardless of
 * whether a test ever dispatches real HTTP, so this domain-level suite
 * still has to satisfy it, the same way `AuthHttp.test.ts` would.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const PortsLive = (webAuthn: Layer.Layer<WebAuthn.WebAuthn>) =>
  Layer.mergeAll(webAuthn, ChallengeStore.layerMemory, PasskeyCredentials.layerMemory).pipe(
    Layer.provideMerge(NodeCrypto.layer),
  );

const buildLayer = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  configOverrides?: Partial<Passkey.PasskeyConfigShape>,
) =>
  Passkey.Passkey.layer.pipe(
    Layer.provide(Passkey.config({ rpId: RP_ID, origins: [ORIGIN], ...configOverrides })),
    Layer.provide(AuthenticationLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(PortsLive(webAuthn)),
  );

const TestLayer = buildLayer(mockWebAuthn());

/** Creates a user, issues a session, and registers `cred-mock-1` for that user — the shared setup every credential-management/authentication test starts from. */
const registerNewUser = (
  email: string,
): Effect.Effect<
  { readonly userId: Users.UserId; readonly sessionId: Sessions.SessionId },
  unknown,
  Passkey.Passkey | Users.Users | Sessions.Sessions
> =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ email, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    const options = yield* passkey.registerOptions(user.id, issued.session.id);
    yield* passkey.registerVerify(user.id, issued.session.id, {
      credential: {
        id: "cred-mock-1",
        rawId: "cred-mock-1",
        type: "public-key",
        response: {
          clientDataJSON: buildClientDataJSON({
            type: "webauthn.create",
            challenge: extractChallenge(options),
            origin: ORIGIN,
          }),
          attestationObject: "",
        },
      },
    });
    return { userId: user.id, sessionId: issued.session.id };
  });

describe("Passkey", () => {
  it.effect("BEH-EA-130/134: register/verify persists a credential and links an Accounts row", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;

      const user = yield* users.create({ email: "ada@example.com", name: "Ada" });
      const issued = yield* sessions.issue({ userId: user.id });

      const options = yield* passkey.registerOptions(user.id, issued.session.id);

      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.create",
        challenge: extractChallenge(options),
        origin: ORIGIN,
      });

      const record = yield* passkey.registerVerify(user.id, issued.session.id, {
        credential: {
          id: "cred-mock-1",
          rawId: "cred-mock-1",
          type: "public-key",
          response: { clientDataJSON, attestationObject: "" },
        },
      });

      assert.strictEqual(record.id, "cred-mock-1");
      const linked = yield* accounts.findByProviderSubject("passkey", "cred-mock-1");
      assert.isTrue(linked._tag === "Some");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-131: authenticate/verify issues a real session via Sessions", () =>
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

      const { ceremonyId, options } = yield* passkey.authenticateOptions(undefined);
      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.get",
        challenge: extractChallenge(options),
        origin: ORIGIN,
      });
      const issued = yield* passkey.authenticateVerify({
        ceremonyId,
        credential: {
          id: "cred-mock-1",
          rawId: "cred-mock-1",
          type: "public-key",
          response: { clientDataJSON, authenticatorData: "", signature: "" },
        },
      });

      assert.strictEqual(issued.session.userId, user.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-136: an unknown credential id at authenticate/verify answers uniform InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { ceremonyId, options } = yield* passkey.authenticateOptions(undefined);
        const clientDataJSON = buildClientDataJSON({
          type: "webauthn.get",
          challenge: extractChallenge(options),
          origin: ORIGIN,
        });
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: {
              id: "no-such-credential",
              rawId: "no-such-credential",
              type: "public-key",
              response: { clientDataJSON, authenticatorData: "", signature: "" },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidCredentials");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a replayed or expired challenge is rejected as PasskeyChallengeInvalid", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { ceremonyId, options } = yield* passkey.authenticateOptions(undefined);
      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.get",
        challenge: extractChallenge(options),
        origin: ORIGIN,
      });
      const credential = {
        id: "cred-mock-1",
        rawId: "cred-mock-1",
        type: "public-key" as const,
        response: { clientDataJSON, authenticatorData: "", signature: "" },
      };
      // First attempt consumes the challenge (fails downstream for an
      // unrelated reason — unknown credential — but the store entry is
      // gone either way, per BEH-EA-132).
      yield* passkey.authenticateVerify({ ceremonyId, credential }).pipe(Effect.ignore);
      const replay = yield* passkey
        .authenticateVerify({ ceremonyId, credential })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "PasskeyChallengeInvalid");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "Missing required user verification is rejected as PasskeyUserVerificationRequired",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "uv@example.com", name: "UV" });
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

        const { ceremonyId, options } = yield* passkey.authenticateOptions(undefined);
        const clientDataJSON = buildClientDataJSON({
          type: "webauthn.get",
          challenge: extractChallenge(options),
          origin: ORIGIN,
        });
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
              type: "public-key",
              response: { clientDataJSON, authenticatorData: "", signature: "" },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyUserVerificationRequired");
      }).pipe(
        Effect.provide(
          buildLayer(mockWebAuthn({ authenticationVerified: { userVerified: false } }), {
            authenticatorSelection: { userVerification: "required" },
          }),
        ),
      ),
  );

  it.effect("a counter regression is flagged via AuthEvents without failing the ceremony", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const events = yield* AuthEvents.AuthEvents;
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;

      const { userId } = yield* registerNewUser("counter@example.com");
      // Simulate this credential already having a genuinely nonzero
      // counter from an earlier, real authentication — the mocked
      // `verifyAuthentication` below always reports `newCounter: 1`,
      // which is a real regression against this seeded value.
      yield* credentials.recordUsage("cred-mock-1", 5, false);

      const seen = yield* Effect.forkChild(
        events.stream.pipe(
          Stream.filter((event) => event._tag === "auth.passkey.counterAnomaly"),
          Stream.take(1),
          Stream.runCollect,
        ),
        { startImmediately: true },
      );

      const { ceremonyId, options } = yield* passkey.authenticateOptions(undefined);
      const clientDataJSON = buildClientDataJSON({
        type: "webauthn.get",
        challenge: extractChallenge(options),
        origin: ORIGIN,
      });
      const issued = yield* passkey.authenticateVerify({
        ceremonyId,
        credential: {
          id: "cred-mock-1",
          rawId: "cred-mock-1",
          type: "public-key",
          response: { clientDataJSON, authenticatorData: "", signature: "" },
        },
      });
      // "log + step-up, not an instant kill" — the ceremony still succeeds.
      assert.strictEqual(issued.session.userId, userId);

      const collected = yield* Fiber.join(seen);
      assert.strictEqual(collected.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-134: credential management refuses to remove the last credential", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId } = yield* registerNewUser("last@example.com");

      const refusal = yield* passkey.removeCredential(userId, "cred-mock-1").pipe(Effect.flip);
      assert.strictEqual(refusal._tag, "PasskeyLastCredential");

      const listed = yield* passkey.listCredentials(userId);
      assert.strictEqual(listed.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rename fails for a credential belonging to another user", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      yield* registerNewUser("owner@example.com");
      const other = yield* users.create({ email: "other@example.com", name: "Other" });

      const failure = yield* passkey
        .renameCredential(other.id, "cred-mock-1", "Stolen")
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyCredentialNotFound");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Passkey — origin/rpId (BEH-EA-133)", () => {
  it.effect("register/verify rejects a response asserting the wrong origin", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ email: "origin@example.com", name: "Origin" });
      const registerSession = yield* sessions.issue({ userId: user.id });
      const failure = yield* passkey
        .registerVerify(user.id, registerSession.session.id, {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge: "x",
                origin: "https://evil.example",
              }),
              attestationObject: "",
            },
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyOriginMismatch");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Passkey — Conditional Create (ticket 07)", () => {
  it.effect(
    "registerOptionsConditional's own challenge completes register/verify with UP=0/UV=0 accepted",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "conditional@example.com", name: "Conditional" });
        const issued = yield* sessions.issue({ userId: user.id });

        const options = yield* passkey.registerOptionsConditional(user.id, issued.session.id);
        const record = yield* passkey.registerVerify(user.id, issued.session.id, {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge: extractChallenge(options),
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        });
        assert.strictEqual(record.id, "cred-mock-1");
      }).pipe(
        Effect.provide(buildLayer(mockWebAuthn({ registrationVerified: { userVerified: false } }))),
      ),
  );

  it.effect("conditionalCreate defaults to true", () =>
    Effect.gen(function* () {
      const enabled = yield* Passkey.PasskeyConfig;
      assert.isTrue(enabled.conditionalCreate);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("setting conditionalCreate to false disables registerOptionsConditional", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ email: "disabled@example.com", name: "Disabled" });
      const issued = yield* sessions.issue({ userId: user.id });
      const failure = yield* passkey
        .registerOptionsConditional(user.id, issued.session.id)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyConditionalCreateDisabled");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { conditionalCreate: false }))),
  );

  it.effect(
    "register/verify still requires user verification via the ordinary (non-conditional) scope",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "strict@example.com", name: "Strict" });
        const issued = yield* sessions.issue({ userId: user.id });

        const options = yield* passkey.registerOptions(user.id, issued.session.id);
        const failure = yield* passkey
          .registerVerify(user.id, issued.session.id, {
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge: extractChallenge(options),
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyUserVerificationRequired");
      }).pipe(
        Effect.provide(buildLayer(mockWebAuthn({ registrationVerified: { userVerified: false } }))),
      ),
  );
});
