// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136.
//
// Real, in-memory domain-level tests (no HTTP layer here — see
// `AuthHttp.test.ts` for the wire-level equivalent, ticket 10): real
// `Users`/`Accounts`/`Sessions`/`AuthEvents`/`ChallengeStore`/
// `PasskeyCredentials`, `WebAuthn` stubbed via `Layer.mock` (BEH-EA-195) —
// this suite proves the plugin's own ceremony/persistence/enumeration-safety
// logic, not `@simplewebauthn/server`'s cryptography (that's
// `packages/ports/test/WebAuthn.test.ts`'s own job).
import {
  Accounts,
  AuditLog,
  Erasure,
  Persistence,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { SqlTransaction, type WebAuthn } from "@awthaq/ports";
import { SignInProbe } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import { buildLayer, registerNewUser } from "./passkeyTestLayers.ts";
import {
  ORIGIN,
  assertionCredential,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
  registrationPayload,
} from "./passkeyTestFixtures.ts";

const TestLayer = buildLayer(mockWebAuthn());

/** An erasure that runs the core cascade but none of the plugins' contributions: a deliberate orphan. */
const OrphaningErasure = Erasure.layer.pipe(
  // `Layer.fresh`: the composition's own registry (holding this plugin's contribution) is memoized by
  // reference and `Effect.provide` forks the current memo map, so without `fresh` it would be reused.
  Layer.provide(Layer.fresh(Erasure.registryLayer)),
  Layer.provide(Accounts.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provide(Verification.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provide(SqlTransaction.layerNoop),
);

describe("Passkey", () => {
  it.effect("BEH-EA-130/134: register/verify persists a credential and links an Accounts row", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;

      const user = yield* users.create({
        identity: { _tag: "Email", email: "ada@example.com" },
        name: "Ada",
      });
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

      const user = yield* users.create({
        identity: { _tag: "Email", email: "bo@example.com" },
        name: "Bo",
      });
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

  // ADR-EA-038: policy (gate, veto, divert, announcement) is tested once at `SignIn`; this proves the wiring.
  it.effect("ADR-EA-038 wiring: SignIn is handed strategy passkey and the assertion's amr", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const probe = yield* SignInProbe.SignInProbe;
      const { userId } = yield* registerNewUser("wiring@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      yield* passkey.authenticateVerify({
        ceremonyId,
        credential: assertionCredential({ options }),
      });
      const recorded = yield* probe.recorded;
      assert.deepStrictEqual(
        recorded.beforeSignIn.map((input) => [input.userId, input.email, input.strategy]),
        [[userId, "wiring@example.com", "passkey"]],
      );
      assert.deepStrictEqual(
        recorded.beforeSessionIssue.map((input) => [input.strategy, input.amr]),
        [["passkey", ["hwk", "user"]]],
      );
    }).pipe(Effect.provide(SignInProbe.layer.pipe(Layer.provideMerge(TestLayer)))),
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

  // CSD-003: the ceremony's request context is recorded on the issued session.
  it.effect("CSD-003: authenticateVerify records ip and userAgent from its context", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "csd003-passkey@example.com" },
        name: "C",
      });
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
      const issued = yield* passkey.authenticateVerify(
        {
          ip: "198.51.100.44",
          ceremonyId,
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
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
        },
        { userAgent: "PasskeyBrowser/1.0" },
      );
      // THS-003: a hardware-bound key, with user verification (the mock reports it).
      assert.deepStrictEqual(issued.session.amr, ["hwk", "user"]);
      assert.deepStrictEqual(issued.session.ipAddress, Option.some("198.51.100.44"));
      assert.deepStrictEqual(issued.session.userAgent, Option.some("PasskeyBrowser/1.0"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "WPS-001: a credential surviving its own deleted user cannot mint a session for that dead user",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;

        const user = yield* users.create({
          identity: { _tag: "Email", email: "ghost@example.com" },
          name: "Ghost",
        });
        const registerSession = yield* sessions.issue({ userId: user.id });
        const registerOptions = yield* passkey.registerOptions(user.id, registerSession.session.id);
        // `mockWebAuthn`'s `verifyRegistration` always reports
        // `credentialId: "cred-mock-1"` regardless of what's submitted
        // (see `passkeyTestFixtures.ts`), and `registerVerify` stores the
        // row under *that* id, not the submitted one — so the id used
        // below must match it, the same way every other test in this
        // file does, or `authenticateVerify` would fail on the earlier
        // "unknown credential" branch instead of the one this test means
        // to exercise.
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

        // The user row is gone, but the credential row is deliberately left untouched: the
        // cascade exists now (`Passkey`'s own erasure contribution), so the orphan this
        // defense-in-depth check exists for is produced on purpose, through an erasure that
        // runs the core rows and none of the plugins' contributions.
        yield* Erasure.AccountErasure.use((erasure) =>
          erasure.eraseAccount(user.id, Erasure.ErasureInitiator.Self()),
        ).pipe(Effect.provide(OrphaningErasure), Effect.orDie);

        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
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
        assert.strictEqual(failure._tag, "InvalidCredentials");
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
      const other = yield* users.create({
        identity: { _tag: "Email", email: "other@example.com" },
        name: "Other",
      });

      const failure = yield* passkey
        .renameCredential(other.id, "cred-mock-1", "Stolen")
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyCredentialNotFound");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Passkey — Conditional Create (ticket 07)", () => {
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
      const user = yield* users.create({
        identity: { _tag: "Email", email: "disabled@example.com" },
        name: "Disabled",
      });
      const issued = yield* sessions.issue({ userId: user.id });
      const failure = yield* passkey
        .registerOptionsConditional(user.id, issued.session.id)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyConditionalCreateDisabled");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { conditionalCreate: false }))),
  );
});

describe("Passkey — step-up reauthentication (ticket 15, BPAS-001/AAPS-001)", () => {
  it.effect("registerOptions refuses a stale session with PasskeyReauthRequired", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "stale-options@example.com" },
        name: "Stale",
      });
      const issued = yield* sessions.issue({ userId: user.id });

      // `PasskeyConfig.reauthMaxAgeSeconds` defaults to 5 minutes.
      yield* TestClock.adjust(Duration.minutes(6));

      const failure = yield* passkey.registerOptions(user.id, issued.session.id).pipe(Effect.flip);
      if (failure._tag !== "PasskeyReauthRequired") return assert.fail(failure._tag);
      assert.strictEqual(failure.maxAgeSeconds, 300);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("registerVerify refuses a stale session even with a valid completed ceremony", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "stale-verify@example.com" },
        name: "Stale",
      });
      const issued = yield* sessions.issue({ userId: user.id });
      const options = yield* passkey.registerOptions(user.id, issued.session.id);

      // Closes the window between fetching options while fresh and
      // presenting the completed ceremony after the session has since
      // gone stale.
      yield* TestClock.adjust(Duration.minutes(6));

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
      assert.strictEqual(failure._tag, "PasskeyReauthRequired");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "reauthenticateVerify refreshes authenticatedAt, unblocking a subsequently stale-gated enrollment",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* registerNewUser("stepup@example.com");

        yield* TestClock.adjust(Duration.minutes(6));

        const gated = yield* passkey.registerOptions(userId, sessionId).pipe(Effect.flip);
        assert.strictEqual(gated._tag, "PasskeyReauthRequired");

        const options = yield* passkey.reauthenticateOptions(userId, sessionId);
        yield* passkey.reauthenticateVerify(userId, sessionId, {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
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

        // The gate is now clear — same session, no new sign-in.
        yield* passkey.registerOptions(userId, sessionId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-319: reauthenticateVerify on a session that ended mid-request is Unauthenticated",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const sessions = yield* Sessions.Sessions;
        const { userId, sessionId } = yield* registerNewUser("ended@example.com");
        const options = yield* passkey.reauthenticateOptions(userId, sessionId);
        yield* sessions.revoke(Sessions.SessionId(sessionId), "signOut");

        const failure = yield* passkey
          .reauthenticateVerify(userId, sessionId, {
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
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
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Unauthenticated");
      }).pipe(Effect.provide(TestLayer)),
  );
});

