// THS-001, AOMS-003, ARF-005, THS-004/005/007, BCR-002/006 (BEH-EA-259 to BEH-EA-266): the plugin
// end to end at the domain level — the real `Password` plugin as the first factor, the real
// `TwoFactor` plugin and its two gates, real (in-memory) stores, the real `Encryption` port.
import { AuditLog, Users, VerificationLink } from "@awthaq/core";
import { Encryption, Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SecondFactor from "../src/SecondFactor.ts";
import * as TwoFactor from "../src/TwoFactor.ts";
import * as TwoFactorStore from "../src/TwoFactorStore.ts";
import { CHALLENGE_PURPOSE } from "../src/Challenge.ts";
import {
  buildLayer,
  codeFor,
  letForkedFibersRun,
  realLimiter,
  tokenOf,
} from "./support/harness.ts";

const pw = Redacted.make("correct horse battery staple");
const secret = (text: string) => Redacted.make(text);

/** Signs a user up with a password, verifies the mailbox, and returns the fresh session. */
const registerUser = (email: string) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const mailer = yield* Mailer.Mailer;
    const issued = yield* password.signUp({ email, password: pw });
    yield* letForkedFibersRun;
    const verifyMail = (yield* mailer.sent).findLast((mail) => mail.template === "verify-email");
    yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });
    return { email, userId: issued.session.userId, sessionId: issued.session.id };
  });

/** Registers a user and turns two-factor on: returns the secret and the recovery codes. */
const enrolledUser = (email: string) =>
  Effect.gen(function* () {
    const twoFactor = yield* TwoFactor.TwoFactor;
    const user = yield* registerUser(email);
    const enrollment = yield* twoFactor.enable(user.userId, user.sessionId);
    const recoveryCodes = yield* twoFactor.confirm(
      user.userId,
      secret(yield* codeFor(enrollment.secret)),
    );
    return { ...user, secret: enrollment.secret, recoveryCodes };
  });

/** A password sign-in that must be diverted: returns the challenge the divert carries. */
const divertedSignIn = (email: string) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const failure = yield* password.signIn({ email, password: pw }).pipe(Effect.flip);
    if (failure._tag !== "TwoFactorRequired")
      return yield* Effect.die(`expected a divert, got ${failure._tag}`);
    return failure;
  });

/** A challenge minted directly, bypassing the first factor (the lockout suites use a real limiter, which would also throttle `Password.signIn`). */
const freshChallenge = (userId: Users.UserId) =>
  Effect.gen(function* () {
    const factor = yield* SecondFactor.SecondFactor;
    return yield* factor.issueChallenge({ userId, strategy: "password", amr: ["pwd"], attempt: 0 });
  });

/** The next TOTP step (a code is single-use, and the enrolment code spent the current step). */
const nextStep = TestClock.adjust(Duration.seconds(30));

describe("TwoFactor: enrolment and the divert (BEH-EA-260/261/263)", () => {
  it.effect(
    "enable + confirm, then a password sign-in diverts and /verify with a valid TOTP issues the session",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* enrolledUser("ada@example.com");
        assert.strictEqual(user.recoveryCodes.length, 10);
        assert.deepStrictEqual(yield* twoFactor.status(user.userId), {
          enabled: true,
          remainingRecoveryCodes: 10,
        });

        const audit = yield* AuditLog.AuditLog;
        const issuedBefore = (yield* audit.list({ eventTag: "auth.session.issued" })).length;
        const divert = yield* divertedSignIn(user.email);
        assert.strictEqual(divert.userId, user.userId);
        // No session was minted by the diverted sign-in.
        assert.strictEqual(
          (yield* audit.list({ eventTag: "auth.session.issued" })).length,
          issuedBefore,
        );

        yield* nextStep;
        const issued = yield* twoFactor.verify({
          challengeId: Redacted.make(divert.challengeId),
          code: secret(yield* codeFor(user.secret)),
        });
        assert.strictEqual(issued.session.userId, user.userId);
        // AOMS-003: the session records how it was proven — password, then a one-time code, multi-factor.
        assert.deepStrictEqual(issued.session.amr, ["pwd", "otp", "mfa"]);
        assert.strictEqual(
          (yield* audit.list({ eventTag: "auth.session.issued" })).length,
          issuedBefore + 1,
        );
        assert.strictEqual((yield* audit.list({ eventTag: "auth.twoFactor.verified" })).length, 1);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an unconfirmed (pending) secret never diverts a sign-in", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* registerUser("pending@example.com");
      yield* twoFactor.enable(user.userId, user.sessionId);
      assert.deepStrictEqual(yield* twoFactor.status(user.userId), {
        enabled: false,
        remainingRecoveryCodes: 0,
      });
      const signedIn = yield* password.signIn({ email: user.email, password: pw });
      assert.strictEqual(signedIn.session.userId, user.userId);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "enable refuses an already-enabled account, and a stale session must step up first",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* enrolledUser("stale@example.com");
        const again = yield* twoFactor.enable(user.userId, user.sessionId).pipe(Effect.flip);
        assert.strictEqual(again._tag, "TwoFactorAlreadyEnabled");

        const other = yield* registerUser("stale2@example.com");
        yield* TestClock.adjust(Duration.minutes(11));
        const stale = yield* twoFactor.enable(other.userId, other.sessionId).pipe(Effect.flip);
        if (stale._tag !== "TwoFactorReauthRequired") return assert.fail(stale._tag);
        assert.strictEqual(stale.maxAgeSeconds, 600);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("bypassStrategies lets a named first factor through without a divert", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const user = yield* enrolledUser("bypass@example.com");
      const signedIn = yield* password.signIn({ email: user.email, password: pw });
      assert.strictEqual(signedIn.session.userId, user.userId);
    }).pipe(Effect.provide(buildLayer({ config: { bypassStrategies: ["password"] } }))),
  );
});

