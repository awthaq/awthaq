// BAM-007, MLO-005, MLO-002, ARF-005 Fix A (BEH-EA-264 to BEH-EA-267): the MagicLink plugin at the
// domain level — real in-memory stores, the real mail dispatcher, the real `@awthaq/two-factor`
// gates for the MFA divert.
import { AuditLog, HookPoint, Hooks, Sessions, Users, Verification } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { SecondFactor, Totp, TwoFactor } from "@awthaq/two-factor";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as MagicLink from "../src/MagicLink.ts";
import { buildLayer, letForkedFibersRun, realLimiter, secretOf } from "./support/harness.ts";

const link = Effect.gen(function* () {
  const mailer = yield* Mailer.Mailer;
  const mail = (yield* mailer.sent).findLast((message) => message.template === "magic-link");
  return { mail, token: Redacted.make(secretOf(mail, "token")) };
});

const requestAndRead = (email: string) =>
  Effect.gen(function* () {
    const magicLink = yield* MagicLink.MagicLink;
    yield* magicLink.requestLink({ email });
    yield* letForkedFibersRun;
    return yield* link;
  });

describe("MagicLink.requestLink (BEH-EA-265)", () => {
  it.effect(
    "answers identically for a known and an unknown address, and with sign-up off mails only the known one",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const mailer = yield* Mailer.Mailer;
        yield* users.create({ identity: { _tag: "Email", email: "ada@example.com" }, name: "Ada" });

        // Both requests resolve to the same `void`, whatever exists behind them.
        const known = yield* magicLink.requestLink({ email: "ada@example.com" });
        const unknown = yield* magicLink.requestLink({ email: "nobody@example.com" });
        assert.strictEqual(known, unknown);
        yield* letForkedFibersRun;

        const sent = yield* mailer.sent;
        assert.deepStrictEqual(
          sent.map((mail) => [mail.template, mail.to]),
          [["magic-link", "ada@example.com"]],
        );
        // The token names neither the user nor the address (ARF-009).
        const token = secretOf(sent[0], "token");
        const userId = Option.getOrThrow(yield* users.findByEmail("ada@example.com")).id;
        assert.notInclude(token, userId);
        assert.notInclude(token, "ada");
        assert.isTrue(token.startsWith("magic-link:"));
        // Sign-up is off: asking for a link never created anyone.
        assert.isTrue(Option.isNone(yield* users.findByEmail("nobody@example.com")));
      }).pipe(Effect.provide(buildLayer({ magicLink: { allowSignUp: false } }))),
  );

  it.effect("mail data carries the expiry, and a fragment link when a baseUrl is configured", () =>
    Effect.gen(function* () {
      const { mail, token } = yield* requestAndRead("frag@example.com");
      assert.isString(mail?.data?.["expiresAt"]);
      const url = String(mail?.data?.["url"]);
      // The token is in the FRAGMENT: never sent to a server, logged, or put in a Referer.
      assert.strictEqual(
        url,
        `https://app.example.com/magic-link#token=${encodeURIComponent(Redacted.value(token))}`,
      );
      assert.notInclude(url.split("#")[0] ?? "", "token");
      assert.isFalse(url.includes("?"));
      assert.isTrue(Redacted.isRedacted(mail?.data?.["token"]));
    }).pipe(Effect.provide(buildLayer({ magicLink: { baseUrl: "https://app.example.com" } }))),
  );

  it.effect("MLO-002: an address is mailed at most one link per resend window", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const mailer = yield* Mailer.Mailer;
      for (let i = 0; i < 3; i += 1) yield* magicLink.requestLink({ email: "again@example.com" });
      yield* letForkedFibersRun;
      assert.strictEqual((yield* mailer.sent).length, 1);
      yield* TestClock.adjust(Duration.seconds(61));
      yield* magicLink.requestLink({ email: "again@example.com" });
      yield* letForkedFibersRun;
      assert.strictEqual((yield* mailer.sent).length, 2);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("is rate limited per address (5 in 15 minutes, `+tag` variants share one budget)", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      for (let i = 0; i < 5; i += 1)
        yield* magicLink.requestLink({ email: `victim+${i}@example.com` });
      const limited = yield* magicLink
        .requestLink({ email: "victim+9@example.com" })
        .pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
    }).pipe(Effect.provide(buildLayer({ limiter: realLimiter }))),
  );
});