/** A fresh user with a live session, ready to run a registration ceremony. */
const newUserSession = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    return { userId: user.id, sessionId: issued.session.id };
  });

// ---- BEH-EA-136: the posture of each endpoint -------------------------------------------------
//
// `PasskeyCeremony.test.ts` proves WHEN a ceremony refuses and why; these tables prove how each
// endpoint WORDS that refusal: one row per refusal reason its ceremony can produce.

const OTHER_ORIGIN = "https://other.test";
const EVIL = { origin: "https://evil.example" } as const;

describe("BEH-EA-136 posture: register/verify answers each ceremony refusal precisely", () => {
  interface Row {
    readonly reason: string;
    readonly expected: string;
    readonly layer: ReturnType<typeof buildLayer>;
    readonly spoil?: { readonly origin?: string; readonly challenge?: string };
  }
  const rows: ReadonlyArray<Row> = [
    {
      reason: "challenge",
      expected: "PasskeyChallengeInvalid",
      layer: buildLayer(mockWebAuthn()),
      spoil: { challenge: "never-issued" },
    },
    {
      reason: "origin",
      expected: "PasskeyOriginMismatch",
      layer: buildLayer(mockWebAuthn()),
      spoil: EVIL,
    },
    {
      reason: "rpId",
      expected: "PasskeyRpIdMismatch",
      layer: buildLayer(mockWebAuthn(), { origins: [ORIGIN, OTHER_ORIGIN] }),
      spoil: { origin: OTHER_ORIGIN },
    },
    {
      reason: "signature",
      expected: "PasskeyVerificationFailed",
      layer: buildLayer(mockWebAuthn({ fail: { registration: true } })),
    },
    {
      reason: "userVerification",
      expected: "PasskeyUserVerificationRequired",
      layer: buildLayer(mockWebAuthn({ registrationVerified: { userVerified: false } }), {
        authenticatorSelection: { userVerification: "required" },
      }),
    },
    {
      reason: "attestation",
      expected: "PasskeyAttestationRejected",
      layer: buildLayer(mockWebAuthn(), {
        attestationPolicy: { trustedAaguids: ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4"] },
      }),
    },
  ];
  for (const row of rows) {
    it.effect(`${row.reason} -> ${row.expected}`, () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* newUserSession(`posture-r-${row.reason}@example.com`);
        const options = yield* passkey.registerOptions(userId, sessionId);
        const failure = yield* passkey
          .registerVerify(
            userId,
            sessionId,
            registrationPayload({
              options:
                row.spoil?.challenge === undefined ? options : { challenge: row.spoil.challenge },
              ...(row.spoil?.origin === undefined ? {} : { origin: row.spoil.origin }),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, row.expected);
      }).pipe(Effect.provide(row.layer)),
    );
  }
});

/** One assertion posture row: how to provoke a reason through the endpoint, and what the wire says. */
interface AssertionRow {
  readonly reason: string;
  readonly expected: string;
  readonly layer: ReturnType<typeof buildLayer>;
  readonly spoil?: {
    readonly clientDataJSON?: string;
    readonly origin?: string;
    readonly id?: string;
    readonly userHandle?: string;
  };
  /** The stored counter, seeded after registration (for the counter-anomaly row). */
  readonly storedCounter?: number;
}
const assertionRows = (
  wording: Record<
    | "challenge"
    | "origin"
    | "rpId"
    | "unknownCredential"
    | "signature"
    | "userHandle"
    | "userVerification"
    | "counterAnomaly",
    string
  >,
): ReadonlyArray<AssertionRow> => [
  {
    reason: "challenge",
    expected: wording.challenge,
    layer: buildLayer(mockWebAuthn()),
    spoil: { clientDataJSON: "not base64url!" },
  },
  {
    reason: "origin",
    expected: wording.origin,
    layer: buildLayer(mockWebAuthn()),
    spoil: EVIL,
  },
  {
    reason: "rpId",
    expected: wording.rpId,
    layer: buildLayer(mockWebAuthn(), { origins: [ORIGIN, OTHER_ORIGIN] }),
    spoil: { origin: OTHER_ORIGIN },
  },
  {
    reason: "unknownCredential",
    expected: wording.unknownCredential,
    layer: buildLayer(mockWebAuthn()),
    spoil: { id: "no-such-credential" },
  },
  {
    reason: "signature",
    expected: wording.signature,
    layer: buildLayer(mockWebAuthn({ fail: { authentication: true } })),
  },
  {
    reason: "userHandle",
    expected: wording.userHandle,
    layer: buildLayer(mockWebAuthn()),
    spoil: { userHandle: "someone-elses" },
  },
  {
    reason: "userVerification",
    expected: wording.userVerification,
    layer: buildLayer(mockWebAuthn({ authenticationVerified: { userVerified: false } }), {
      authenticatorSelection: { userVerification: "required" },
    }),
  },
  {
    reason: "counterAnomaly",
    expected: wording.counterAnomaly,
    layer: buildLayer(mockWebAuthn(), { counterAnomalyPolicy: "reject" }),
    storedCounter: 5,
  },
];

describe("BEH-EA-136 posture: authenticate/verify collapses every refusal past the challenge into InvalidCredentials", () => {
  const rows = assertionRows({
    challenge: "PasskeyChallengeInvalid",
    origin: "InvalidCredentials",
    rpId: "InvalidCredentials",
    unknownCredential: "InvalidCredentials",
    signature: "InvalidCredentials",
    userHandle: "InvalidCredentials",
    userVerification: "PasskeyUserVerificationRequired",
    counterAnomaly: "PasskeyCounterAnomaly",
  });
  for (const row of rows) {
    it.effect(`${row.reason} -> ${row.expected}`, () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        yield* registerNewUser(`posture-a-${row.reason}@example.com`);
        if (row.storedCounter !== undefined) {
          yield* credentials.recordUsage("cred-mock-1", row.storedCounter, false);
        }
        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: assertionCredential({ options, ...row.spoil }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, row.expected);
      }).pipe(Effect.provide(row.layer)),
    );
  }
});

