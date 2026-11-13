// BAM-007, MLO-005, MLO-002, ARF-005 Fix A (BEH-EA-267 to BEH-EA-270): the MagicLink plugin at the
// domain level — real in-memory stores, the real mail dispatcher, the real `@awthaq/two-factor`
// gates for the MFA divert.
import { TestAuth, TestMailbox } from "@awthaq/test";
import { AuditLog, Sessions, Users } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { SignInProbe } from "@awthaq/test";
import { SecondFactor, Totp, TwoFactor } from "@awthaq/two-factor";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Mac from "effect/crypto/Mac";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as MagicLink from "../src/MagicLink.ts";
import { buildLayer, realLimiter } from "./support/harness.ts";

const outage = Ref.makeUnsafe(true);

const requestAndRead = (email: string) =>
  Effect.gen(function* () {
    const magicLink = yield* MagicLink.MagicLink;
    const box = yield* TestMailbox.Mailbox;
    const match = { to: email, template: "magic-link" };
    const before = (yield* box.mail.messages).filter(
      (m) => m.to === email && m.template === "magic-link",
    ).length;
    yield* magicLink.requestLink({ email });
    const mail = yield* box.mail.waitFor(match, { nth: before + 1 });
    return { mail, token: Redacted.make(TestMailbox.secret(mail)) };
  });

describe("MagicLink.requestLink (BEH-EA-268)", () => {
  it.effect(
    "answers identically for a known and an unknown address, and with sign-up off mails only the known one",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const box = yield* TestMailbox.Mailbox;
        yield* users.create({ identity: { _tag: "Email", email: "ada@example.com" }, name: "Ada" });

        // Both requests resolve to the same `void`, whatever exists behind them.
        const known = yield* magicLink.requestLink({ email: "ada@example.com" });
        const unknown = yield* magicLink.requestLink({ email: "nobody@example.com" });
        assert.strictEqual(known, unknown);
        yield* box.mail.waitFor({ template: "magic-link" });
        yield* box.mail.refute({ template: "magic-link" }, { beyond: 1 });

        const sent = yield* box.mail.messages;
        assert.deepStrictEqual(
          sent.map((mail) => [mail.template, mail.to]),
          [["magic-link", "ada@example.com"]],
        );
        // The token names neither the user nor the address (ARF-009).
        const token = TestMailbox.secret(sent[0]!);
        const userId = Option.getOrThrow(yield* users.findByEmail("ada@example.com")).id;
        assert.notInclude(token, userId);
        // The whole address, plain or base64url-encoded. A bare "ada" would be a coin toss: a
        // random base64url token contains any given three characters once in a few thousand runs.
        assert.notInclude(token, "ada@example.com");
        assert.notInclude(token, Buffer.from("ada@example.com").toString("base64url"));
        assert.isTrue(token.startsWith("magic-link:"));
        // Sign-up is off: asking for a link never created anyone.
        assert.isTrue(Option.isNone(yield* users.findByEmail("nobody@example.com")));
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(buildLayer({ magicLink: { allowSignUp: false } })),
      ),
  );

  it.effect(
    "ADR-EA-018 D8 (plan 36): magic link configuration is per deployment; a calling-fiber override is not read",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const box = yield* TestMailbox.Mailbox;
        yield* magicLink
          .requestLink({ email: "stranger@example.com" })
          .pipe(Effect.provide(MagicLink.config({ allowSignUp: false })));
        const mail = yield* box.mail.waitFor({
          to: "stranger@example.com",
          template: "magic-link",
        });
        assert.strictEqual(mail.to, "stranger@example.com");
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer())),
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
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(buildLayer({ magicLink: { baseUrl: "https://app.example.com" } })),
    ),
  );

  it.effect("MLO-002: an address is mailed at most one link per resend window", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const box = yield* TestMailbox.Mailbox;
      const match = { to: "again@example.com", template: "magic-link" };
      for (let i = 0; i < 3; i += 1) yield* magicLink.requestLink({ email: "again@example.com" });
      yield* box.mail.waitFor(match);
      yield* box.mail.refute(match, { beyond: 1 });
      yield* TestClock.adjust(Duration.seconds(61));
      yield* magicLink.requestLink({ email: "again@example.com" });
      yield* box.mail.waitFor(match, { nth: 2 });
      yield* box.mail.refute(match, { beyond: 2 });
    }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer())),
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
    }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer({ limiter: realLimiter }))),
  );
});

