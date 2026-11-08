// spec/behaviors/17-passkey.md, BEH-EA-130/131/134 — BPAS-003 (+HSK-001,
// TC-002, WPS-002, CB-005) and the server half of BPAS-006/TC-004.
//
// One random WebAuthn user handle per user, minted once, sent as `user.id` in
// every registration ceremony, stored on every credential, and checked
// against the `userHandle` a discoverable credential's assertion carries. The store's own cases
// (`getOrCreate` under concurrency, `deleteByUser`) are its RecordsContract suite, `contract/PasskeyUserHandles.ts`.
import { Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Passkey from "../src/Passkey.ts";
import { mockWebAuthn, registrationPayload } from "./passkeyTestFixtures.ts";
import { buildLayer } from "./passkeyTestLayers.ts";

const newUserSession = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({
      identity: { _tag: "Email", email },
      name: `Name of ${email}`,
    });
    const issued = yield* sessions.issue({ userId: user.id });
    return { userId: user.id, sessionId: issued.session.id };
  });

describe("BPAS-003: one stable handle per user", () => {
  it.effect(
    "the stored webauthnUserId equals options.user.id, and every credential of one user shares it",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* newUserSession("handle@example.com");

        const first = yield* passkey.registerOptions(userId, sessionId);
        const firstRecord = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: first, id: "cred-1" }),
        );
        const second = yield* passkey.registerOptions(userId, sessionId);
        const secondRecord = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: second, id: "cred-2" }),
        );
        const conditional = yield* passkey.registerOptionsConditional(userId, sessionId);

        // Before the fix each ceremony step minted its own random handle.
        assert.strictEqual(first.user.id, second.user.id);
        assert.strictEqual(first.user.id, conditional.user.id);
        assert.strictEqual(firstRecord.webauthnUserId, first.user.id);
        assert.strictEqual(secondRecord.webauthnUserId, first.user.id);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("two users get different handles, and the handle is not the internal user id", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const a = yield* newUserSession("a-handle@example.com");
      const b = yield* newUserSession("b-handle@example.com");
      const optionsA = yield* passkey.registerOptions(a.userId, a.sessionId);
      const optionsB = yield* passkey.registerOptions(b.userId, b.sessionId);
      assert.notStrictEqual(optionsA.user.id, optionsB.user.id);
      assert.notStrictEqual(optionsA.user.id, a.userId);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("BPAS-006/TC-004: the signals surface", () => {
  it.effect(
    "answers the rpId, the stable handle and only the caller's own accepted credential ids",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const mine = yield* newUserSession("signals-me@example.com");
        const theirs = yield* newUserSession("signals-them@example.com");
        for (const [user, id] of [
          [mine, "mine-1"],
          [mine, "mine-2"],
          [theirs, "theirs-1"],
        ] as const) {
          const options = yield* passkey.registerOptions(user.userId, user.sessionId);
          yield* passkey.registerVerify(
            user.userId,
            user.sessionId,
            registrationPayload({ options, id }),
          );
        }
        const signals = yield* passkey.signals(mine.userId);
        const options = yield* passkey.registerOptions(mine.userId, mine.sessionId);
        assert.strictEqual(signals.rpId, "example.com");
        assert.strictEqual(signals.userId, options.user.id);
        assert.strictEqual(signals.name, "signals-me@example.com");
        assert.strictEqual(signals.displayName, "Name of signals-me@example.com");
        assert.deepStrictEqual([...signals.allAcceptedCredentialIds].sort(), ["mine-1", "mine-2"]);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a user with no credentials still gets a handle and an empty accepted set", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId } = yield* newUserSession("signals-empty@example.com");
      const signals = yield* passkey.signals(userId);
      assert.isAbove(signals.userId.length, 0);
      assert.deepStrictEqual(signals.allAcceptedCredentialIds, []);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});
