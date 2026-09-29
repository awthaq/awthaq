// SOS-001, BCR-005, SOS-004, MLO-002, SAM-009 (BEH-EA-244 to BEH-EA-247): the EmailOtp plugin at the
// domain level — a six-digit code that is hashed, single-use, attempt-budgeted and resend-windowed.
import { AuditLog, Sessions, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Totp, TwoFactor } from "@awthaq/two-factor";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as EmailOtp from "../src/EmailOtp.ts";
import { buildLayer, letForkedFibersRun, realLimiter, secretOf } from "./support/harness.ts";

const codeFor = (email: string) =>
  Effect.gen(function* () {
    const emailOtp = yield* EmailOtp.EmailOtp;
    const mailer = yield* Mailer.Mailer;
    yield* emailOtp.requestCode({ email });
    yield* letForkedFibersRun;
    const mail = (yield* mailer.sent).findLast(
      (message) => message.template === "email-otp" && message.to === email,
    );
    return { mail, code: secretOf(mail, "code") };
  });

const wrongCodeFor = (code: string) => (code === "000000" ? "111111" : "000000");

describe("EmailOtp.requestCode (BEH-EA-245)", () => {
  it.effect("mails a six-digit code with its expiry; an unknown address answers 202 and mails nothing when sign-up is off", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      yield* users.create({ identity: { _tag: "Email", email: "ada@example.com" }, name: "Ada" });
      const { mail, code } = yield* codeFor("ada@example.com");
      assert.match(code, /^[0-9]{6}$/);
      assert.isString(mail?.data?.["expiresAt"]);
      assert.isTrue(Redacted.isRedacted(mail?.data?.["code"]));

      const known = yield* emailOtp.requestCode({ email: "ada@example.com" });
      const unknown = yield* emailOtp.requestCode({ email: "nobody@example.com" });
      assert.strictEqual(known, unknown);
      yield* letForkedFibersRun;
      assert.deepStrictEqual(
        (yield* mailer.sent).map((sent) => sent.to),
        ["ada@example.com"],
      );
    }).pipe(Effect.provide(buildLayer({ emailOtp: { allowSignUp: false } }))),
  );

  it.effect("MLO-002: within the resend window no second code is minted, and the first stays valid", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const mailer = yield* Mailer.Mailer;
      const { code } = yield* codeFor("resend@example.com");
      yield* emailOtp.requestCode({ email: "resend@example.com" });
      yield* letForkedFibersRun;
      assert.strictEqual((yield* mailer.sent).length, 1);
      const issued = yield* emailOtp.verify({
        email: "resend@example.com",
        code: Redacted.make(code),
      });
      assert.isDefined(issued.session);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("after the window a new code supersedes the old one (one live code per address)", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const first = yield* codeFor("window@example.com");
      yield* TestClock.adjust(Duration.seconds(61));
      const second = yield* codeFor("window@example.com");
      // (A colliding six-digit value is astronomically unlikely but possible; the superseded code is refused unless it is equal.)
      if (first.code !== second.code) {
        const stale = yield* emailOtp
          .verify({ email: "window@example.com", code: Redacted.make(first.code) })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "InvalidEmailOtp");
      }
      const ok = yield* emailOtp.verify({
        email: "window@example.com",
        code: Redacted.make(second.code),
      });
      assert.isDefined(ok.session);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("is rate limited per address, `+tag` variants sharing one budget", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      for (let i = 0; i < 5; i += 1) yield* emailOtp.requestCode({ email: `victim+${i}@example.com` });
      const limited = yield* emailOtp.requestCode({ email: "victim+9@example.com" }).pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
    }).pipe(Effect.provide(buildLayer({ limiter: realLimiter }))),
  );
});

