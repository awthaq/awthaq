// BEH-EA-035 (05-persistence-stratum.feature): the domain service, not the repository, holds the
// transaction boundary. The claim is observable through `Password.confirmReset` over the real
// SQLite transaction PasswordWorld already provides (TIR-005): with a fault injected between the
// two repository writes nothing may persist, and once the fault is lifted both effects land
// together. The same World and helpers as 15-password.feature's REQ-EA-317/693.
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import {
  World,
  configureApp,
  currentOptions,
  getNote,
  getSessionCookie,
  request,
  setFault,
  setNote,
  setSession,
  sessionIsLive,
  verifyLatestSignUp,
} from "./PasswordWorld.ts";
import { latestResetToken, signInAs, signUpActor } from "./PasswordSteps.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

const NEW_PASSWORD = "a brand new strong password";

export const passwordTransactionSteps = defineSteps<World>(({ Given, When, Then }) => {
  Given(
    "{string} consuming a verification token and rotating a session in one operation",
    function* (_operation: string) {
      // Real SQLite transaction (memory stores have a no-op boundary), a live session and a live reset token.
      yield* configureApp({ storage: "sqlite" });
      const email = "alice@example.com";
      const { cookie } = yield* signUpActor("alice", email, STRONG_PASSWORD);
      assert.ok(cookie !== undefined, "sign-up must have issued the session");
      yield* setSession("s1", cookie);
      yield* verifyLatestSignUp(email);
      yield* request("/password/request-reset", { email });
      yield* setNote("resetToken", yield* latestResetToken(email));
      assert.equal(yield* sessionIsLive(cookie), true);
    },
  );

  When("{string} runs", function* (_operation: string) {
    // A failure between the two repository writes: the boundary is what decides what survives.
    yield* setFault("revokeAll");
    const response = yield* request("/password/confirm-reset", {
      token: yield* getNote("resetToken"),
      password: NEW_PASSWORD,
    });
    yield* setNote("firstAttempt", String(response.status));
  });

  Then(
    "the domain service itself opens the transaction boundary around both repository calls",
    function* () {
      // Had each repository call committed on its own, the consumed token (or the revoked session)
      // would have outlived the failed operation. Neither did: the boundary spans both.
      assert.equal(yield* getNote("firstAttempt"), "500");
      assert.equal(
        yield* sessionIsLive(yield* getSessionCookie("s1")),
        true,
        "session s1 survived",
      );
      assert.equal(
        (yield* signInAs("alice@example.com", STRONG_PASSWORD)).status,
        200,
        "the old password still works",
      );
      assert.equal((yield* currentOptions()).storage, "sqlite");
    },
  );

  Then("the token consumption and the session rotation commit or roll back together", function* () {
    // Lifting the fault, the very same token now succeeds — it was never spent — and the token,
    // the new password and the session revocation all appear at once.
    yield* setFault("none");
    const retry = yield* request("/password/confirm-reset", {
      token: yield* getNote("resetToken"),
      password: NEW_PASSWORD,
    });
    assert.equal(retry.status, 204);
    assert.equal(yield* sessionIsLive(yield* getSessionCookie("s1")), false);
    assert.equal((yield* signInAs("alice@example.com", NEW_PASSWORD)).status, 200);
    const replay = yield* request("/password/confirm-reset", {
      token: yield* getNote("resetToken"),
      password: "yet another strong password",
    });
    assert.equal(replay.status, 410);
  });
});
