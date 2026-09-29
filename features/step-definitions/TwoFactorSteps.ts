// BCR-010/P20a: step definitions for 14-mfa-passwordless/31-two-factor.feature, BEH-EA-260..263's
// enrolment half (the TOTP module, the divert, the challenge, the management endpoints). "Her"/
// "she" resolve to the person most recently named. BEH-EA-263's secret-at-rest checks and
// BEH-EA-264..266 are in TwoFactorSecuritySteps.ts.
import { Hooks, Users, VerificationLink } from "@awthaq/core";
import { Challenge, SecondFactor, Totp, TwoFactor } from "@awthaq/two-factor";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  advance,
  auditRows,
  beginEnrolment,
  configureApp,
  confirmEnrolment,
  currentCode,
  direct,
  directExit,
  divertedChallenge,
  enrol,
  failureOf,
  failureTag,
  freshChallenge,
  getPerson,
  nextStep,
  register,
  requireSecret,
  sessionsIssued,
  signInWithPassword,
  verifyWith,
  World,
} from "./TwoFactorWorld.ts";
import { answer, ascii, current, field, setAnswer, successValue } from "./TwoFactorSupport.ts";

export const twoFactorSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ==== BEH-EA-260: the pure TOTP module ====================================================

  Given("the RFC 4226 Appendix D key {string}", function* (key: string) {
    const { strings } = yield* World;
    yield* strings.set("key", key);
  });

  When("the six-digit HOTP is computed for counter {int}", function* (counter: number) {
    const { strings } = yield* World;
    const key = ascii(yield* strings.get("key"));
    const code = yield* direct(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return yield* Totp.hotp(crypto, key, BigInt(counter), 6);
      }),
    );
    yield* strings.set("code", code);
  });

  When("the eight-digit TOTP is computed at Unix time {int}", function* (time: number) {
    const { strings } = yield* World;
    const key = ascii(yield* strings.get("key"));
    const code = yield* direct(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return yield* Totp.totp(crypto, key, time, { period: 30, digits: 8 });
      }),
    );
    yield* strings.set("code", code);
  });

  Then("the code is {string}", function* (expected: string) {
    const { strings } = yield* World;
    assert.equal(yield* strings.get("code"), expected);
  });

  Given("the current time is Unix time {int}", function* (time: number) {
    const { numbers } = yield* World;
    yield* numbers.set("now", time);
  });

  Given("the last accepted step is the current step", function* () {
    const { numbers } = yield* World;
    yield* numbers.set("last", Number(Totp.stepOf(yield* numbers.get("now"), 30)));
  });

  /** Verifies `code` at the scenario's "current time", under the scenario's last accepted step (if any). */
  const verifyAtNow = Effect.fn("features.twoFactor.verifyAtNow")(function* (code: string) {
    const { strings, numbers } = yield* World;
    const key = ascii(yield* strings.get("key"));
    const now = yield* numbers.get("now");
    const last = yield* numbers.get("last").pipe(
      Effect.map((step) => Option.some(BigInt(step))),
      Effect.catchDefect(() => Effect.succeed(Option.none<bigint>())),
    );
    const exit = yield* directExit(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return yield* Totp.verifyTotp(crypto, key, code, now, {
          period: 30,
          digits: 6,
          window: 1,
          lastUsedStep: last,
        });
      }),
    );
    return exit;
  });

  const codeAtOffset = Effect.fn("features.twoFactor.codeAtOffset")(function* (offset: number) {
    const { strings, numbers } = yield* World;
    const key = ascii(yield* strings.get("key"));
    const now = yield* numbers.get("now");
    return yield* direct(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        return yield* Totp.totp(crypto, key, now + offset * 30, { period: 30, digits: 6 });
      }),
    );
  });

  const verdictOf = (exit: Exit.Exit<Option.Option<bigint>, unknown>) => {
    assert.ok(Exit.isSuccess(exit), "verification must not fail or die");
    return Option.isSome(exit.value) ? "accepted" : "refused";
  };

  When(
    "the code of the step {int} steps from the current one is presented for verification",
    function* (offset: number) {
      const { strings, exits } = yield* World;
      const exit = yield* verifyAtNow(yield* codeAtOffset(offset));
      yield* exits.set("verification", exit);
      yield* strings.set("verdict", verdictOf(exit));
    },
  );

  When("the code {string} is presented for verification", function* (code: string) {
    const { strings, exits } = yield* World;
    const exit = yield* verifyAtNow(code);
    yield* exits.set("verification", exit);
    yield* strings.set("verdict", verdictOf(exit));
  });

  Then("the code is accepted", function* () {
    const { strings } = yield* World;
    assert.equal(yield* strings.get("verdict"), "accepted");
  });

  Then("the code is refused", function* () {
    const { strings } = yield* World;
    assert.equal(yield* strings.get("verdict"), "refused");
  });

  Then(
    "the code of the step {int} steps from the current one is {word}",
    function* (offset: number, expected: string) {
      const exit = yield* verifyAtNow(yield* codeAtOffset(offset));
      assert.equal(verdictOf(exit), expected);
    },
  );

  Then("no error was raised", function* () {
    const { exits } = yield* World;
    assert.ok(Exit.isSuccess(yield* exits.get("verification")));
  });

  When("{string} begins enrolling a second factor", function* (name: string) {
    const exit = yield* beginEnrolment(name);
    const { strings } = yield* World;
    if (Exit.isSuccess(exit)) {
      yield* strings.set(`uri:${name}`, String(field(exit.value, "otpauthUri")));
    }
    yield* setAnswer(exit);
  });

  Then(
    "the secret shown to {string} decodes from base32 to {int} bytes",
    function* (name: string, bytes: number) {
      const secret = requireSecret(yield* getPerson(name));
      const decoded = Totp.base32Decode(secret);
      assert.ok(Option.isSome(decoded));
      assert.equal(decoded.value.length, bytes);
    },
  );

  Then("the secrets shown to {string} and {string} differ", function* (a: string, b: string) {
    assert.notEqual(requireSecret(yield* getPerson(a)), requireSecret(yield* getPerson(b)));
  });

  Then("its base32 encoding is {string}", function* (expected: string) {
    const { strings } = yield* World;
    assert.equal(Totp.base32Encode(ascii(yield* strings.get("key"))), expected);
  });

  Then("decoding {string} yields that key", function* (text: string) {
    const { strings } = yield* World;
    const decoded = Totp.base32Decode(text);
    assert.ok(Option.isSome(decoded));
    assert.deepEqual([...decoded.value], [...ascii(yield* strings.get("key"))]);
  });

  Then(
    "decoding a text containing the character {string} yields nothing",
    function* (character: string) {
      const { strings } = yield* World;
      yield* strings.set("decoded", String(Option.isSome(Totp.base32Decode(`ABC${character}DEF`))));
      assert.equal(yield* strings.get("decoded"), "false");
    },
  );

  Then(
    "the URI shown to {string} is an {string} link carrying her secret, the issuer, {string} and {string}",
    function* (name: string, prefix: string, period: string, digits: string) {
      const { strings } = yield* World;
      const uri = yield* strings.get(`uri:${name}`);
      assert.ok(uri.startsWith(prefix), uri);
      assert.ok(uri.includes(requireSecret(yield* getPerson(name))));
      assert.ok(uri.includes("issuer=awthaq"), uri);
      assert.ok(uri.includes(period) && uri.includes(digits), uri);
    },
  );

  // ==== shared givens ==========================================================================

  Given("a registered user {string} with a verified mailbox", function* (name: string) {
    yield* register(name);
  });

  // REQ-EA-1065: the hasher is counted from before the string is presented, so enrolment's own hashing does not count.
  When(
    "a string that cannot be a recovery code is presented for {string}",
    function* (name: string) {
      const { numbers, hashes } = yield* World;
      const person = yield* getPerson(name);
      const before = yield* Ref.get(hashes);
      const exit = yield* directExit(
        Effect.flatMap(SecondFactor.SecondFactor, (second) =>
          second.verifyRecoveryCode(person.userId, Redacted.make("not-a-code"), "signIn"),
        ),
      );
      assert.equal(failureTag(exit), "InvalidTwoFactorCode");
      yield* numbers.set("hashesForString", (yield* Ref.get(hashes)) - before);
      // The control: a well-formed (but wrong) code does reach the hasher, so the counter sees what a real check costs.
      const control = yield* Ref.get(hashes);
      yield* directExit(
        Effect.flatMap(SecondFactor.SecondFactor, (second) =>
          second.verifyRecoveryCode(person.userId, Redacted.make("ABCDEFGHJK"), "signIn"),
        ),
      );
      yield* numbers.set("hashesForWellFormed", (yield* Ref.get(hashes)) - control);
    },
  );

  Then("it is refused and no password hash is computed", function* () {
    const { numbers } = yield* World;
    assert.equal(yield* numbers.get("hashesForString"), 0);
    assert.ok(
      (yield* numbers.get("hashesForWellFormed")) > 0,
      "the counting hasher saw no hash at all",
    );
  });

  Given("{string} has enrolled a second factor", function* (name: string) {
    yield* enrol(name);
  });

  Given("{string} has begun enrolling but not confirmed", function* (name: string) {
    successValue(yield* beginEnrolment(name));
  });

  Given("a new time step begins", function* () {
    yield* nextStep;
  });

  Given("{int} minutes pass", function* (minutes: number) {
    yield* advance(Duration.minutes(minutes));
  });

  Given("{string} is suspended", function* (name: string) {
    const person = yield* getPerson(name);
    yield* direct(
      Effect.flatMap(Users.Users, (users) => users.setStatus(person.userId, "suspended")),
    );
  });

  Given("the application declares {string} in bypassStrategies", function* (strategy: string) {
    yield* configureApp({ config: { bypassStrategies: [strategy] } });
  });

  Given("the application enforces its rate limits", function* () {
    yield* configureApp({ enforceRateLimits: true });
  });

  Given("{string} holds a challenge from a diverted password sign-in", function* (name: string) {
    const { strings } = yield* World;
    yield* strings.set(`challenge:${name}`, yield* divertedChallenge(name));
  });

  Given("the number of sessions issued so far is noted", function* () {
    const { numbers } = yield* World;
    yield* numbers.set("issued", yield* sessionsIssued());
  });

  // ==== BEH-EA-261: the divert =================================================================

  When("{string} signs in with her password", function* (name: string) {
    yield* setAnswer(yield* signInWithPassword(name));
  });

  Then(
    "the sign-in fails with {string} carrying her user id and a challenge id",
    function* (tag: string) {
      const person = yield* current;
      const exit = yield* answer;
      assert.equal(failureTag(exit), tag);
      const failure = failureOf(exit);
      assert.equal(field(failure, "userId"), person.userId);
      assert.equal(typeof field(failure, "challengeId"), "string");
    },
  );

  const noNewSessionSince = (label: string) =>
    Effect.gen(function* () {
      const { numbers } = yield* World;
      assert.equal(yield* sessionsIssued(), yield* numbers.get("issued"), label);
    });

  Then("no session was issued by the sign-in", function* () {
    yield* noNewSessionSince("the diverted sign-in minted a session");
  });

  Then("the sign-in succeeds with a session for {string}", function* (name: string) {
    const person = yield* getPerson(name);
    const value = successValue(yield* answer);
    assert.equal(field(field(value, "session"), "userId"), person.userId);
  });

  When(
    "the {string} first factor consults BeforeSessionIssue for {string}",
    function* (strategy: string, name: string) {
      const person = yield* getPerson(name);
      yield* setAnswer(
        yield* directExit(
          Effect.gen(function* () {
            const point = yield* Hooks.BeforeSessionIssue;
            return yield* point.run({ userId: person.userId, strategy, amr: ["pwd"] });
          }),
        ),
      );
    },
  );

  Then(
    "the hook diverts to {string} carrying her user id and a challenge id",
    function* (tag: string) {
      const person = yield* current;
      const result = successValue(yield* answer);
      assert.equal(field(result, "_tag"), "Diverted");
      const diverted = field(result, "value");
      assert.equal(field(diverted, "_tag"), tag);
      assert.equal(field(diverted, "userId"), person.userId);
      assert.equal(typeof field(diverted, "challengeId"), "string");
    },
  );

  Then("the hook lets the sign-in continue", function* () {
    assert.equal(field(successValue(yield* answer), "_tag"), "Continue");
  });

  Then(
    "the {string} first factor consulting BeforeSessionIssue for {string} is still diverted",
    function* (strategy: string, name: string) {
      const person = yield* getPerson(name);
      const result = successValue(
        yield* directExit(
          Effect.gen(function* () {
            const point = yield* Hooks.BeforeSessionIssue;
            return yield* point.run({ userId: person.userId, strategy, amr: ["pwd"] });
          }),
        ),
      );
      assert.equal(field(result, "_tag"), "Diverted");
    },
  );

  When(
    "{string} presents her current authenticator code with her challenge",
    function* (name: string) {
      const { strings } = yield* World;
      const challenge = yield* strings.get(`challenge:${name}`);
      const code = yield* currentCode(name);
      yield* strings.set(`lastChallenge:${name}`, challenge);
      yield* strings.set(`lastCode:${name}`, code);
      yield* setAnswer(yield* verifyWith(challenge, code));
    },
  );

  Then(
    "the second factor issues a session for {string} recording {string}, {string} and {string}",
    function* (name: string, a: string, b: string, c: string) {
      const person = yield* getPerson(name);
      const issued = successValue(yield* answer);
      const session = field(issued, "session");
      assert.equal(field(session, "userId"), person.userId);
      assert.deepEqual(field(session, "amr"), [a, b, c]);
    },
  );

  Then("no session was issued by the second factor", function* () {
    yield* noNewSessionSince("the second factor minted a session");
  });

  // ==== BEH-EA-262: the challenge ==============================================================

  When("{string} is diverted twice in a row", function* (name: string) {
    const { strings } = yield* World;
    yield* strings.set(`first:${name}`, yield* divertedChallenge(name));
    yield* strings.set(`second:${name}`, yield* divertedChallenge(name));
  });

  const consume = (challengeId: string) =>
    directExit(
      Effect.gen(function* () {
        const factor = yield* SecondFactor.SecondFactor;
        return yield* factor.consumeChallenge(Redacted.make(challengeId));
      }),
    );

  Then("her first challenge is refused as an {string}", function* (tag: string) {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    assert.equal(failureTag(yield* consume(yield* strings.get(`first:${name}`))), tag);
  });

  Then("her second challenge is still spendable", function* () {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    const person = yield* getPerson(name);
    const consumed = successValue(yield* consume(yield* strings.get(`second:${name}`)));
    assert.equal(field(consumed, "userId"), person.userId);
  });

  Then("her challenge identifier is {string} followed by her user id", function* (prefix: string) {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    const person = yield* getPerson(name);
    const challenge = yield* strings.get(`challenge:${name}`);
    const identifier = challenge.slice(0, challenge.lastIndexOf("."));
    assert.equal(identifier, `${prefix}${person.userId}`);
    assert.equal(
      identifier,
      VerificationLink.identifierOf(Challenge.CHALLENGE_PURPOSE, person.userId),
    );
  });

  Then("her challenge is spendable", function* () {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    const person = yield* getPerson(name);
    const consumed = successValue(yield* consume(yield* strings.get(`challenge:${name}`)));
    assert.equal(field(consumed, "userId"), person.userId);
  });

  Then("her challenge is refused as an {string}", function* (tag: string) {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    assert.equal(failureTag(yield* consume(yield* strings.get(`challenge:${name}`))), tag);
  });

  When("the same challenge and code are presented again", function* () {
    const { strings, people, numbers } = yield* World;
    const name = yield* people.current;
    yield* numbers.set("replays", (yield* auditRows("auth.token.replay")).length);
    yield* setAnswer(
      yield* verifyWith(
        yield* strings.get(`lastChallenge:${name}`),
        yield* strings.get(`lastCode:${name}`),
      ),
    );
  });

  Then("the answer is an {string}", function* (tag: string) {
    assert.equal(failureTag(yield* answer), tag);
  });

  Then("the answer is {string}", function* (tag: string) {
    assert.equal(failureTag(yield* answer), tag);
  });

  Then(
    "the answer is {string} naming a maximum age of {int} seconds",
    function* (tag: string, seconds: number) {
      const exit = yield* answer;
      assert.equal(failureTag(exit), tag);
      assert.equal(field(failureOf(exit), "maxAgeSeconds"), seconds);
    },
  );

  Then("an {string} event was published for the replay", function* (tag: string) {
    const { numbers } = yield* World;
    assert.equal((yield* auditRows(tag)).length, (yield* numbers.get("replays")) + 1);
  });

  When(
    "{string} presents the wrong code {string} with her challenge",
    function* (name: string, code: string) {
      const { strings } = yield* World;
      const challenge = yield* strings.get(`challenge:${name}`);
      yield* strings.set(`lastChallenge:${name}`, challenge);
      yield* strings.set(`lastCode:${name}`, code);
      const exit = yield* verifyWith(challenge, code);
      const next = field(failureOf(exit), "challengeId");
      if (typeof next === "string") yield* strings.set(`challenge:${name}`, next);
      yield* setAnswer(exit);
    },
  );

  Then("the answer is an {string} carrying a fresh challenge", function* (tag: string) {
    const exit = yield* answer;
    assert.equal(failureTag(exit), tag);
    assert.equal(typeof field(failureOf(exit), "challengeId"), "string");
  });

  Then("the challenge she presented is refused if she presents it again", function* () {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    assert.equal(
      failureTag(yield* consume(yield* strings.get(`lastChallenge:${name}`))),
      "InvalidTwoFactorCode",
    );
  });

  When(
    "{string}'s challenge value is presented under {string}'s challenge identifier",
    function* (owner: string, other: string) {
      const { strings } = yield* World;
      const ownerChallenge = yield* freshChallenge(owner);
      yield* strings.set(`challenge:${owner}`, ownerChallenge);
      const otherPerson = yield* getPerson(other);
      const value = ownerChallenge.slice(ownerChallenge.lastIndexOf(".") + 1);
      const forged = `${VerificationLink.identifierOf(Challenge.CHALLENGE_PURPOSE, otherPerson.userId)}.${value}`;
      yield* setAnswer(yield* consume(forged));
    },
  );

  Then("{string}'s own challenge is still spendable", function* (name: string) {
    const { strings } = yield* World;
    const person = yield* getPerson(name);
    const consumed = successValue(yield* consume(yield* strings.get(`challenge:${name}`)));
    assert.equal(field(consumed, "userId"), person.userId);
  });

  When(
    "{string} presents the wrong code {string} three times, each time on the challenge the previous answer carried",
    function* (name: string, code: string) {
      const { strings, exits } = yield* World;
      let challenge = yield* strings.get(`challenge:${name}`);
      const seen = new Set<string>([challenge]);
      for (const index of [1, 2, 3]) {
        const exit = yield* verifyWith(challenge, code);
        yield* exits.set(`attempt:${index}`, exit);
        const next = field(failureOf(exit), "challengeId");
        if (typeof next === "string") {
          assert.ok(!seen.has(next), "a spent challenge was handed out again");
          seen.add(next);
          challenge = next;
        }
      }
    },
  );

  Then("the first two answers carry a fresh challenge that was never seen before", function* () {
    const { exits } = yield* World;
    for (const index of [1, 2]) {
      const exit = yield* exits.get(`attempt:${index}`);
      assert.equal(failureTag(exit), "InvalidTwoFactorCode");
      assert.equal(typeof field(failureOf(exit), "challengeId"), "string");
    }
  });

  Then("the third answer carries no challenge", function* () {
    const { exits } = yield* World;
    const exit = yield* exits.get("attempt:3");
    assert.equal(failureTag(exit), "InvalidTwoFactorCode");
    assert.equal(field(failureOf(exit), "challengeId"), undefined);
  });

  When("a second-factor presentation fails because {string}", function* (cause: string) {
    const { strings, people } = yield* World;
    const name = yield* people.current;
    const person = yield* getPerson(name);
    const forgedIdentifier = (userId: string) =>
      VerificationLink.identifierOf(Challenge.CHALLENGE_PURPOSE, userId);
    switch (cause) {
      case "the challenge is malformed":
        yield* setAnswer(yield* verifyWith("not-a-challenge", "000000"));
        return;
      case "the challenge is unknown":
        yield* setAnswer(
          yield* verifyWith(`${forgedIdentifier(person.userId)}.no-such-value`, "000000"),
        );
        return;
      case "the challenge has expired": {
        const challenge = yield* divertedChallenge(name);
        yield* advance(Duration.minutes(10));
        yield* setAnswer(yield* verifyWith(challenge, yield* currentCode(name)));
        return;
      }
      case "the challenge was already spent": {
        const challenge = yield* divertedChallenge(name);
        yield* verifyWith(challenge, "000000");
        yield* setAnswer(yield* verifyWith(challenge, "000000"));
        return;
      }
      case "the challenge belongs to another user": {
        const challenge = yield* divertedChallenge(name);
        const value = challenge.slice(challenge.lastIndexOf(".") + 1);
        yield* setAnswer(
          yield* verifyWith(`${forgedIdentifier("someone-else")}.${value}`, "000000"),
        );
        return;
      }
      case "the code is wrong": {
        yield* setAnswer(yield* verifyWith(yield* divertedChallenge(name), "000000"));
        return;
      }
      case "the factor was disabled since the divert": {
        const challenge = yield* divertedChallenge(name);
        yield* strings.set(`challenge:${name}`, challenge);
        yield* nextStep;
        const code = yield* currentCode(name);
        successValue(
          yield* directExit(
            Effect.gen(function* () {
              const twoFactor = yield* TwoFactor.TwoFactor;
              return yield* twoFactor.disable(person.userId, person.sessionId, Redacted.make(code));
            }),
          ),
        );
        yield* setAnswer(yield* verifyWith(challenge, "123456"));
        return;
      }
      default:
        throw new Error(`unknown cause "${cause}"`);
    }
  });

  // ==== BEH-EA-263: management ================================================================

  const statusOf = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      return yield* direct(
        Effect.gen(function* () {
          const twoFactor = yield* TwoFactor.TwoFactor;
          return yield* twoFactor.status(person.userId);
        }),
      );
    });

  Then("{string} has no second factor enabled", function* (name: string) {
    assert.equal((yield* statusOf(name)).enabled, false);
  });

  Then("{string} still has no second factor enabled", function* (name: string) {
    assert.equal((yield* statusOf(name)).enabled, false);
  });

  Then("{string} has a second factor enabled", function* (name: string) {
    assert.equal((yield* statusOf(name)).enabled, true);
  });

  Then(
    "confirming with the code {string} is refused as an {string}",
    function* (code: string, tag: string) {
      const person = yield* current;
      const exit = yield* directExit(
        Effect.gen(function* () {
          const twoFactor = yield* TwoFactor.TwoFactor;
          return yield* twoFactor.confirm(person.userId, Redacted.make(code));
        }),
      );
      assert.equal(failureTag(exit), tag);
    },
  );

  When("{string} confirms with her current authenticator code", function* (name: string) {
    const { strings } = yield* World;
    yield* strings.set(`lastCode:${name}`, yield* currentCode(name));
    yield* setAnswer(yield* confirmEnrolment(name));
  });

  When(
    "{string} attempts to disable the second factor with the code {string}",
    function* (name: string, code: string) {
      const person = yield* getPerson(name);
      yield* setAnswer(
        yield* directExit(
          Effect.gen(function* () {
            const twoFactor = yield* TwoFactor.TwoFactor;
            return yield* twoFactor.disable(person.userId, person.sessionId, Redacted.make(code));
          }),
        ),
      );
    },
  );

  When(
    "{string} attempts to regenerate her recovery codes with the code {string}",
    function* (name: string, code: string) {
      const person = yield* getPerson(name);
      yield* setAnswer(
        yield* directExit(
          Effect.gen(function* () {
            const twoFactor = yield* TwoFactor.TwoFactor;
            return yield* twoFactor.regenerateRecoveryCodes(
              person.userId,
              person.sessionId,
              Redacted.make(code),
            );
          }),
        ),
      );
    },
  );

  When(
    "{string} disables the second factor with her current authenticator code",
    function* (name: string) {
      const person = yield* getPerson(name);
      const code = yield* currentCode(name);
      yield* setAnswer(
        yield* directExit(
          Effect.gen(function* () {
            const twoFactor = yield* TwoFactor.TwoFactor;
            return yield* twoFactor.disable(person.userId, person.sessionId, Redacted.make(code));
          }),
        ),
      );
    },
  );

  Then("{string} signs in with her password without a divert", function* (name: string) {
    const person = yield* getPerson(name);
    const value = successValue(yield* signInWithPassword(name));
    assert.equal(field(field(value, "session"), "userId"), person.userId);
  });

  Then("disabling again is refused as {string}", function* (tag: string) {
    const person = yield* current;
    const exit = yield* directExit(
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        return yield* twoFactor.disable(person.userId, person.sessionId, Redacted.make("000000"));
      }),
    );
    assert.equal(failureTag(exit), tag);
  });
});
