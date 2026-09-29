// spec/behaviors/17-passkey.md, BEH-EA-130/132/133.
//
// The ceremony policy every registration/authentication/step-up ceremony
// applies: which challenge scope a verify consumes (WPS-003), user presence
// (CB-002), the one origin policy (CB-003, MNA-007), explicit timeouts
// (TC-003), the conditional-create exemption (CB-009), and what a
// registration persists (HSK-003, WPS-010). Domain-level, real in-memory
// services, `WebAuthn` mocked (BEH-EA-195) with a spy on what the plugin asks
// of it.
import { Accounts, Sessions, Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Passkey from "../src/Passkey.ts";
import { buildLayer, registerNewUser } from "./passkeyTestLayers.ts";
import {
  assertionCredential,
  extractChallenge,
  mockWebAuthn,
  registrationPayload,
} from "./passkeyTestFixtures.ts";

const ANDROID_ORIGIN = "android:apk-key-hash:5Rzx8dDZ6lOZ0B1c1tYy4C3JdW0e8xZ2rQKq3Q4mVv8";

/** A fresh user with a live session, ready to run a registration ceremony. */
const newUserSession = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ email, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    return { userId: user.id, sessionId: issued.session.id };
  });

describe("WPS-003: register/verify consumes exactly the ceremony it names", () => {
  it.effect(
    "completing a conditional ceremony leaves a concurrently-issued modal challenge usable",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* newUserSession("wps003@example.com");

        const modal = yield* passkey.registerOptions(userId, sessionId);
        const conditional = yield* passkey.registerOptionsConditional(userId, sessionId);

        yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: conditional, id: "cred-c", ceremony: "conditional" }),
        );
        // Before the fix the probe of the modal scope consumed (destroyed) this challenge.
        const record = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: modal, id: "cred-m" }),
        );
        assert.strictEqual(record.id, "cred-m");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a conditional challenge presented as the modal ceremony is not accepted", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("wps003b@example.com");
      const conditional = yield* passkey.registerOptionsConditional(userId, sessionId);
      const failure = yield* passkey
        .registerVerify(userId, sessionId, registrationPayload({ options: conditional }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyChallengeInvalid");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("CB-002: user presence on registration", () => {
  const upSpy: Array<WebAuthn.VerifyRegistrationInput> = [];
  it.effect("an ordinary registration requires UP; a conditional one does not", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb002a@example.com");
      const modal = yield* passkey.registerOptions(userId, sessionId);
      yield* passkey.registerVerify(
        userId,
        sessionId,
        registrationPayload({ options: modal, id: "cred-a" }),
      );
      const conditional = yield* passkey.registerOptionsConditional(userId, sessionId);
      yield* passkey.registerVerify(
        userId,
        sessionId,
        registrationPayload({ options: conditional, id: "cred-b", ceremony: "conditional" }),
      );
      assert.deepStrictEqual(
        upSpy.map((call) => call.requireUserPresence),
        [true, false],
      );
    }).pipe(Effect.provide(buildLayer(mockWebAuthn({ spy: { verifyRegistration: upSpy } })))),
  );

  it.effect("ordinary registerVerify rejects a UP=0 response with PasskeyVerificationFailed", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb002b@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      const failure = yield* passkey
        .registerVerify(userId, sessionId, registrationPayload({ options }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(
      Effect.provide(
        buildLayer(
          mockWebAuthn({ registrationVerified: { userPresent: false, userVerified: false } }),
        ),
      ),
    ),
  );

  it.effect("a conditional registration accepts UP=0/UV=0", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb002c@example.com");
      const options = yield* passkey.registerOptionsConditional(userId, sessionId);
      const record = yield* passkey.registerVerify(
        userId,
        sessionId,
        registrationPayload({ options, ceremony: "conditional" }),
      );
      assert.strictEqual(record.id, "cred-mock-1");
    }).pipe(
      Effect.provide(
        buildLayer(
          mockWebAuthn({ registrationVerified: { userPresent: false, userVerified: false } }),
        ),
      ),
    ),
  );
});

