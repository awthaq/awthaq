// spec/behaviors/17-passkey.md, BEH-EA-131/136 — CB-004/WPS-006.
//
// The decided "log + step-up, not an instant kill" counter-anomaly policy,
// actually reachable now that the port no longer lets the library throw on a
// regression first: flagged and audited under `"flag"` (the default), the
// credential then needs UV on every later use; `"reject"` additionally fails
// the ceremony with `PasskeyCounterAnomaly`.
import { AuthEvents } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import { assertionCredential, mockWebAuthn } from "./passkeyTestFixtures.ts";
import { buildLayer, registerNewUser } from "./passkeyTestLayers.ts";

/** Registers `cred-mock-1` and gives it a real, non-zero stored counter (5). */
const seededUser = (email: string) =>
  Effect.gen(function* () {
    const credentials = yield* PasskeyCredentials.PasskeyCredentials;
    const user = yield* registerNewUser(email);
    yield* credentials.recordUsage("cred-mock-1", 5, false);
    return user;
  });

const signIn = Effect.gen(function* () {
  const passkey = yield* Passkey.Passkey;
  const { ceremonyId, options } = yield* passkey.authenticateOptions({});
  return yield* passkey.authenticateVerify({
    ceremonyId,
    credential: assertionCredential({ options }),
  });
});

const storedCredential = Effect.gen(function* () {
  const credentials = yield* PasskeyCredentials.PasskeyCredentials;
  const found = yield* credentials.findById("cred-mock-1");
  if (Option.isNone(found)) return yield* Effect.die(new Error("credential vanished"));
  return found.value;
});

// The mocked port always reports `newCounter: 1` — a regression against the seeded 5.
describe("CB-004/WPS-006: counterAnomalyPolicy 'flag' (default)", () => {
  it.effect("a regression still signs in, publishes the event and flags the credential", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const { userId } = yield* seededUser("flag@example.com");
      const seen = yield* Effect.forkChild(
        events.stream.pipe(
          Stream.filter((event) => event._tag === "auth.passkey.counterAnomaly"),
          Stream.take(1),
          Stream.runCollect,
        ),
        { startImmediately: true },
      );

      const issued = yield* signIn;
      assert.strictEqual(issued.session.userId, userId);
      assert.strictEqual((yield* Fiber.join(seen)).length, 1);

      const stored = yield* storedCredential;
      assert.isTrue(Option.isSome(stored.counterAnomalyAt));
      assert.strictEqual(stored.counterAnomalyCount, 1);
      // A regressed counter never lowers what is stored.
      assert.strictEqual(stored.counter, 5);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a flagged credential's next sign-in demands user verification", () =>
    Effect.gen(function* () {
      yield* seededUser("stepup@example.com");
      // First use: not yet flagged, UV=0 is acceptable under the default "preferred" policy.
      yield* signIn;
      // Now flagged — UV=0 is no longer enough.
      const failure = yield* signIn.pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyUserVerificationRequired");
    }).pipe(
      Effect.provide(buildLayer(mockWebAuthn({ authenticationVerified: { userVerified: false } }))),
    ),
  );

  it.effect("a flagged credential signs in once the authenticator does verify the user", () =>
    Effect.gen(function* () {
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;
      const { userId } = yield* seededUser("stepup-ok@example.com");
      yield* credentials.flagCounterAnomaly("cred-mock-1");
      const issued = yield* signIn;
      assert.strictEqual(issued.session.userId, userId);
    }).pipe(
      Effect.provide(buildLayer(mockWebAuthn({ authenticationVerified: { newCounter: 9 } }))),
    ),
  );

  it.effect(
    "a genuinely advancing counter is not an anomaly and moves the stored counter forward",
    () =>
      Effect.gen(function* () {
        yield* seededUser("advance@example.com");
        yield* signIn;
        const stored = yield* storedCredential;
        assert.isTrue(Option.isNone(stored.counterAnomalyAt));
        assert.strictEqual(stored.counter, 6);
      }).pipe(
        Effect.provide(buildLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } }))),
      ),
  );

  it.effect("0 === 0 (an authenticator that never reports a counter) is not an anomaly", () =>
    Effect.gen(function* () {
      yield* registerNewUser("zero@example.com");
      yield* signIn;
      yield* signIn;
      const stored = yield* storedCredential;
      assert.isTrue(Option.isNone(stored.counterAnomalyAt));
    }).pipe(
      Effect.provide(buildLayer(mockWebAuthn({ authenticationVerified: { newCounter: 0 } }))),
    ),
  );
});

describe("CB-004/WPS-006: counterAnomalyPolicy 'reject'", () => {
  it.effect(
    "a regression fails the ceremony as PasskeyCounterAnomaly, with no session, and flags the credential",
    () =>
      Effect.gen(function* () {
        yield* seededUser("reject@example.com");
        const failure = yield* signIn.pipe(Effect.flip);
        assert.strictEqual(failure._tag, "PasskeyCounterAnomaly");
        const stored = yield* storedCredential;
        assert.isTrue(Option.isSome(stored.counterAnomalyAt));
        assert.strictEqual(stored.counter, 5);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { counterAnomalyPolicy: "reject" }))),
  );

  it.effect("step-up reauthentication applies the same policy", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId } = yield* seededUser("reject-reauth@example.com");
      const options = yield* passkey.reauthenticateOptions(userId, sessionId);
      const failure = yield* passkey
        .reauthenticateVerify(userId, sessionId, {
          credential: assertionCredential({ options }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyCounterAnomaly");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn(), { counterAnomalyPolicy: "reject" }))),
  );

  it.effect("a non-regressing assertion is unaffected", () =>
    Effect.gen(function* () {
      const { userId } = yield* seededUser("reject-ok@example.com");
      const issued = yield* signIn;
      assert.strictEqual(issued.session.userId, userId);
    }).pipe(
      Effect.provide(
        buildLayer(mockWebAuthn({ authenticationVerified: { newCounter: 6 } }), {
          counterAnomalyPolicy: "reject",
        }),
      ),
    ),
  );
});