describe("MagicLink.verify (BEH-EA-269)", () => {
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
        const issued = yield* magicLink.verify({ token });
        assert.strictEqual(issued.session.userId, created.id);
        assert.deepStrictEqual(issued.session.amr, ["email"]);
        assert.isTrue(Users.isEmailVerified(yield* users.findById(created.id)));
        assert.strictEqual((yield* audit.list({ eventTag: "auth.user.signedIn" })).length, 1);

        const replay = yield* magicLink.verify({ token }).pipe(Effect.flip);
        assert.strictEqual(replay._tag, "MagicLinkConsumed");
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer())),
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
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer())),
  );

  it.effect(
    "ADR-EA-038 wiring: hands SignIn strategy magicLink and amr [email], and a new address reaches BeforeSignUp with that strategy",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const probe = yield* SignInProbe.SignInProbe;
        const { token } = yield* requestAndRead("probe@example.com");
        yield* magicLink.verify({ token });
        const recorded = yield* probe.recorded;
        assert.deepStrictEqual(
          recorded.beforeSignUp.map((input) => [input.email, input.strategy]),
          [["probe@example.com", "magicLink"]],
        );
        assert.deepStrictEqual(
          recorded.beforeSessionIssue.map((input) => [input.strategy, input.amr]),
          [["magicLink", ["email"]]],
        );
        assert.deepStrictEqual(
          recorded.afterSignIn.map((input) => input.strategy),
          ["magicLink"],
        );
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(SignInProbe.layer.pipe(Layer.provideMerge(buildLayer()))),
      ),
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
        const mac = yield* Mac.Mac;
        const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
        const code = yield* Totp.totp(mac, key, now, { period: 30, digits: 6 });
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
        const consumed = yield* factor.redeemChallenge(
          Redacted.make(failure.challengeId),
          Effect.succeed,
        );
        assert.deepStrictEqual(consumed.amr, ["email"]);
        assert.strictEqual(consumed.strategy, "magicLink");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(buildLayer().pipe(Layer.provide(NodeCrypto.layer))),
      ),
  );
});

describe("MagicLink.verify redeems the link (ADR-EA-039)", () => {
  it.effect(
    "an outage while issuing the session leaves the link usable: the same link signs in once the store is back",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: "outage@example.com" },
          name: "O",
        });
        const { token } = yield* requestAndRead("outage@example.com");
        const down = yield* magicLink.verify({ token }).pipe(Effect.flip);
        assert.strictEqual(down._tag, "StoreUnavailable");
        const issued = yield* Ref.set(outage, false).pipe(
          Effect.andThen(magicLink.verify({ token })),
        );
        assert.strictEqual(issued.session.userId, created.id);
      }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer({ failSessionIssue: outage }))),
  );

  it.effect(
    "a link diverted to the second factor is spent: presenting it again fails MagicLinkConsumed, and the challengeId it returned is live",
    () =>
      Effect.gen(function* () {
        const magicLink = yield* MagicLink.MagicLink;
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const twoFactor = yield* TwoFactor.TwoFactor;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "divert@example.com" },
          name: "D",
        });
        const fresh = yield* sessions.issue({ userId: user.id });
        const enrolment = yield* twoFactor.enable(user.id, fresh.session.id);
        const mac = yield* Mac.Mac;
        const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
        yield* twoFactor.confirm(
          user.id,
          Redacted.make(yield* Totp.totp(mac, key, now, { period: 30, digits: 6 })),
        );
        const { token } = yield* requestAndRead("divert@example.com");
        const diverted = yield* magicLink.verify({ token }).pipe(Effect.flip);
        if (diverted._tag !== "TwoFactorRequired") return assert.fail(diverted._tag);
        const again = yield* magicLink.verify({ token }).pipe(Effect.flip);
        assert.strictEqual(again._tag, "MagicLinkConsumed");
        const factor = yield* SecondFactor.SecondFactor;
        const challenge = yield* factor.redeemChallenge(
          Redacted.make(diverted.challengeId),
          Effect.succeed,
        );
        assert.strictEqual(challenge.strategy, "magicLink");
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(buildLayer().pipe(Layer.provide(NodeCrypto.layer))),
      ),
  );

  it.effect("a suspended user's refusal spends the link (refusals commit)", () =>
    Effect.gen(function* () {
      const magicLink = yield* MagicLink.MagicLink;
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "held@example.com" },
        name: "H",
      });
      yield* users.setStatus(user.id, "suspended", { reason: "test" });
      const { token } = yield* requestAndRead("held@example.com");
      const first = yield* magicLink.verify({ token }).pipe(Effect.flip);
      assert.strictEqual(first._tag, "UserSuspended");
      yield* users.setStatus(user.id, "active");
      const second = yield* magicLink.verify({ token }).pipe(Effect.flip);
      assert.strictEqual(second._tag, "MagicLinkConsumed");
    }).pipe(TestAuth.withoutRequest, Effect.provide(buildLayer())),
  );
});

describe("MagicLink.config (BEH-EA-355)", () => {
  it.effect("provides the deployment marker for its key", () =>
    Effect.gen(function* () {
      // Compiles only while the constructor's output carries the marker.
      const layer: Layer.Layer<Tenant.DeploymentConfigApplied> = MagicLink.config({});
      const marker = yield* Tenant.DeploymentConfigApplied.pipe(Effect.provide(layer));
      assert.strictEqual(marker.key, MagicLink.MagicLinkConfig.key);
    }),
  );
});