describe("CB-003: cross-origin (embedded) ceremonies", () => {
  it.effect("register/verify rejects clientData with crossOrigin:true", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb003a@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      const failure = yield* passkey
        .registerVerify(
          userId,
          sessionId,
          registrationPayload({ options, crossOrigin: true, topOrigin: "https://evil.example" }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyOriginMismatch");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("register/verify rejects crossOrigin:true that reports no topOrigin at all", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb003b@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      const failure = yield* passkey
        .registerVerify(userId, sessionId, registrationPayload({ options, crossOrigin: true }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyOriginMismatch");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect(
    "authenticate/verify rejects crossOrigin:true without topOrigin as InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        yield* registerNewUser("cb003c@example.com");
        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: assertionCredential({ options, crossOrigin: true }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidCredentials");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("reauthenticate/verify rejects crossOrigin:true as PasskeyOriginMismatch", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* registerNewUser("cb003d@example.com");
      const options = yield* passkey.reauthenticateOptions(userId, sessionId);
      const failure = yield* passkey
        .reauthenticateVerify(userId, sessionId, {
          credential: assertionCredential({
            options,
            crossOrigin: true,
            topOrigin: "https://evil.example",
          }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyOriginMismatch");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("an explicitly allowed top origin is accepted and forwarded to the port", () => {
    const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
    return Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId } = yield* registerNewUser("cb003e@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      const issued = yield* passkey.authenticateVerify({
        ceremonyId,
        credential: assertionCredential({
          options,
          crossOrigin: true,
          topOrigin: "https://embedder.example",
        }),
      });
      assert.strictEqual(issued.session.userId, userId);
      assert.deepStrictEqual(spy[0]?.expectedTopOrigin, ["https://embedder.example"]);
    }).pipe(
      Effect.provide(
        buildLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }), {
          allowedTopOrigins: ["https://embedder.example"],
        }),
      ),
    );
  });

  it.effect("a non-embedded ceremony forwards no expectedTopOrigin", () => {
    const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
    return Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      yield* registerNewUser("cb003f@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      yield* passkey.authenticateVerify({
        ceremonyId,
        credential: assertionCredential({ options }),
      });
      assert.isUndefined(spy[0]?.expectedTopOrigin);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }))));
  });
});

describe("MNA-007: platform (android:apk-key-hash:) origins", () => {
  const androidConfig = { origins: ["https://example.com", ANDROID_ORIGIN] };

  it.effect("register/verify accepts a configured android:apk-key-hash origin", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("mna007a@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      const record = yield* passkey.registerVerify(
        userId,
        sessionId,
        registrationPayload({ options, origin: ANDROID_ORIGIN }),
      );
      assert.strictEqual(record.id, "cred-mock-1");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn(), androidConfig))),
  );

  it.effect("register/verify rejects an unconfigured android origin", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("mna007b@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      const failure = yield* passkey
        .registerVerify(
          userId,
          sessionId,
          registrationPayload({ options, origin: "android:apk-key-hash:someone-elses" }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyOriginMismatch");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn(), androidConfig))),
  );

  it.effect(
    "sign-in and step-up accept the configured android origin; sign-in refuses others",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* registerNewUser("mna007c@example.com");

        const signIn = yield* passkey.authenticateOptions({});
        const issued = yield* passkey.authenticateVerify({
          ceremonyId: signIn.ceremonyId,
          credential: assertionCredential({ options: signIn.options, origin: ANDROID_ORIGIN }),
        });
        assert.strictEqual(issued.session.userId, userId);

        const stepUp = yield* passkey.reauthenticateOptions(userId, sessionId);
        yield* passkey.reauthenticateVerify(userId, sessionId, {
          credential: assertionCredential({ options: stepUp, origin: ANDROID_ORIGIN }),
        });

        const other = yield* passkey.authenticateOptions({});
        const refused = yield* passkey
          .authenticateVerify({
            ceremonyId: other.ceremonyId,
            credential: assertionCredential({
              options: other.options,
              origin: "android:apk-key-hash:someone-elses",
            }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "InvalidCredentials");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn(), androidConfig))),
  );
});