describe("MagicLink.verify (BEH-EA-266)", () => {
  it.effect(
    "signs an existing user in, marks the mailbox verified, records amr [email]; a replay fails MagicLinkConsumed",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const audit = yield* AuditLog.AuditLog;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "ada@example.com" },
          name: "Ada",
        });
        assert.isFalse(Users.isEmailVerified(created));

        const { token } = yield* requestAndRead("ada@example.com");
        const issued = yield* magicLink.verify({ token }, { userAgent: "Browser/1.0" });
        assert.strictEqual(issued.session.userId, created.id);
        assert.deepStrictEqual(issued.session.amr, ["email"]);
        assert.isTrue(Users.isEmailVerified(yield* users.findById(created.id)));
        assert.strictEqual((yield* audit.list({ eventTag: "auth.user.signedIn" })).length, 1);

        const replay = yield* magicLink.verify({ token }).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "MagicLinkConsumed");
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "a brand-new address creates the user only when the link is presented, through the BeforeSignUp veto",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const audit = yield* AuditLog.AuditLog;
        const { token } = yield* requestAndRead("new@example.com");
        // Requesting created no one...
        assert.isTrue(Option.isNone(yield* users.findByEmail("new@example.com")));
        const issued = yield* magicLink.verify({ token });
        // ...presenting the link does, verified, announced.
        const created = Option.getOrThrow(yield* users.findByEmail("new@example.com"));
        assert.strictEqual(issued.session.userId, created.id);
        assert.isTrue(Users.isEmailVerified(created));
        assert.strictEqual((yield* audit.list({ eventTag: "auth.user.created" })).length, 1);
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("an expired link fails MagicLinkConsumed", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const { token } = yield* requestAndRead("late@example.com");
      yield* TestClock.adjust(Duration.minutes(10));
      const failure = yield* magicLink.verify({ token }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MagicLinkConsumed");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a token of another purpose, or garbage, is refused before anything is consumed", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const verification = yield* Verification.Verification;
      const other = yield* verification.issue({
        identifier: "reset-password:abc",
        ttl: Duration.minutes(5),
      });
      for (const raw of ["", "nonsense", `reset-password:abc.${Redacted.value(other.value)}`]) {
        const failure = yield* magicLink.verify({ token: Redacted.make(raw) }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MagicLinkConsumed");
      }
      // The other purpose's token was never touched: it still consumes for its own endpoint.
      yield* verification.consume("reset-password:abc", other.value);
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a BeforeSignIn veto refuses (HookAborted) and no session is issued", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const audit = yield* AuditLog.AuditLog;
      const { token } = yield* requestAndRead("banned@example.com");
      const failure = yield* magicLink.verify({ token }).pipe(Effect.flip);
      if (failure._tag !== "HookAborted") return assert.fail(failure._tag);
      assert.strictEqual(failure.code, "USER_BANNED");
      assert.strictEqual((yield* audit.list({ eventTag: "auth.session.issued" })).length, 0);
    }).pipe(
      // A tap requires its point: provide the composition's own to it (per-composition registry, ELC-001).
      Effect.provide(
        Hooks.BeforeSignIn.tap((input) =>
          input.email === "banned@example.com"
            ? Effect.fail(new HookPoint.HookAbort({ code: "USER_BANNED" }))
            : Effect.succeed(input),
        ).pipe(Layer.provideMerge(buildLayer())),
      ),
    ),
  );

  it.effect("a suspended user gets no session", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "susp@example.com" },
        name: "S",
      });
      const { token } = yield* requestAndRead("susp@example.com");
      yield* users.setStatus(user.id, "suspended");
      const failure = yield* magicLink.verify({ token }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "UserSuspended");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "ARF-005 Fix A: a user with a confirmed second factor is diverted to TwoFactorRequired, and mints no session",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const twoFactor = yield* TwoFactor.TwoFactor;
        const audit = yield* AuditLog.AuditLog;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "mfa@example.com" },
          name: "M",
        });
        // Enrol: a fresh session for the user, enable, confirm with a real TOTP.
        const fresh = yield* sessions.issue({ userId: user.id });
        const enrolment = yield* twoFactor.enable(user.id, fresh.session.id);
        const crypto = yield* Crypto.Crypto;
        const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
        const code = yield* Totp.totp(crypto, key, now, { period: 30, digits: 6 });
        yield* twoFactor.confirm(user.id, Redacted.make(code));
        const before = (yield* audit.list({ eventTag: "auth.session.issued" })).length;

        const { token } = yield* requestAndRead("mfa@example.com");
        const failure = yield* magicLink.verify({ token }).pipe(Effect.flip);
        if (failure._tag !== "TwoFactorRequired") return assert.fail(failure._tag);
        assert.strictEqual(failure.userId, user.id);
        assert.isString(failure.challengeId);
        assert.strictEqual((yield* audit.list({ eventTag: "auth.session.issued" })).length, before);

        // The challenge records that the first factor was the mailbox: the finished session says so.
        const factor = yield* SecondFactor.SecondFactor;
        const consumed = yield* factor.consumeChallenge(Redacted.make(failure.challengeId));
        assert.deepStrictEqual(consumed.amr, ["email"]);
        assert.strictEqual(consumed.strategy, "magicLink");
      }).pipe(Effect.provide(buildLayer().pipe(Layer.provide(NodeCrypto.layer)))),
  );
});
