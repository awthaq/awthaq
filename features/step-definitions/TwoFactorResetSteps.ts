// BCR-010/P20a: BEH-EA-259's scenarios (15-password.feature): a credential reset consults
// `BeforeCredentialReset` before anything is rewritten. Wired over `TwoFactorWorld`'s composition,
// where `TwoFactor.credentialResetGate` is the tap; Password's own HTTP world has no second factor.
import { Sessions } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { mailedToken } from "./MailedToken.ts";
import {
  currentCode,
  direct,
  directExit,
  enrol,
  failureOf,
  failureTag,
  getPerson,
  nextStep,
  register,
  signInWithPassword,
  World,
} from "./TwoFactorWorld.ts";
import { answer, field, setAnswer, successValue } from "./TwoFactorSupport.ts";
import { letForkedFibersRun } from "./shared/Harness.ts";

const NEW_PASSWORD = "a brand new strong password";

export const twoFactorResetSteps = defineSteps<World>(({ Given, When, Then }) => {
  Given("a reset-flow user {string} with a confirmed second factor", function* (name: string) {
    yield* register(name);
    yield* enrol(name);
  });

  Given("a reset-flow user {string} without a second factor", function* (name: string) {
    yield* register(name);
  });

  Given("{string} holds a live password-reset token", function* (name: string) {
    const person = yield* getPerson(name);
    const { strings } = yield* World;
    const token = yield* direct(
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.requestReset({ email: person.email });
        yield* letForkedFibersRun;
        const mail = (yield* mailer.sent).findLast(
          (message) => message.template === "reset-password" && message.to === person.email,
        );
        if (mail === undefined) return yield* Effect.die("no reset-password mail");
        return mailedToken(mail);
      }),
    );
    yield* strings.set(`reset:${name}`, token);
  });

  Given("a new time step begins", function* () {
    yield* nextStep;
  });

  const confirmReset = (name: string, secondFactorCode: string | undefined) =>
    Effect.gen(function* () {
      const { strings } = yield* World;
      const token = yield* strings.get(`reset:${name}`);
      yield* setAnswer(
        yield* directExit(
          Effect.gen(function* () {
            const password = yield* Password.Password;
            return yield* password.confirmReset({
              token: Redacted.make(token),
              password: Redacted.make(NEW_PASSWORD),
              ...(secondFactorCode === undefined
                ? {}
                : { secondFactorCode: Redacted.make(secondFactorCode) }),
            });
          }),
        ),
      );
    });

  When(
    "the reset of {string} is confirmed with a new password and no second-factor code",
    function* (name: string) {
      yield* confirmReset(name, undefined);
    },
  );

  When(
    "the reset of {string} is confirmed with a new password and the second-factor code {string}",
    function* (name: string, code: string) {
      yield* confirmReset(name, code);
    },
  );

  When(
    "the reset of {string} is confirmed with a new password and her current authenticator code",
    function* (name: string) {
      yield* confirmReset(name, yield* currentCode(name));
    },
  );

  When(
    "the reset of {string} is confirmed with a new password and her first recovery code",
    function* (name: string) {
      yield* confirmReset(name, (yield* getPerson(name)).recoveryCodes[0] ?? "");
    },
  );

  Then("the reset fails with {string}", function* (tag: string) {
    assert.equal(failureTag(yield* answer), tag);
  });

  Then(
    "the reset fails with {string} carrying the code {string}",
    function* (tag: string, code: string) {
      const exit = yield* answer;
      assert.equal(failureTag(exit), tag);
      assert.equal(field(failureOf(exit), "code"), code);
    },
  );

  Then("the reset succeeds", function* () {
    successValue(yield* answer);
  });

  Then(
    "the old password of {string} still signs in as far as the second-factor divert",
    function* (name: string) {
      // The credential was never rewritten: the original password still reaches the divert.
      assert.equal(failureTag(yield* signInWithPassword(name)), "TwoFactorRequired");
    },
  );

  const signInWithNewPassword = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      return yield* directExit(
        Effect.gen(function* () {
          const password = yield* Password.Password;
          return yield* password.signIn({
            email: person.email,
            password: Redacted.make(NEW_PASSWORD),
          });
        }),
      );
    });

  Then(
    "the new password of {string} signs in as far as the second-factor divert",
    function* (name: string) {
      assert.equal(failureTag(yield* signInWithNewPassword(name)), "TwoFactorRequired");
    },
  );

  Then("the new password of {string} signs in with a session", function* (name: string) {
    const person = yield* getPerson(name);
    const value = successValue(yield* signInWithNewPassword(name));
    assert.equal(field(field(value, "session"), "userId"), person.userId);
  });

  Then("the session {string} signed up with is still live", function* (name: string) {
    const person = yield* getPerson(name);
    const sessions = yield* direct(
      Effect.flatMap(Sessions.Sessions, (store) => store.list(person.userId)),
    );
    assert.ok(sessions.some((item) => item.id === person.sessionId));
  });
});
