// spec/behaviors/17-passkey.md, BEH-EA-130..133, 135, 136, 256, 257 (plan 12).
//
// `PasskeyCeremony` at its own interface: registration (modal and conditional), sign-in and step-up
// answer a verified credential or a refusal *reason*; how an endpoint words that reason is its posture,
// tested at the plugin (`Passkey.test.ts`). No `Users`, no `Sessions`, no `TestAuth`: the stores are
// `Passkey.Passkey.records.memory` / `.sql`, credentials are seeded directly, and only the `WebAuthn`
// port is mocked (BEH-EA-195), with a spy on what the ceremony asks of it.
import { AuditLog, AuthEvents, Errors, Migrations, Persistence, Users } from "@awthaq/core";
import type { WebAuthn } from "@awthaq/ports";
import { Rendezvous, TestSql } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCeremony from "../src/PasskeyCeremony.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import {
  ORIGIN,
  RP_ID,
  assertionCredential,
  mockWebAuthn,
  registrationPayload,
} from "./passkeyTestFixtures.ts";

const ANDROID_ORIGIN = "android:apk-key-hash:5Rzx8dDZ6lOZ0B1c1tYy4C3JdW0e8xZ2rQKq3Q4mVv8";
const RELATED = "https://example.co.uk";
const OTHER_ORIGIN = "https://other.test";

// ---- composition: the stores beneath the module, and the mocked port ----

const SqlLive = TestSql.layer("passkey_PasskeyCeremony");
const Migrated = Layer.effectDiscard(Migrations.run(Passkey.Passkey.migrations)).pipe(
  Layer.provide(SqlLive),
);
const sqlRecords = Passkey.Passkey.records.sql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const legs = [
  ["memory", Passkey.Passkey.records.memory],
  ["sql", sqlRecords],
] as const;

/** The records bundle, the mocked port, and what `PasskeyCeremony.make` itself reads (`AuthEvents`). */
const ceremonyLayer = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  records: (typeof legs)[number][1] = Passkey.Passkey.records.memory,
) =>
  Layer.mergeAll(records, webAuthn).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(NodeCrypto.layer),
  );

const policyOf = (
  overrides?: Partial<PasskeyCeremony.CeremonyPolicy>,
): PasskeyCeremony.CeremonyPolicy => ({
  rpId: RP_ID,
  origins: [ORIGIN],
  allowedTopOrigins: [],
  relatedOrigins: [],
  authenticatorSelection: { userVerification: "preferred" },
  counterAnomalyPolicy: "flag",
  ...overrides,
});

// ---- the four ceremony kinds, arranged against real stores ----

type Kind = "modal" | "conditional" | "signIn" | "stepUp";
const KINDS: ReadonlyArray<Kind> = ["modal", "conditional", "signIn", "stepUp"];
const ASSERTIONS: ReadonlyArray<Kind> = ["signIn", "stepUp"];
const isAssertion = (kind: Kind) => kind === "signIn" || kind === "stepUp";

let sequence = 0;

const seed = (input: {
  readonly id: string;
  readonly userId: Users.UserId;
  readonly webauthnUserId: string;
  readonly counter?: number;
}) =>
  PasskeyCredentials.PasskeyCredentials.use((store) =>
    store.create({
      id: input.id,
      userId: input.userId,
      webauthnUserId: input.webauthnUserId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: input.counter ?? 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: [],
      aaguid: "00000000-0000-0000-0000-000000000000",
      name: "Passkey",
    }),
  );

/** What a test presents on top of a well-formed response; absent members are the honest ones. */
interface Spoil {
  readonly clientDataJSON?: string;
  readonly origin?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
  readonly userHandle?: string;
  /** The credential id the browser presents (defaults to the seeded one). */
  readonly id?: string;
}

/**
 * One ceremony of `kind` with its challenge issued. Assertion kinds get a seeded credential owned by
 * `owner` (default: the ceremony's own user; step-up only accepts the caller's).
 */
const arrange = (kind: Kind, options?: { readonly counter?: number; readonly owner?: string }) =>
  Effect.gen(function* () {
    const n = ++sequence;
    const ceremonies = yield* PasskeyCeremony.make;
    const userId = Users.UserId(`u-${n}`);
    const credentialId = `cred-${n}`;
    const webauthnUserId = `h-${n}`;
    const ceremony: PasskeyCeremony.Ceremony =
      kind === "modal"
        ? PasskeyCeremony.Ceremony.Registration({ sessionId: `s-${n}`, mode: "modal" })
        : kind === "conditional"
          ? PasskeyCeremony.Ceremony.Registration({ sessionId: `s-${n}`, mode: "conditional" })
          : kind === "signIn"
            ? PasskeyCeremony.Ceremony.SignIn({ ceremonyId: `c-${n}` })
            : PasskeyCeremony.Ceremony.StepUp({ sessionId: `s-${n}`, userId });
    if (isAssertion(kind)) {
      yield* seed({
        id: credentialId,
        userId: Users.UserId(options?.owner ?? `u-${n}`),
        webauthnUserId,
        ...(options?.counter === undefined ? {} : { counter: options.counter }),
      });
    }
    const challenge = Redacted.value(yield* ceremonies.begin(ceremony));
    return { ceremonies, ceremony, userId, credentialId, webauthnUserId, challenge };
  });
