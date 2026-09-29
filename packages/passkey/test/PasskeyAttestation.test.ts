// spec/behaviors/17-passkey.md, BEH-EA-135/136 — HSK-002 (+TC-006, CB-008).
//
// Conveyance ("direct"/"enterprise") only *requests* attestation; the optional
// `attestationPolicy` is what turns it into a decision, and a plugin that
// requests attestation with no policy says so once at build time.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn, registrationPayload } from "./passkeyTestFixtures.ts";
import { buildLayer } from "./passkeyTestLayers.ts";
import { Sessions, Users } from "@awthaq/core";

const YUBIKEY = "ee882879-721c-4913-9775-3dfcce97072a";
const OTHER_MODEL = "00000000-0000-0000-0000-00000000beef";

const register = (email: string) =>
  Effect.gen(function* () {
    const passkey = yield* Passkey.Passkey;
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
    const issued = yield* sessions.issue({ userId: user.id });
    const options = yield* passkey.registerOptions(user.id, issued.session.id);
    return yield* passkey.registerVerify(
      user.id,
      issued.session.id,
      registrationPayload({ options }),
    );
  });

describe("HSK-002: attestationPolicy", () => {
  const policy = { trustedAaguids: [YUBIKEY] };

  it.effect("with a policy set, a none-format registration fails PasskeyAttestationRejected", () =>
    Effect.gen(function* () {
      const failure = yield* register("none@example.com").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyAttestationRejected");
    }).pipe(
      Effect.provide(
        buildLayer(mockWebAuthn(), { attestation: "direct", attestationPolicy: policy }),
      ),
    ),
  );

  it.effect("a certificate attestation from a listed AAGUID is accepted (case-insensitively)", () =>
    Effect.gen(function* () {
      const record = yield* register("listed@example.com");
      assert.strictEqual(record.aaguid, YUBIKEY);
    }).pipe(
      Effect.provide(
        buildLayer(
          mockWebAuthn({
            registrationVerified: {
              aaguid: YUBIKEY,
              attestationFormat: "packed",
              attestationType: "certificate",
            },
          }),
          {
            attestation: "direct",
            attestationPolicy: { trustedAaguids: [YUBIKEY.toUpperCase()] },
          },
        ),
      ),
    ),
  );

  it.effect("a certificate attestation from an unlisted AAGUID is rejected", () =>
    Effect.gen(function* () {
      const failure = yield* register("unlisted@example.com").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyAttestationRejected");
    }).pipe(
      Effect.provide(
        buildLayer(
          mockWebAuthn({
            registrationVerified: {
              aaguid: OTHER_MODEL,
              attestationFormat: "packed",
              attestationType: "certificate",
            },
          }),
          { attestation: "direct", attestationPolicy: policy },
        ),
      ),
    ),
  );

  it.effect(
    "a self-attestation is rejected by default, accepted with rejectSelfAttestation: false",
    () =>
      Effect.gen(function* () {
        const failure = yield* register("self@example.com").pipe(
          Effect.provide(
            buildLayer(
              mockWebAuthn({
                registrationVerified: {
                  aaguid: YUBIKEY,
                  attestationFormat: "packed",
                  attestationType: "self",
                },
              }),
              { attestation: "direct", attestationPolicy: policy },
            ),
          ),
          Effect.flip,
        );
        assert.strictEqual(failure._tag, "PasskeyAttestationRejected");

        const record = yield* register("self-ok@example.com").pipe(
          Effect.provide(
            buildLayer(
              mockWebAuthn({
                registrationVerified: {
                  aaguid: YUBIKEY,
                  attestationFormat: "packed",
                  attestationType: "self",
                },
              }),
              {
                attestation: "direct",
                attestationPolicy: { trustedAaguids: [YUBIKEY], rejectSelfAttestation: false },
              },
            ),
          ),
        );
        assert.strictEqual(record.aaguid, YUBIKEY);
      }),
  );

  it.effect("with no policy nothing about the attestation is enforced (BEH-EA-135's default)", () =>
    Effect.gen(function* () {
      const record = yield* register("nopolicy@example.com");
      assert.strictEqual(record.id, "cred-mock-1");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("HSK-002: conveyance is not verification", () => {
  /** Builds the plugin once under a capturing logger and answers every warning it logged. */
  const warningsFor = (layer: ReturnType<typeof buildLayer>) => {
    const warnings: Array<string> = [];
    const logger = Logger.make((options) => {
      if (options.logLevel === "Warn") warnings.push(String(options.message));
    });
    return Effect.gen(function* () {
      yield* Passkey.Passkey;
      return warnings;
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Logger.layer([logger])))));
  };

  it.effect("no policy + direct conveyance logs one warning naming the missing policy", () =>
    Effect.gen(function* () {
      const warnings = yield* warningsFor(buildLayer(mockWebAuthn(), { attestation: "direct" }));
      const attestationWarnings = warnings.filter((message) =>
        message.includes("attestationPolicy"),
      );
      assert.strictEqual(attestationWarnings.length, 1);
    }),
  );

  it.effect("a policy (or the default none conveyance) logs no such warning", () =>
    Effect.gen(function* () {
      const withPolicy = yield* warningsFor(
        buildLayer(mockWebAuthn(), {
          attestation: "enterprise",
          attestationPolicy: { trustedAaguids: [YUBIKEY] },
        }),
      );
      const byDefault = yield* warningsFor(buildLayer(mockWebAuthn()));
      assert.deepStrictEqual(
        [...withPolicy, ...byDefault].filter((message) => message.includes("attestationPolicy")),
        [],
      );
    }),
  );
});