describe("BEH-EA-136 posture: reauthenticate/verify answers precisely", () => {
  const rows = assertionRows({
    challenge: "PasskeyChallengeInvalid",
    origin: "PasskeyOriginMismatch",
    rpId: "PasskeyRpIdMismatch",
    unknownCredential: "PasskeyCredentialNotFound",
    signature: "PasskeyVerificationFailed",
    userHandle: "PasskeyVerificationFailed",
    userVerification: "PasskeyUserVerificationRequired",
    counterAnomaly: "PasskeyCounterAnomaly",
  });
  for (const row of rows) {
    it.effect(`${row.reason} -> ${row.expected}`, () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const { userId, sessionId } = yield* registerNewUser(`posture-s-${row.reason}@example.com`);
        if (row.storedCounter !== undefined) {
          yield* credentials.recordUsage("cred-mock-1", row.storedCounter, false);
        }
        const options = yield* passkey.reauthenticateOptions(userId, sessionId);
        const failure = yield* passkey
          .reauthenticateVerify(userId, sessionId, {
            credential: assertionCredential({ options, ...row.spoil }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, row.expected);
      }).pipe(Effect.provide(row.layer)),
    );
  }

  it.effect("a credential owned by another user is PasskeyCredentialNotFound", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      yield* registerNewUser("posture-owner@example.com");
      const other = yield* newUserSession("posture-other@example.com");
      const options = yield* passkey.reauthenticateOptions(other.userId, other.sessionId);
      // `cred-mock-1` belongs to the first user, not `other`.
      const failure = yield* passkey
        .reauthenticateVerify(other.userId, other.sessionId, {
          credential: assertionCredential({ options }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyCredentialNotFound");
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---- admission: refused BEFORE the attempt starts, so the challenge survives (BEH-EA-132) -------

describe("BEH-EA-132/255 admission: a register/verify refused for a stale session leaves the challenge usable", () => {
  it.effect("once a step-up discharges the gate, the same response is verified", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* registerNewUser("admission-stale@example.com");
      const options = yield* passkey.registerOptions(userId, sessionId);
      // The gate is one minute here, so the stale session is still inside the challenge's five-minute TTL.
      yield* TestClock.adjust(Duration.minutes(2));

      const payload = registrationPayload({ options, id: "cred-second" });
      const gated = yield* passkey.registerVerify(userId, sessionId, payload).pipe(Effect.flip);
      assert.strictEqual(gated._tag, "PasskeyReauthRequired");

      const stepUp = yield* passkey.reauthenticateOptions(userId, sessionId);
      yield* passkey.reauthenticateVerify(userId, sessionId, {
        credential: assertionCredential({ options: stepUp }),
      });

      // The refused attempt never started: its challenge is still good.
      const record = yield* passkey.registerVerify(userId, sessionId, payload);
      assert.strictEqual(record.id, "cred-second");
    }).pipe(
      Effect.provide(buildLayer(mockWebAuthn(), { reauthMaxAgeSeconds: Duration.minutes(1) })),
    ),
  );
});

// ---- options-side and boot-time policy (moved from the old ceremony suite) -------------------

describe("TC-008: related origins at boot", () => {
  it.effect("the layer refuses to build with a related origin that is not an https origin", () =>
    Effect.gen(function* () {
      for (const bad of ["http://example.co.uk", "https://example.co.uk/path", "example.co.uk"]) {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            yield* Passkey.Passkey;
          }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { relatedOrigins: [bad] }))),
        );
        assert.isTrue(Exit.isFailure(exit), `${bad} should be refused`);
      }
    }),
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