type Arranged = Effect.Success<ReturnType<typeof arrange>>;

/** Presents the arranged ceremony's response (optionally spoiled), answering the refusal reason, or `"verified"`. */
const reasonOf = (arranged: Arranged, policy: PasskeyCeremony.CeremonyPolicy, spoil?: Spoil) => {
  const options = { challenge: arranged.challenge };
  const id = spoil?.id ?? arranged.credentialId;
  const ceremony = arranged.ceremony;
  if (ceremony._tag === "Registration") {
    return arranged.ceremonies
      .verifyRegistration({
        ceremony,
        credential: registrationPayload({ options, ...spoil, id }).credential,
        policy,
      })
      .pipe(
        Effect.as("verified"),
        Effect.catchTag("PasskeyCeremony/RegistrationRefused", (refused) =>
          Effect.succeed<string>(refused.reason),
        ),
      );
  }
  return arranged.ceremonies
    .verifyAssertion({
      ceremony,
      credential: assertionCredential({ options, ...spoil, id }),
      policy,
    })
    .pipe(
      Effect.as("verified"),
      Effect.catchTag("PasskeyCeremony/AssertionRefused", (refused) =>
        Effect.succeed<string>(refused.reason),
      ),
    );
};

/** Verifies an arranged assertion ceremony and answers the verified value. */
const assertionOf = (arranged: Arranged, policy: PasskeyCeremony.CeremonyPolicy) => {
  const ceremony = arranged.ceremony;
  if (ceremony._tag === "Registration") return Effect.die(new Error("not an assertion ceremony"));
  return arranged.ceremonies
    .verifyAssertion({
      ceremony,
      credential: assertionCredential({
        options: { challenge: arranged.challenge },
        id: arranged.credentialId,
      }),
      policy,
    })
    .pipe(Effect.catchTag("PasskeyCeremony/AssertionRefused", Effect.die));
};

/** The refusal reason of a failed ceremony (or the tag of an outage). */
const reasonFrom = <
  A,
  R extends PasskeyCeremony.RegistrationRefused | PasskeyCeremony.AssertionRefused,
>(
  self: Effect.Effect<A, PasskeyCeremony.CeremonyFailure<R>>,
) =>
  self.pipe(
    Effect.flip,
    Effect.map((failure) => ("reason" in failure ? failure.reason : failure._tag)),
  );

/** A fresh challenge for the same ceremony and credential (the next attempt of a multi-attempt test). */
const reissue = (arranged: Arranged) =>
  arranged.ceremonies
    .begin(arranged.ceremony)
    .pipe(Effect.map((challenge) => ({ ...arranged, challenge: Redacted.value(challenge) })));

const storedCredential = (id: string) =>
  PasskeyCredentials.PasskeyCredentials.use((store) => store.findById(id)).pipe(
    Effect.flatMap((found) =>
      Option.isNone(found)
        ? Effect.die(new Error("credential vanished"))
        : Effect.succeed(found.value),
    ),
  );

// ---- A. BEH-EA-132: the step order ----

