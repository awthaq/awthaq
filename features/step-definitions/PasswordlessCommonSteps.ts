// P20a (BCR-010): the steps 32-magic-link.feature and 33-email-otp.feature have in common — the
// same people, the same clock, the same sign-in gate outcomes. What a feature does differently
// (what is mailed, what is presented) lives in its own module.
import { Users } from "@awthaq/core";
import { EmailOtp, MagicLink } from "@awthaq/magic-link";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { appOf, configureApp, direct, enrolSecondFactor, World } from "./MagicLinkWorld.ts";
import {
  createUser,
  failureField,
  failureTag,
  findUser,
  outcomeAt,
  remember,
  requireUser,
  sessionsIssued,
} from "./MagicLinkSupport.ts";
import { isString } from "./shared/Outcomes.ts";

export const passwordlessCommonSteps = defineSteps<World>(({ Given, When, Then }) => {
  Given("a user {string}", function* (email: string) {
    yield* createUser(email);
  });

  Given("a user {string} with an unverified mailbox", function* (email: string) {
    const created = yield* createUser(email);
    assert.equal(Users.isEmailVerified(created), false);
  });

  Then("no user exists for {string}", function* (email: string) {
    assert.ok(Option.isNone(yield* findUser(email)));
  });

  When("{int} seconds pass", function* (seconds: number) {
    yield* TestClock.adjust(Duration.seconds(seconds));
  });

  When("{int} minutes pass", function* (minutes: number) {
    yield* TestClock.adjust(Duration.minutes(minutes));
  });

  Given("the application enforces the real rate limits", function* () {
    yield* configureApp({ realLimits: true });
  });

  Then("the mailbox of {string} is verified", function* (email: string) {
    assert.ok(Users.isEmailVerified(yield* requireUser(email)));
  });

  Then("it fails with {string}", function* (tag: string) {
    assert.equal(failureTag(yield* outcomeAt("verify")), tag);
  });

  Then("a user exists for {string}", function* (email: string) {
    assert.ok(Option.isSome(yield* findUser(email)));
  });

  Given("the sign-in of {string} is vetoed", function* (email: string) {
    const app = yield* appOf();
    yield* Ref.update(app.vetoed, (existing) => [...existing, email]);
  });

  Then("no session was issued", function* () {
    const world = yield* World;
    const before = yield* world.numbers.get("issuedBefore");
    assert.equal(yield* sessionsIssued, before);
  });

  Given("{string} is suspended", function* (email: string) {
    const user = yield* requireUser(email);
    yield* direct(
      Users.Users.pipe(Effect.flatMap((users) => users.setStatus(user.id, "suspended"))),
    );
  });

  Given("a user {string} with a confirmed second factor", function* (email: string) {
    const user = yield* createUser(email);
    yield* enrolSecondFactor(user.id);
  });

  Then("it fails with {string} naming {string}", function* (tag: string, email: string) {
    const outcome = yield* outcomeAt("verify");
    assert.equal(failureTag(outcome), tag);
    assert.equal(failureField(outcome, "userId"), (yield* requireUser(email)).id);
    const challengeId = failureField(outcome, "challengeId");
    assert.ok(isString(challengeId));
    yield* remember("challengeId", challengeId);
  });

  Then("the {string} plugin declares no table", function* (plugin: string) {
    // Both channel plugins keep their credential in core's `Verification` rows (BEH-EA-270, BEH-EA-274).
    const tables =
      plugin === "magicLink"
        ? MagicLink.MagicLink.tables
        : plugin === "emailOtp"
          ? EmailOtp.EmailOtp.tables
          : undefined;
    assert.ok(tables !== undefined, `unknown plugin "${plugin}"`);
    assert.deepEqual([...tables], []);
  });
});