describe("TwoFactor: secret at rest (THS-004, ADR-EA-020)", () => {
  it.effect(
    "the stored secret is an Encryption envelope bound to its user, never the base32 secret",
    () =>
      Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        const secrets = yield* TwoFactorStore.TwoFactorSecrets;
        const user = yield* enrolledUser("cipher@example.com");
        const other = yield* enrolledUser("cipher2@example.com");
        const row = yield* secrets.find(user.userId);
        if (Option.isNone(row)) return assert.fail("no secret row");
        assert.notInclude(row.value.envelope, user.secret);
        // The plaintext is recoverable only with the row's own AAD...
        const ok = yield* encryption.decrypt(
          row.value.envelope,
          `two_factor_secret:${user.userId}`,
        );
        assert.strictEqual(Redacted.value(ok.plaintext), user.secret);
        // ...an envelope moved to another user's row does not authenticate.
        const moved = yield* encryption
          .decrypt(row.value.envelope, `two_factor_secret:${other.userId}`)
          .pipe(Effect.flip);
        assert.strictEqual(moved._tag, "DecryptionFailed");
      }).pipe(Effect.provide(buildLayer())),
  );
});

describe("TwoFactor: the challenge (BEH-EA-262, THS-007)", () => {
  it.effect("a code can be used once: the same step's code is refused on a second sign-in", () =>
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* enrolledUser("replay@example.com");
      yield* nextStep;
      const code = yield* codeFor(user.secret);
      const first = yield* divertedSignIn(user.email);
      yield* twoFactor.verify({
        challengeId: Redacted.make(first.challengeId),
        code: secret(code),
      });
      // Same step, same code, fresh challenge: THS-005's compare-and-set refuses it.
      const second = yield* divertedSignIn(user.email);
      const replay = yield* twoFactor
        .verify({ challengeId: Redacted.make(second.challengeId), code: secret(code) })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "InvalidTwoFactorCode");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a wrong code re-issues a fresh challenge until the attempts are spent, then requires a restart",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* enrolledUser("attempts@example.com");
        const divert = yield* divertedSignIn(user.email);
        let challenge: string = divert.challengeId;
        const seen = new Set<string>([challenge]);
        for (let i = 0; i < 2; i += 1) {
          const failure = yield* twoFactor
            .verify({ challengeId: Redacted.make(challenge), code: secret("000000") })
            .pipe(Effect.flip);
          if (failure._tag !== "InvalidTwoFactorCode") return assert.fail(failure._tag);
          // A wrong code is answered with the next challenge to retry with; the spent one is never reused.
          assert.isDefined(failure.challengeId);
          assert.isFalse(seen.has(failure.challengeId ?? ""));
          challenge = failure.challengeId ?? "";
          seen.add(challenge);
        }
        // The third wrong code exhausts maxAttemptsPerChallenge (3): no challenge to retry with.
        const last = yield* twoFactor
          .verify({ challengeId: Redacted.make(challenge), code: secret("000000") })
          .pipe(Effect.flip);
        if (last._tag !== "InvalidTwoFactorCode") return assert.fail(last._tag);
        assert.isUndefined(last.challengeId);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a consumed challenge replays as InvalidTwoFactorCode and publishes auth.token.replay",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const audit = yield* AuditLog.AuditLog;
        const user = yield* enrolledUser("consumed@example.com");
        const divert = yield* divertedSignIn(user.email);
        yield* nextStep;
        const input = {
          challengeId: Redacted.make(divert.challengeId),
          code: secret(yield* codeFor(user.secret)),
        };
        yield* twoFactor.verify(input);
        const before = (yield* audit.list({ eventTag: "auth.token.replay" })).length;
        const replay = yield* twoFactor.verify(input).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "InvalidTwoFactorCode");
        assert.strictEqual(
          (yield* audit.list({ eventTag: "auth.token.replay" })).length,
          before + 1,
        );
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a challenge issued for user A cannot be spent as user B's", () =>
    Effect.gen(function* () {
      const factor = yield* SecondFactor.SecondFactor;
      const a = yield* enrolledUser("a@example.com");
      const b = yield* enrolledUser("b@example.com");
      const challengeA = yield* factor.issueChallenge({
        userId: a.userId,
        strategy: "password",
        amr: ["pwd"],
        attempt: 0,
      });
      // Rewrite the claimed user to B, keeping A's secret value.
      const value = challengeA.slice(challengeA.lastIndexOf(".") + 1);
      const forged = `${VerificationLink.identifierOf(CHALLENGE_PURPOSE, b.userId)}.${value}`;
      const failure = yield* factor.consumeChallenge(Redacted.make(forged)).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidTwoFactorCode");
      // A's own challenge is still intact (the forgery consumed nothing of A's).
      const consumed = yield* factor.consumeChallenge(Redacted.make(challengeA));
      assert.strictEqual(consumed.userId, a.userId);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a second divert supersedes the first challenge (one live challenge per account)", () =>
    Effect.gen(function* () {
      const factor = yield* SecondFactor.SecondFactor;
      const user = yield* enrolledUser("single@example.com");
      const input = {
        userId: user.userId,
        strategy: "password",
        amr: ["pwd" as const],
        attempt: 0,
      };
      const first = yield* factor.issueChallenge(input);
      const second = yield* factor.issueChallenge(input);
      const stale = yield* factor.consumeChallenge(Redacted.make(first)).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "InvalidTwoFactorCode");
      assert.strictEqual(
        (yield* factor.consumeChallenge(Redacted.make(second))).userId,
        user.userId,
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a challenge expires after ten minutes", () =>
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* enrolledUser("expiry@example.com");
      const divert = yield* divertedSignIn(user.email);
      yield* TestClock.adjust(Duration.minutes(10));
      const failure = yield* twoFactor
        .verify({
          challengeId: Redacted.make(divert.challengeId),
          code: secret(yield* codeFor(user.secret)),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidTwoFactorCode");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a challenge for a factor disabled since is refused like a wrong code", () =>
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* enrolledUser("disabled@example.com");
      const divert = yield* divertedSignIn(user.email);
      yield* nextStep;
      yield* twoFactor.disable(user.userId, user.sessionId, secret(yield* codeFor(user.secret)));
      const failure = yield* twoFactor
        .verify({ challengeId: Redacted.make(divert.challengeId), code: secret("123456") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidTwoFactorCode");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a session is refused for a user suspended between the first factor and the second",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const users = yield* Users.Users;
        const user = yield* enrolledUser("suspended@example.com");
        const divert = yield* divertedSignIn(user.email);
        yield* users.setStatus(user.userId, "suspended");
        yield* nextStep;
        const failure = yield* twoFactor
          .verify({
            challengeId: Redacted.make(divert.challengeId),
            code: secret(yield* codeFor(user.secret)),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "UserSuspended");
      }).pipe(Effect.provide(buildLayer())),
  );
});

describe("TwoFactor: recovery codes (BEH-EA-264, BCR-002)", () => {
  it.effect("a recovery code signs in exactly once and is counted down", () =>
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* enrolledUser("recovery@example.com");
      const code = user.recoveryCodes[0] ?? "";
      const divert = yield* divertedSignIn(user.email);
      const issued = yield* twoFactor.verifyRecovery({
        challengeId: Redacted.make(divert.challengeId),
        recoveryCode: secret(code.toLowerCase()), // case and the hyphen do not matter
      });
      assert.deepStrictEqual(issued.session.amr, ["pwd", "otp", "mfa"]);
      assert.strictEqual((yield* twoFactor.status(user.userId)).remainingRecoveryCodes, 9);

      const again = yield* divertedSignIn(user.email);
      const replay = yield* twoFactor
        .verifyRecovery({
          challengeId: Redacted.make(again.challengeId),
          recoveryCode: secret(code),
        })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "InvalidTwoFactorCode");
      const audit = yield* AuditLog.AuditLog;
      assert.strictEqual(
        (yield* audit.list({ eventTag: "auth.twoFactor.recoveryCodeUsed" })).length,
        1,
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("regenerating replaces the whole set: no old code works, ten new ones do", () =>
    Effect.gen(function* () {
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* enrolledUser("regen@example.com");
      const fresh = yield* twoFactor.regenerateRecoveryCodes(
        user.userId,
        user.sessionId,
        secret(user.recoveryCodes[0] ?? ""),
      );
      assert.strictEqual(fresh.length, 10);
      assert.strictEqual((yield* twoFactor.status(user.userId)).remainingRecoveryCodes, 10);
      // The code that authorised the regeneration belonged to the old set, so it is gone with it.
      const divert = yield* divertedSignIn(user.email);
      const oldCode = yield* twoFactor
        .verifyRecovery({
          challengeId: Redacted.make(divert.challengeId),
          recoveryCode: secret(user.recoveryCodes[1] ?? ""),
        })
        .pipe(Effect.flip);
      assert.strictEqual(oldCode._tag, "InvalidTwoFactorCode");
      const next = yield* twoFactor.verifyRecovery({
        challengeId: Redacted.make(
          oldCode._tag === "InvalidTwoFactorCode" ? (oldCode.challengeId ?? "") : "",
        ),
        recoveryCode: secret(fresh[0] ?? ""),
      });
      assert.strictEqual(next.session.userId, user.userId);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("only hashes are stored: no recovery code appears in the table", () =>
    Effect.gen(function* () {
      const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
      const user = yield* enrolledUser("hashed@example.com");
      const stored = yield* codes.listUnused(user.userId);
      assert.strictEqual(stored.length, 10);
      for (const row of stored) {
        const hash = Redacted.value(row.codeHash);
        assert.match(hash, /^\$argon2id\$/);
        for (const plain of user.recoveryCodes) {
          assert.notInclude(hash, plain.replaceAll("-", ""));
        }
      }
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("TwoFactor: disabling (BEH-EA-263)", () => {
  it.effect(
    "disable needs a valid code, removes the factor and every recovery code, and stops the divert",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* enrolledUser("off@example.com");
        const wrong = yield* twoFactor
          .disable(user.userId, user.sessionId, secret("000000"))
          .pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "InvalidTwoFactorCode");
        yield* nextStep;
        yield* twoFactor.disable(user.userId, user.sessionId, secret(yield* codeFor(user.secret)));
        assert.deepStrictEqual(yield* twoFactor.status(user.userId), {
          enabled: false,
          remainingRecoveryCodes: 0,
        });
        const signedIn = yield* password.signIn({ email: user.email, password: pw });
        assert.strictEqual(signedIn.session.userId, user.userId);
        const again = yield* twoFactor
          .disable(user.userId, user.sessionId, secret("000000"))
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "TwoFactorNotEnabled");
      }).pipe(Effect.provide(buildLayer())),
  );
});

describe("TwoFactor: the shared failure budget (BCR-006, ADR-EA-020)", () => {
  it.effect(
    "five failures across TOTP and recovery codes lock the second factor, even for the right code and across fresh challenges",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const audit = yield* AuditLog.AuditLog;
        const user = yield* enrolledUser("lock@example.com");
        yield* nextStep;
        // Two TOTP failures and three recovery-code failures, each on its own fresh challenge.
        for (let i = 0; i < 5; i += 1) {
          const challenge = yield* freshChallenge(user.userId);
          const attempt =
            i < 2
              ? twoFactor.verify({ challengeId: Redacted.make(challenge), code: secret("000000") })
              : twoFactor.verifyRecovery({
                  challengeId: Redacted.make(challenge),
                  recoveryCode: secret("ZZZZZ-ZZZZZ"),
                });
          const failure = yield* attempt.pipe(Effect.flip);
          assert.strictEqual(failure._tag, "InvalidTwoFactorCode");
        }
        assert.strictEqual((yield* audit.list({ eventTag: "auth.twoFactor.locked" })).length, 1);
        // Locked: the correct code is now refused, with how long to wait.
        const locked = yield* twoFactor
          .verify({
            challengeId: Redacted.make(yield* freshChallenge(user.userId)),
            code: secret(yield* codeFor(user.secret)),
          })
          .pipe(Effect.flip);
        if (locked._tag !== "SecondFactorLocked") return assert.fail(locked._tag);
        assert.isAbove(locked.retryAfterMillis, 0);
        // Refusing a locked attempt does not itself announce another lock.
        assert.strictEqual((yield* audit.list({ eventTag: "auth.twoFactor.locked" })).length, 1);
        // Once the window passes, the right code works again.
        yield* TestClock.adjust(Duration.minutes(16));
        const issued = yield* twoFactor.verify({
          challengeId: Redacted.make(yield* freshChallenge(user.userId)),
          code: secret(yield* codeFor(user.secret)),
        });
        assert.strictEqual(issued.session.userId, user.userId);
      }).pipe(Effect.provide(buildLayer({ limiter: realLimiter }))),
  );

  it.effect(
    "success does not reset the window, so interleaving right and wrong codes cannot stretch the budget",
    () =>
      Effect.gen(function* () {
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* enrolledUser("interleave@example.com");
        const wrong = (challenge: string) =>
          twoFactor
            .verify({ challengeId: Redacted.make(challenge), code: secret("000000") })
            .pipe(Effect.flip);
        for (let i = 0; i < 4; i += 1) yield* wrong(yield* freshChallenge(user.userId));
        // A success in between (a fresh step's right code)...
        yield* nextStep;
        yield* twoFactor.verify({
          challengeId: Redacted.make(yield* freshChallenge(user.userId)),
          code: secret(yield* codeFor(user.secret)),
        });
        // ...does not refund anything: the fifth failure still locks.
        yield* wrong(yield* freshChallenge(user.userId));
        yield* nextStep;
        const refused = yield* twoFactor
          .verify({
            challengeId: Redacted.make(yield* freshChallenge(user.userId)),
            code: secret(yield* codeFor(user.secret)),
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "SecondFactorLocked");
      }).pipe(Effect.provide(buildLayer({ limiter: realLimiter }))),
  );
});

describe("TwoFactor x Password.confirmReset (ARF-005, BEH-EA-259)", () => {
  const requestResetToken = (email: string) =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      yield* password.requestReset({ email });
      yield* letForkedFibersRun;
      const mail = (yield* mailer.sent).findLast((m) => m.template === "reset-password");
      return Redacted.make(tokenOf(mail));
    });
  const newPassword = Redacted.make("a brand new strong password");

  it.effect(
    "mailbox possession alone cannot reset an enrolled account: SecondFactorRequired, password unchanged",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const user = yield* enrolledUser("reset@example.com");
        const token = yield* requestResetToken(user.email);
        const failure = yield* password
          .confirmReset({ token, password: newPassword })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "SecondFactorRequired");
        // The credential was never rewritten: the old password still gets as far as the divert.
        const stillOld = yield* divertedSignIn(user.email);
        assert.strictEqual(stillOld.userId, user.userId);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a wrong second-factor code is the typed HookAborted; a valid TOTP carries the reset",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const user = yield* enrolledUser("reset2@example.com");
        const token = yield* requestResetToken(user.email);
        const wrong = yield* password
          .confirmReset({ token, password: newPassword, secondFactorCode: secret("000000") })
          .pipe(Effect.flip);
        if (wrong._tag !== "HookAborted") return assert.fail(wrong._tag);
        assert.strictEqual(wrong.code, "SECOND_FACTOR_INVALID");
        // The wrong code spent the (in-memory, non-transactional) reset token, so request another.
        const second = yield* requestResetToken(user.email);
        yield* nextStep;
        yield* password.confirmReset({
          token: second,
          password: newPassword,
          secondFactorCode: secret(yield* codeFor(user.secret)),
        });
        const signedIn = yield* password
          .signIn({ email: user.email, password: newPassword })
          .pipe(Effect.flip);
        // The new password works — it reaches the second-factor divert.
        assert.strictEqual(signedIn._tag, "TwoFactorRequired");
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a recovery code carries a reset exactly once", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const user = yield* enrolledUser("reset3@example.com");
      const code = user.recoveryCodes[0] ?? "";
      const token = yield* requestResetToken(user.email);
      yield* password.confirmReset({
        token,
        password: newPassword,
        secondFactorCode: secret(code),
      });
      const again = yield* requestResetToken(user.email);
      const replay = yield* password
        .confirmReset({ token: again, password: pw, secondFactorCode: secret(code) })
        .pipe(Effect.flip);
      if (replay._tag !== "HookAborted") return assert.fail(replay._tag);
      assert.strictEqual(replay.code, "SECOND_FACTOR_INVALID");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an unenrolled account resets exactly as before", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const user = yield* registerUser("plain@example.com");
      const token = yield* requestResetToken(user.email);
      yield* password.confirmReset({ token, password: newPassword });
      const signedIn = yield* password.signIn({ email: user.email, password: newPassword });
      assert.strictEqual(signedIn.session.userId, user.userId);
    }).pipe(Effect.provide(buildLayer())),
  );
});