describe("BEH-EA-132: every attempt spends its challenge first", () => {
  interface Spoiler {
    readonly spoil?: Spoil;
    readonly expected: string;
    readonly policy?: Partial<PasskeyCeremony.CeremonyPolicy>;
    readonly failSignature?: boolean;
    readonly kinds?: ReadonlyArray<Kind>;
  }
  const spoilers: Record<string, Spoiler> = {
    "unreadable client data": {
      spoil: { clientDataJSON: "not base64url!" },
      expected: "challenge",
    },
    "an origin outside origins": { spoil: { origin: "https://evil.example" }, expected: "origin" },
    "a listed origin outside rpId": {
      spoil: { origin: OTHER_ORIGIN },
      expected: "rpId",
      policy: { origins: [ORIGIN, OTHER_ORIGIN] },
    },
    "an embedded ceremony nobody allowed": {
      spoil: { crossOrigin: true, topOrigin: "https://evil.example" },
      expected: "origin",
    },
    "a refused signature": { expected: "signature", failSignature: true },
    "an unknown credential": {
      spoil: { id: "cred-nobody" },
      expected: "unknownCredential",
      kinds: ASSERTIONS,
    },
  };

  for (const [leg, records] of legs) {
    for (const kind of KINDS) {
      for (const [name, row] of Object.entries(spoilers)) {
        if (row.kinds !== undefined && !row.kinds.includes(kind)) continue;
        it.effect(`${leg}: ${kind} refused for ${name} spends the challenge`, () =>
          Effect.gen(function* () {
            const policy = policyOf(row.policy);
            const first = yield* arrange(kind);
            assert.strictEqual(yield* reasonOf(first, policy, row.spoil), row.expected);
            // The very same challenge, now honest: BEH-EA-132 says it is gone.
            assert.strictEqual(yield* reasonOf(first, policy), "challenge");
          }).pipe(
            Effect.provide(
              ceremonyLayer(
                mockWebAuthn({
                  fail: {
                    registration: row.failSignature === true,
                    authentication: row.failSignature === true,
                  },
                }),
                records,
              ),
            ),
          ),
        );
      }
    }
  }

  it.effect("an unreadable client data names no challenge yet still spends the scope", () =>
    Effect.gen(function* () {
      const challenges = yield* ChallengeStore.ChallengeStore;
      for (const kind of KINDS) {
        const arranged = yield* arrange(kind);
        assert.strictEqual(
          yield* reasonOf(arranged, policyOf(), { clientDataJSON: "%%%" }),
          "challenge",
        );
        const scope = PasskeyCeremony.scopeOf(arranged.ceremony);
        assert.isFalse(yield* challenges.consume(scope, arranged.challenge));
      }
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it.effect(
    "WPS-003: a conditional challenge presented as modal is refused, and only the addressed modal scope is spent",
    () =>
      Effect.gen(function* () {
        const ceremonies = yield* PasskeyCeremony.make;
        const modal = PasskeyCeremony.Ceremony.Registration({ sessionId: "s-wps", mode: "modal" });
        const conditional = PasskeyCeremony.Ceremony.Registration({
          sessionId: "s-wps",
          mode: "conditional",
        });
        const modalChallenge = Redacted.value(yield* ceremonies.begin(modal));
        const conditionalChallenge = Redacted.value(yield* ceremonies.begin(conditional));
        const verify = (ceremony: PasskeyCeremony.Registration, challenge: string, id: string) =>
          ceremonies.verifyRegistration({
            ceremony,
            credential: registrationPayload({ options: { challenge }, id }).credential,
            policy: policyOf(),
          });

        // The conditional challenge answers only the conditional ceremony.
        assert.strictEqual(
          yield* reasonFrom(verify(modal, conditionalChallenge, "cred-w1")),
          "challenge",
        );
        // The probe addressed (and so spent) the modal scope only: the conditional challenge it
        // carried is still good for the conditional ceremony.
        const verified = yield* verify(conditional, conditionalChallenge, "cred-w2");
        assert.strictEqual(verified.credentialId, "cred-w2");
        assert.isFalse(
          yield* (yield* ChallengeStore.ChallengeStore).consume(
            PasskeyCeremony.scopeOf(modal),
            modalChallenge,
          ),
        );
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it.effect("WPS-003: completing a conditional ceremony leaves a modal challenge usable", () =>
    Effect.gen(function* () {
      const ceremonies = yield* PasskeyCeremony.make;
      const modal = PasskeyCeremony.Ceremony.Registration({ sessionId: "s-wps2", mode: "modal" });
      const conditional = PasskeyCeremony.Ceremony.Registration({
        sessionId: "s-wps2",
        mode: "conditional",
      });
      const modalChallenge = Redacted.value(yield* ceremonies.begin(modal));
      const conditionalChallenge = Redacted.value(yield* ceremonies.begin(conditional));
      const verify = (ceremony: PasskeyCeremony.Registration, challenge: string, id: string) =>
        ceremonies.verifyRegistration({
          ceremony,
          credential: registrationPayload({ options: { challenge }, id }).credential,
          policy: policyOf(),
        });
      yield* verify(conditional, conditionalChallenge, "cred-w4");
      const record = yield* verify(modal, modalChallenge, "cred-w5");
      assert.strictEqual(record.credentialId, "cred-w5");
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it.effect("a sign-in challenge never satisfies a step-up, and a step-up's never a sign-in", () =>
    Effect.gen(function* () {
      const ceremonies = yield* PasskeyCeremony.make;
      const userId = Users.UserId("u-disjoint");
      yield* seed({ id: "cred-disjoint", userId, webauthnUserId: "h-disjoint" });
      const signIn = PasskeyCeremony.Ceremony.SignIn({ ceremonyId: "shared" });
      const stepUp = PasskeyCeremony.Ceremony.StepUp({ sessionId: "shared", userId });
      const signInChallenge = Redacted.value(yield* ceremonies.begin(signIn));
      const stepUpChallenge = Redacted.value(yield* ceremonies.begin(stepUp));
      const verify = (ceremony: PasskeyCeremony.Assertion, challenge: string) =>
        ceremonies.verifyAssertion({
          ceremony,
          credential: assertionCredential({ options: { challenge }, id: "cred-disjoint" }),
          policy: policyOf(),
        });
      assert.strictEqual(yield* reasonFrom(verify(stepUp, signInChallenge)), "challenge");
      assert.strictEqual(yield* reasonFrom(verify(signIn, stepUpChallenge)), "challenge");
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it("scopeOf answers the four persisted scope strings exactly", () => {
    const { Ceremony, scopeOf } = PasskeyCeremony;
    const userId = Users.UserId("u");
    assert.strictEqual(
      scopeOf(Ceremony.Registration({ sessionId: "s", mode: "modal" })),
      "passkey.register:s",
    );
    assert.strictEqual(
      scopeOf(Ceremony.Registration({ sessionId: "s", mode: "conditional" })),
      "passkey.register.conditional:s",
    );
    assert.strictEqual(scopeOf(Ceremony.SignIn({ ceremonyId: "c" })), "passkey.authenticate:c");
    assert.strictEqual(
      scopeOf(Ceremony.StepUp({ sessionId: "s", userId })),
      "passkey.reauthenticate:s",
    );
  });

  it.effect("the port is never called for a refused challenge or origin", () => {
    const registration: Array<WebAuthn.VerifyRegistrationInput> = [];
    const authentication: Array<WebAuthn.VerifyAuthenticationInput> = [];
    return Effect.gen(function* () {
      for (const kind of KINDS) {
        const arranged = yield* arrange(kind);
        yield* reasonOf(arranged, policyOf(), { origin: "https://evil.example" });
        yield* reasonOf(arranged, policyOf()); // the challenge is gone now
      }
      assert.deepStrictEqual(registration, []);
      assert.deepStrictEqual(authentication, []);
    }).pipe(
      Effect.provide(
        ceremonyLayer(
          mockWebAuthn({
            spy: { verifyRegistration: registration, verifyAuthentication: authentication },
          }),
        ),
      ),
    );
  });
});

// ---- B. BEH-EA-133: one origin policy ----

describe("BEH-EA-133: one origin policy for every kind", () => {
  for (const kind of KINDS) {
    it.effect(
      `${kind}: an exact configured origin is verified; a scheme or port variant refuses "origin"`,
      () =>
        Effect.gen(function* () {
          const policy = policyOf();
          assert.strictEqual(yield* reasonOf(yield* arrange(kind), policy), "verified");
          for (const origin of ["http://example.com", "https://example.com:8443"]) {
            assert.strictEqual(yield* reasonOf(yield* arrange(kind), policy, { origin }), "origin");
          }
        }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(`${kind}: a listed origin outside rpId refuses "rpId"; a subdomain is verified`, () =>
      Effect.gen(function* () {
        const policy = policyOf({ origins: [ORIGIN, OTHER_ORIGIN, "https://app.example.com"] });
        assert.strictEqual(
          yield* reasonOf(yield* arrange(kind), policy, { origin: OTHER_ORIGIN }),
          "rpId",
        );
        assert.strictEqual(
          yield* reasonOf(yield* arrange(kind), policy, { origin: "https://app.example.com" }),
          "verified",
        );
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(
      `${kind}: CB-003 crossOrigin with no topOrigin, or an unlisted one, refuses "origin"`,
      () =>
        Effect.gen(function* () {
          const policy = policyOf({ allowedTopOrigins: ["https://embedder.example"] });
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policy, { crossOrigin: true }),
            "origin",
          );
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policy, {
              crossOrigin: true,
              topOrigin: "https://evil.example",
            }),
            "origin",
          );
        }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(`${kind}: CB-003 an allowed top origin is verified`, () =>
      Effect.gen(function* () {
        const policy = policyOf({ allowedTopOrigins: ["https://embedder.example"] });
        assert.strictEqual(
          yield* reasonOf(yield* arrange(kind), policy, {
            crossOrigin: true,
            topOrigin: "https://embedder.example",
          }),
          "verified",
        );
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(
      `${kind}: MNA-007 a listed android:apk-key-hash origin is verified (exempt from rpId); an unlisted one refuses "origin"`,
      () =>
        Effect.gen(function* () {
          const policy = policyOf({ origins: [ORIGIN, ANDROID_ORIGIN] });
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policy, { origin: ANDROID_ORIGIN }),
            "verified",
          );
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policy, {
              origin: "android:apk-key-hash:someone-elses",
            }),
            "origin",
          );
        }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(
      `${kind}: TC-008 by default a related origin refuses "origin"; configured, it is verified and exempt from rpId`,
      () =>
        Effect.gen(function* () {
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policyOf(), { origin: RELATED }),
            "origin",
          );
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policyOf({ relatedOrigins: [RELATED] }), {
              origin: RELATED,
            }),
            "verified",
          );
        }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(`${kind}: TC-008 a related origin is not an allowed top origin`, () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* reasonOf(yield* arrange(kind), policyOf({ relatedOrigins: [RELATED] }), {
            origin: RELATED,
            crossOrigin: true,
            topOrigin: RELATED,
          }),
          "origin",
        );
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );
  }

  it.effect(
    "CB-003: an assertion forwards the allowed top origins to the port; a non-embedded ceremony none",
    () => {
      const authentication: Array<WebAuthn.VerifyAuthenticationInput> = [];
      return Effect.gen(function* () {
        const embedded = policyOf({ allowedTopOrigins: ["https://embedder.example"] });
        yield* reasonOf(yield* arrange("signIn"), embedded, {
          crossOrigin: true,
          topOrigin: "https://embedder.example",
        });
        assert.deepStrictEqual(authentication[0]?.expectedTopOrigin, ["https://embedder.example"]);
        yield* reasonOf(yield* arrange("signIn"), policyOf());
        assert.isUndefined(authentication[1]?.expectedTopOrigin);
      }).pipe(
        Effect.provide(
          ceremonyLayer(mockWebAuthn({ spy: { verifyAuthentication: authentication } })),
        ),
      );
    },
  );

  it.effect("TC-008: the port is told to expect the origins and the related origins", () => {
    const registration: Array<WebAuthn.VerifyRegistrationInput> = [];
    const authentication: Array<WebAuthn.VerifyAuthenticationInput> = [];
    return Effect.gen(function* () {
      const policy = policyOf({ relatedOrigins: [RELATED] });
      yield* reasonOf(yield* arrange("modal"), policy, { origin: RELATED });
      yield* reasonOf(yield* arrange("signIn"), policy, { origin: RELATED });
      for (const expected of [registration[0]?.expectedOrigin, authentication[0]?.expectedOrigin]) {
        assert.include(expected ?? [], RELATED);
        assert.include(expected ?? [], ORIGIN);
      }
    }).pipe(
      Effect.provide(
        ceremonyLayer(
          mockWebAuthn({
            spy: { verifyRegistration: registration, verifyAuthentication: authentication },
          }),
        ),
      ),
    );
  });

  it("TC-008: only exact https origins are related origins", () => {
    assert.isTrue(PasskeyCeremony.isHttpsOrigin("https://example.co.uk"));
    assert.isTrue(PasskeyCeremony.isHttpsOrigin("https://example.co.uk:8443"));
    for (const bad of ["http://example.co.uk", "https://example.co.uk/path", "example.co.uk"]) {
      assert.isFalse(PasskeyCeremony.isHttpsOrigin(bad), bad);
    }
  });
});

// ---- C. Registration (BEH-EA-130/135/256) ----

describe("Registration", () => {
  it.effect("CB-002: modal asks the port for user presence, conditional does not", () => {
    const spy: Array<WebAuthn.VerifyRegistrationInput> = [];
    return Effect.gen(function* () {
      yield* reasonOf(yield* arrange("modal"), policyOf());
      yield* reasonOf(yield* arrange("conditional"), policyOf());
      assert.deepStrictEqual(
        spy.map((call) => call.requireUserPresence),
        [true, false],
      );
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn({ spy: { verifyRegistration: spy } }))));
  });

  it.effect(
    'CB-002: a modal response without user presence refuses "signature"; a conditional one with UP=0/UV=0 is verified',
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* reasonOf(yield* arrange("modal"), policyOf()), "signature");
        assert.strictEqual(yield* reasonOf(yield* arrange("conditional"), policyOf()), "verified");
      }).pipe(
        Effect.provide(
          ceremonyLayer(
            mockWebAuthn({ registrationVerified: { userPresent: false, userVerified: false } }),
          ),
        ),
      ),
  );

  it.effect(
    'CB-001: UV=0 is verified under "preferred" and refuses "userVerification" under "required", in both modes',
    () =>
      Effect.gen(function* () {
        for (const kind of ["modal", "conditional"] as const) {
          assert.strictEqual(yield* reasonOf(yield* arrange(kind), policyOf()), "verified");
          assert.strictEqual(
            yield* reasonOf(
              yield* arrange(kind),
              policyOf({ authenticatorSelection: { userVerification: "required" } }),
            ),
            "userVerification",
          );
        }
      }).pipe(
        Effect.provide(
          ceremonyLayer(mockWebAuthn({ registrationVerified: { userVerified: false } })),
        ),
      ),
  );

  const aaguid = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";

  it.effect('HSK-002: with a policy, a "none" attestation refuses "attestation"', () =>
    Effect.gen(function* () {
      const policy = policyOf({ attestationPolicy: { trustedAaguids: [aaguid] } });
      assert.strictEqual(yield* reasonOf(yield* arrange("modal"), policy), "attestation");
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it.effect(
    "HSK-002: a certificate attestation from a listed AAGUID is verified, case-insensitively; an unlisted one refuses",
    () =>
      Effect.gen(function* () {
        const listed = policyOf({ attestationPolicy: { trustedAaguids: [aaguid.toUpperCase()] } });
        assert.strictEqual(yield* reasonOf(yield* arrange("modal"), listed), "verified");
        const unlisted = policyOf({
          attestationPolicy: { trustedAaguids: ["00000000-0000-0000-0000-0000000000ff"] },
        });
        assert.strictEqual(yield* reasonOf(yield* arrange("modal"), unlisted), "attestation");
      }).pipe(
        Effect.provide(
          ceremonyLayer(
            mockWebAuthn({ registrationVerified: { attestationType: "certificate", aaguid } }),
          ),
        ),
      ),
  );

  it.effect(
    "HSK-002: a self-attestation refuses by default and is verified with rejectSelfAttestation: false",
    () =>
      Effect.gen(function* () {
        const byDefault = policyOf({ attestationPolicy: { trustedAaguids: [aaguid] } });
        assert.strictEqual(yield* reasonOf(yield* arrange("modal"), byDefault), "attestation");
        const allowed = policyOf({
          attestationPolicy: { trustedAaguids: [aaguid], rejectSelfAttestation: false },
        });
        assert.strictEqual(yield* reasonOf(yield* arrange("modal"), allowed), "verified");
      }).pipe(
        Effect.provide(
          ceremonyLayer(
            mockWebAuthn({ registrationVerified: { attestationType: "self", aaguid } }),
          ),
        ),
      ),
  );

  it.effect("BEH-EA-135: with no policy nothing about the attestation is enforced", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(yield* arrange("modal"), policyOf()), "verified");
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
  );

  it.effect("HSK-003: transports the plugin does not recognise never reach the port", () => {
    const spy: Array<WebAuthn.VerifyRegistrationInput> = [];
    return Effect.gen(function* () {
      const arranged = yield* arrange("modal");
      if (arranged.ceremony._tag !== "Registration") return;
      const base = registrationPayload({
        options: { challenge: arranged.challenge },
        id: arranged.credentialId,
      }).credential;
      yield* arranged.ceremonies.verifyRegistration({
        ceremony: arranged.ceremony,
        credential: {
          ...base,
          response: { ...base.response, transports: ["usb", "carrier-pigeon", "internal"] },
        },
        policy: policyOf(),
      });
      assert.deepStrictEqual(spy[0]?.response.response.transports, ["usb", "internal"]);
    }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn({ spy: { verifyRegistration: spy } }))));
  });
});

// ---- D. Assertions (BEH-EA-131/136/257/258) ----

describe("Assertions", () => {
  for (const kind of ASSERTIONS) {
    it.effect(
      `TSS-004: ${kind}: an unknown credential costs exactly one verification, against the decoy key, then refuses "unknownCredential"`,
      () => {
        const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
        return Effect.gen(function* () {
          const arranged = yield* arrange(kind);
          assert.strictEqual(
            yield* reasonOf(arranged, policyOf(), { id: "cred-nobody" }),
            "unknownCredential",
          );
          assert.strictEqual(spy.length, 1);
          assert.isAbove(spy[0]?.credential.publicKey.length ?? 0, 0);
          assert.notStrictEqual(spy[0]?.credential.id, "cred-nobody");
        }).pipe(
          Effect.provide(ceremonyLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }))),
        );
      },
    );

    it.effect(
      `TSS-004: ${kind}: a usable credential's bad signature costs one verification and refuses "signature"`,
      () => {
        const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
        return Effect.gen(function* () {
          assert.strictEqual(yield* reasonOf(yield* arrange(kind), policyOf()), "signature");
          assert.strictEqual(spy.length, 1);
        }).pipe(
          Effect.provide(
            ceremonyLayer(
              mockWebAuthn({ fail: { authentication: true }, spy: { verifyAuthentication: spy } }),
            ),
          ),
        );
      },
    );

    it.effect(
      `BPAS-003: ${kind}: a matching userHandle, and an absent one, are verified; a different one refuses "userHandle"`,
      () =>
        Effect.gen(function* () {
          const arranged = yield* arrange(kind);
          assert.strictEqual(
            yield* reasonOf(arranged, policyOf(), { userHandle: arranged.webauthnUserId }),
            "verified",
          );
          assert.strictEqual(yield* reasonOf(yield* arrange(kind), policyOf()), "verified");
          assert.strictEqual(
            yield* reasonOf(yield* arrange(kind), policyOf(), { userHandle: "someone-elses" }),
            "userHandle",
          );
        }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );

    it.effect(`HSK-005: ${kind}: amr is [hwk, user] for a device-bound key with UV`, () =>
      Effect.gen(function* () {
        const verified: PasskeyCeremony.VerifiedAssertion = yield* assertionOf(
          yield* arrange(kind),
          policyOf(),
        );
        assert.deepStrictEqual(verified.amr, ["hwk", "user"]);
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
    );
  }

  it.effect("HSK-005: amr is [swk] for a synced key without UV (sign-in)", () =>
    Effect.gen(function* () {
      const verified = yield* assertionOf(yield* arrange("signIn"), policyOf());
      assert.deepStrictEqual(verified.amr, ["swk"]);
    }).pipe(
      Effect.provide(
        ceremonyLayer(
          mockWebAuthn({
            authenticationVerified: { credentialDeviceType: "multiDevice", userVerified: false },
          }),
        ),
      ),
    ),
  );

  it.effect(
    'ticket 15: at step-up, a credential owned by another user is "unknownCredential", after the same decoy verification; at sign-in it is verified',
    () => {
      const spy: Array<WebAuthn.VerifyAuthenticationInput> = [];
      return Effect.gen(function* () {
        const foreign = yield* arrange("stepUp", { owner: "u-somebody-else" });
        assert.strictEqual(yield* reasonOf(foreign, policyOf()), "unknownCredential");
        assert.strictEqual(spy.length, 1);
        assert.notStrictEqual(spy[0]?.credential.id, foreign.credentialId);
        // Sign-in may use any registered credential.
        assert.strictEqual(
          yield* reasonOf(yield* arrange("signIn", { owner: "u-somebody-else" }), policyOf()),
          "verified",
        );
      }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn({ spy: { verifyAuthentication: spy } }))));
    },
  );

  it.effect(
    'BEH-EA-131: sign-in refuses "userVerification" with UV=0 under "required" and verifies it under "preferred"; step-up refuses UV=0 always',
    () =>
      Effect.gen(function* () {
        const required = policyOf({ authenticatorSelection: { userVerification: "required" } });
        assert.strictEqual(yield* reasonOf(yield* arrange("signIn"), policyOf()), "verified");
        assert.strictEqual(yield* reasonOf(yield* arrange("signIn"), required), "userVerification");
        for (const policy of [policyOf(), required]) {
          assert.strictEqual(yield* reasonOf(yield* arrange("stepUp"), policy), "userVerification");
        }
      }).pipe(
        Effect.provide(
          ceremonyLayer(mockWebAuthn({ authenticationVerified: { userVerified: false } })),
        ),
      ),
  );

  // The mocked port always reports newCounter 1 unless told otherwise: a regression against a stored 5.
  describe("CB-004/WPS-006: the counter policy", () => {
    for (const kind of ASSERTIONS) {
      it.effect(
        `flag: ${kind}: a regression is verified, publishes the event once, flags the credential and keeps the stored counter`,
        () =>
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            const arranged = yield* arrange(kind, { counter: 5 });
            const seen = yield* Effect.forkChild(
              events.stream.pipe(
                Stream.filter((event) => event._tag === "auth.passkey.counterAnomaly"),
                Stream.take(1),
                Stream.runCollect,
              ),
              { startImmediately: true },
            );
            assert.strictEqual(yield* reasonOf(arranged, policyOf()), "verified");
            assert.strictEqual((yield* Fiber.join(seen)).length, 1);
            const stored = yield* storedCredential(arranged.credentialId);
            assert.isTrue(Option.isSome(stored.counterAnomalyAt));
            assert.strictEqual(stored.counterAnomalyCount, 1);
            assert.strictEqual(stored.counter, 5);
          }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
      );

      it.effect(
        `reject: ${kind}: a regression refuses "counterAnomaly", flags the credential, keeps the counter and records no usage`,
        () =>
          Effect.gen(function* () {
            const arranged = yield* arrange(kind, { counter: 5 });
            const before = yield* storedCredential(arranged.credentialId);
            yield* TestClock.adjust(Duration.seconds(10));
            assert.strictEqual(
              yield* reasonOf(arranged, policyOf({ counterAnomalyPolicy: "reject" })),
              "counterAnomaly",
            );
            const stored = yield* storedCredential(arranged.credentialId);
            assert.isTrue(Option.isSome(stored.counterAnomalyAt));
            assert.strictEqual(stored.counter, 5);
            assert.isTrue(DateTime.Equivalence(stored.lastUsedAt, before.lastUsedAt));
          }).pipe(Effect.provide(ceremonyLayer(mockWebAuthn()))),
      );
    }

    it.effect(
      "a flagged credential's next sign-in needs UV; this assertion's own regression flags it for the next use",
      () =>
        Effect.gen(function* () {
          const first = yield* arrange("signIn", { counter: 5 });
          // Not yet flagged: UV=0 is acceptable under "preferred".
          assert.strictEqual(yield* reasonOf(first, policyOf()), "verified");
          // Now flagged: UV=0 is no longer enough.
          assert.strictEqual(
            yield* reasonOf(yield* reissue(first), policyOf()),
            "userVerification",
          );
        }).pipe(
          Effect.provide(
            ceremonyLayer(mockWebAuthn({ authenticationVerified: { userVerified: false } })),
          ),
        ),
    );

    it.effect("a flagged credential signs in once the authenticator does verify the user", () =>
      Effect.gen(function* () {
        const credentials = yield* PasskeyCredentials.PasskeyCredentials;
        const arranged = yield* arrange("signIn", { counter: 5 });
        yield* credentials.flagCounterAnomaly(arranged.credentialId);
        assert.strictEqual(yield* reasonOf(arranged, policyOf()), "verified");
      }).pipe(
        Effect.provide(ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 9 } }))),
      ),
    );

    it.effect("an advancing counter moves the stored counter forward and flags nothing", () =>
      Effect.gen(function* () {
        const arranged = yield* arrange("signIn", { counter: 5 });
        assert.strictEqual(yield* reasonOf(arranged, policyOf()), "verified");
        const stored = yield* storedCredential(arranged.credentialId);
        assert.isTrue(Option.isNone(stored.counterAnomalyAt));
        assert.strictEqual(stored.counter, 6);
      }).pipe(
        Effect.provide(ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } }))),
      ),
    );

    it.effect("0 === 0 (an authenticator that never reports a counter) is not an anomaly", () =>
      Effect.gen(function* () {
        const arranged = yield* arrange("signIn");
        assert.strictEqual(yield* reasonOf(arranged, policyOf()), "verified");
        assert.strictEqual(yield* reasonOf(yield* reissue(arranged), policyOf()), "verified");
        const stored = yield* storedCredential(arranged.credentialId);
        assert.isTrue(Option.isNone(stored.counterAnomalyAt));
      }).pipe(
        Effect.provide(ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 0 } }))),
      ),
    );

    // Plan 25 F8: both ceremonies read the stored 5 before either writes (a meeting point at the read), so a
    // verdict taken from that read would accept both silently. Decided at the write, the second is a regression.
    describe("F8: two concurrent assertions with the same counter", () => {
      /** The ceremony's credential lookup meets `parties` callers before any of them goes on. */
      const readsMeet = (records: (typeof legs)[number][1]) =>
        Layer.effect(
          PasskeyCredentials.PasskeyCredentials,
          Effect.gen(function* () {
            const real = yield* PasskeyCredentials.PasskeyCredentials;
            const meeting = yield* Rendezvous.make(2);
            return PasskeyCredentials.PasskeyCredentials.of({
              ...real,
              findById: (id) => Effect.tap(real.findById(id), () => meeting.arrive),
            });
          }),
        ).pipe(
          Layer.provideMerge(
            ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } }), records),
          ),
        );

      /** One credential at counter 5, two sign-in ceremonies for it, presented at once. */
      const racePair = (policy: PasskeyCeremony.CeremonyPolicy) =>
        Effect.gen(function* () {
          const first = yield* arrange("signIn", { counter: 5 });
          const ceremony = PasskeyCeremony.Ceremony.SignIn({ ceremonyId: `${first.userId}-twin` });
          const twin = {
            ...first,
            ceremony,
            challenge: Redacted.value(yield* first.ceremonies.begin(ceremony)),
          };
          const reasons = yield* Effect.all([reasonOf(first, policy), reasonOf(twin, policy)], {
            concurrency: "unbounded",
          });
          return { reasons, stored: yield* storedCredential(first.credentialId) };
        });

      for (const [leg, records] of legs) {
        it.effect(`${leg}: flag: both verified, the second flagged once, the counter at 6`, () =>
          Effect.gen(function* () {
            const { reasons, stored } = yield* racePair(policyOf());
            assert.deepStrictEqual(reasons, ["verified", "verified"]);
            assert.strictEqual(stored.counterAnomalyCount, 1);
            assert.strictEqual(stored.counter, 6);
          }).pipe(Effect.provide(readsMeet(records))),
        );

        it.effect(`${leg}: reject: exactly one verified, the other refused "counterAnomaly"`, () =>
          Effect.gen(function* () {
            const { reasons, stored } = yield* racePair(
              policyOf({ counterAnomalyPolicy: "reject" }),
            );
            assert.deepStrictEqual([...reasons].sort(), ["counterAnomaly", "verified"]);
            assert.strictEqual(stored.counterAnomalyCount, 1);
            assert.strictEqual(stored.counter, 6);
          }).pipe(Effect.provide(readsMeet(records))),
        );
      }
    });

    it.effect("a credential deleted mid-ceremony is an unknown credential, not a defect", () => {
      const layer = Layer.effect(
        PasskeyCredentials.PasskeyCredentials,
        Effect.gen(function* () {
          const real = yield* PasskeyCredentials.PasskeyCredentials;
          return PasskeyCredentials.PasskeyCredentials.of({
            ...real,
            // The owner removes the passkey between the ceremony's lookup and its usage write.
            findById: (id) =>
              Effect.tap(real.findById(id), (found) =>
                Option.isSome(found)
                  ? real.delete(id, found.value.userId).pipe(Effect.orDie)
                  : Effect.void,
              ),
          });
        }),
      ).pipe(
        Layer.provideMerge(
          ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } })),
        ),
      );
      return Effect.gen(function* () {
        const arranged = yield* arrange("signIn", { counter: 5 });
        assert.strictEqual(yield* reasonOf(arranged, policyOf()), "unknownCredential");
      }).pipe(Effect.provide(layer));
    });

    it.effect("reject: a non-regressing assertion is verified", () =>
      Effect.gen(function* () {
        const arranged = yield* arrange("signIn", { counter: 5 });
        assert.strictEqual(
          yield* reasonOf(arranged, policyOf({ counterAnomalyPolicy: "reject" })),
          "verified",
        );
      }).pipe(
        Effect.provide(ceremonyLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } }))),
      ),
    );
  });
});