describe("EmailOtp.verify (BEH-EA-246)", () => {
  it.effect("a correct code signs in exactly once, marks the mailbox verified and records amr [otp, email]", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const users = yield* Users.Users;
      const audit = yield* AuditLog.AuditLog;
      const created = yield* users.create({
        identity: { _tag: "Email", email: "ada@example.com" },
        name: "Ada",
      });
      const { code } = yield* codeFor("ada@example.com");
      const issued = yield* emailOtp.verify({ email: "Ada@Example.com", code: Redacted.make(code) });
      assert.strictEqual(issued.session.userId, created.id);
      assert.deepStrictEqual(issued.session.amr, ["otp", "email"]);
      assert.isTrue(Users.isEmailVerified(yield* users.findById(created.id)));
      assert.strictEqual((yield* audit.list({ eventTag: "auth.user.signedIn" })).length, 1);

      const replay = yield* emailOtp
        .verify({ email: "ada@example.com", code: Redacted.make(code) })
        .pipe(Effect.flip);
      assert.strictEqual(replay._tag, "InvalidEmailOtp");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("SOS-004: three wrong guesses burn the code — the correct one no longer works", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const { code } = yield* codeFor("guess@example.com");
      for (let i = 0; i < 3; i += 1) {
        const failure = yield* emailOtp
          .verify({ email: "guess@example.com", code: Redacted.make(wrongCodeFor(code)) })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidEmailOtp");
      }
      const late = yield* emailOtp
        .verify({ email: "guess@example.com", code: Redacted.make(code) })
        .pipe(Effect.flip);
      assert.strictEqual(late._tag, "InvalidEmailOtp");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("two wrong guesses leave the code usable", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const { code } = yield* codeFor("two@example.com");
      for (let i = 0; i < 2; i += 1) {
        yield* emailOtp
          .verify({ email: "two@example.com", code: Redacted.make(wrongCodeFor(code)) })
          .pipe(Effect.flip);
      }
      const ok = yield* emailOtp.verify({ email: "two@example.com", code: Redacted.make(code) });
      assert.isDefined(ok.session);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a value that cannot be a code, an unknown address and an expired code are all the one InvalidEmailOtp", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const { code } = yield* codeFor("late@example.com");
      for (const [email, presented] of [
        ["late@example.com", "12345"],
        ["late@example.com", "abcdef"],
        ["nobody@example.com", "123456"],
      ] as const) {
        const failure = yield* emailOtp
          .verify({ email, code: Redacted.make(presented) })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidEmailOtp");
      }
      yield* TestClock.adjust(Duration.minutes(5));
      const expired = yield* emailOtp
        .verify({ email: "late@example.com", code: Redacted.make(code) })
        .pipe(Effect.flip);
      assert.strictEqual(expired._tag, "InvalidEmailOtp");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a brand-new address creates the user when the code is presented, not when it is requested", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const users = yield* Users.Users;
      const { code } = yield* codeFor("new@example.com");
      assert.isTrue(Option.isNone(yield* users.findByEmail("new@example.com")));
      const issued = yield* emailOtp.verify({ email: "new@example.com", code: Redacted.make(code) });
      const created = Option.getOrThrow(yield* users.findByEmail("new@example.com"));
      assert.strictEqual(issued.session.userId, created.id);
      assert.isTrue(Users.isEmailVerified(created));
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("per-address verify limit: guesses across many codes are bounded (10 in 15 minutes)", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      let limited = false;
      for (let i = 0; i < 12; i += 1) {
        const failure = yield* emailOtp
          .verify({ email: "spray@example.com", code: Redacted.make("123456") })
          .pipe(Effect.flip);
        if (failure._tag === "RateLimited") limited = true;
      }
      assert.isTrue(limited);
    }).pipe(Effect.provide(buildLayer({ limiter: realLimiter }))),
  );

  it.effect("a user with a confirmed second factor is diverted to TwoFactorRequired (amr carried into the challenge)", () =>
    Effect.gen(function* () {
      const emailOtp = yield* EmailOtp.EmailOtp;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const twoFactor = yield* TwoFactor.TwoFactor;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "mfa@example.com" },
        name: "M",
      });
      const fresh = yield* sessions.issue({ userId: user.id });
      const enrolment = yield* twoFactor.enable(user.id, fresh.session.id);
      const crypto = yield* Crypto.Crypto;
      const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      yield* twoFactor.confirm(
        user.id,
        Redacted.make(yield* Totp.totp(crypto, key, now, { period: 30, digits: 6 })),
      );

      const { code } = yield* codeFor("mfa@example.com");
      const failure = yield* emailOtp
        .verify({ email: "mfa@example.com", code: Redacted.make(code) })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "TwoFactorRequired");
    }).pipe(Effect.provide(buildLayer().pipe(Layer.provide(NodeCrypto.layer)))),
  );
});