describe("TC-003: explicit ceremony timeout, hints and extensions", () => {
  it.effect(
    "every options response carries the configured timeout, never above the challenge TTL",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* registerNewUser("tc003a@example.com");
        const timeouts = [
          (yield* passkey.registerOptions(userId, sessionId)).timeout,
          (yield* passkey.registerOptionsConditional(userId, sessionId)).timeout,
          (yield* passkey.authenticateOptions({})).options.timeout,
          (yield* passkey.reauthenticateOptions(userId, sessionId)).timeout,
        ];
        // The default is 4m30s, under BEH-EA-132's fixed five-minute challenge TTL.
        assert.deepStrictEqual(timeouts, [270_000, 270_000, 270_000, 270_000]);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a configured timeout, hints and extensions reach the port", () => {
    const registration: Array<WebAuthn.RegistrationOptionsInput> = [];
    const authentication: Array<WebAuthn.AuthenticationOptionsInput> = [];
    return Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("tc003b@example.com");
      yield* passkey.registerOptions(userId, sessionId);
      yield* passkey.authenticateOptions({});
      assert.strictEqual(Duration.toMillis(registration[0]?.timeout ?? Duration.zero), 120_000);
      assert.deepStrictEqual(registration[0]?.hints, ["security-key"]);
      assert.deepStrictEqual(registration[0]?.extensions, { credProps: true });
      assert.strictEqual(Duration.toMillis(authentication[0]?.timeout ?? Duration.zero), 120_000);
      assert.deepStrictEqual(authentication[0]?.hints, ["security-key"]);
    }).pipe(
      Effect.provide(
        buildLayer(
          mockWebAuthn({
            spy: { registrationOptions: registration, authenticationOptions: authentication },
          }),
          {
            ceremonyTimeout: Duration.seconds(120),
            hints: ["security-key"],
            extensions: { credProps: true },
          },
        ),
      ),
    );
  });

  it.effect("a ceremonyTimeout above the challenge TTL refuses to build the plugin", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* Passkey.Passkey;
        }).pipe(
          Effect.provide(buildLayer(mockWebAuthn(), { ceremonyTimeout: Duration.minutes(6) })),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("CB-009: Conditional Create under a required-UV policy", () => {
  it.effect("registerOptionsConditional answers PasskeyConditionalCreateDisabled", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* newUserSession("cb009@example.com");
      const failure = yield* passkey
        .registerOptionsConditional(userId, sessionId)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyConditionalCreateDisabled");
    }).pipe(
      Effect.provide(
        buildLayer(mockWebAuthn(), { authenticatorSelection: { userVerification: "required" } }),
      ),
    ),
  );
});

describe("HSK-003: browser-reported transports", () => {
  it.effect(
    "a registration posting transports persists them and echoes them in excludeCredentials",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* newUserSession("hsk003@example.com");
        const options = yield* passkey.registerOptions(userId, sessionId);
        const record = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options, id: "cred-usb", transports: ["usb", "nfc"] }),
        );
        assert.deepStrictEqual(record.transports, ["usb", "nfc"]);

        const next = yield* passkey.registerOptions(userId, sessionId);
        assert.deepStrictEqual(next.excludeCredentials, [
          { id: "cred-usb", type: "public-key", transports: ["usb", "nfc"] },
        ]);
        assert.isString(extractChallenge(next));
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("WPS-010: duplicate credential ids", () => {
  it.effect(
    "a second account registering an existing credential id is refused and links nothing",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const accounts = yield* Accounts.Accounts;
        const first = yield* registerNewUser("wps010a@example.com");
        const second = yield* newUserSession("wps010b@example.com");

        const options = yield* passkey.registerOptions(second.userId, second.sessionId);
        const failure = yield* passkey
          .registerVerify(
            second.userId,
            second.sessionId,
            registrationPayload({ options, id: "cred-mock-1" }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyAlreadyRegistered");

        // The original owner still owns the credential and its account link.
        const listed = yield* passkey.listCredentials(first.userId);
        assert.strictEqual(listed.length, 1);
        assert.strictEqual((yield* passkey.listCredentials(second.userId)).length, 0);
        const linked = yield* accounts.findByProviderSubject("passkey", "cred-mock-1");
        assert.isTrue(Option.isSome(linked) && linked.value.userId === first.userId);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});