// ---- ADR-EA-028: an outage is an outage, never a refusal ----

describe("ADR-EA-028: a store outage is StoreUnavailable, never a refusal", () => {
  const outage = new Errors.StoreUnavailable({ operation: "mock" });

  it.effect("an outage claiming the challenge", () => {
    const layer = Layer.effect(
      ChallengeStore.ChallengeStore,
      Effect.gen(function* () {
        const real = yield* ChallengeStore.ChallengeStore;
        return ChallengeStore.ChallengeStore.of({ ...real, consume: () => Effect.fail(outage) });
      }),
    ).pipe(Layer.provideMerge(ceremonyLayer(mockWebAuthn())));
    return Effect.gen(function* () {
      for (const kind of KINDS) {
        const arranged = yield* arrange(kind);
        const failure = yield* reasonOf(arranged, policyOf()).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("an outage looking the credential up", () => {
    const layer = Layer.effect(
      PasskeyCredentials.PasskeyCredentials,
      Effect.gen(function* () {
        const real = yield* PasskeyCredentials.PasskeyCredentials;
        return PasskeyCredentials.PasskeyCredentials.of({
          ...real,
          findById: () => Effect.fail(outage),
        });
      }),
    ).pipe(Layer.provideMerge(ceremonyLayer(mockWebAuthn())));
    return Effect.gen(function* () {
      for (const kind of ASSERTIONS) {
        const failure = yield* reasonOf(yield* arrange(kind), policyOf()).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
      }
    }).pipe(Effect.provide(layer));
  });
});
