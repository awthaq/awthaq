// BAM-009 step 3 (BEH-EA-042/057/058): the mailed change-email flow — request mails a
// `change-email` token to the NEW address and changes nothing; confirming it replaces the
// address, marks it verified and tells the old address, all in one transaction with the
// token's consumption.
import { TestAuth, TestMailbox } from "@awthaq/test";
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Password from "../src/Password.ts";
import { email, makeTestLayer, strongPassword } from "./harness.ts";

const newEmail = "ada.lovelace@example.org";

const changeEmail = { template: "change-email" };

/** Starts an email change from a fresh session of `userId`, the way the endpoint does. */
const requestChange = (userId: Users.UserId, requested: string) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const sessions = yield* Sessions.Sessions;
    const { session } = yield* sessions.issue({ userId });
    return yield* password.requestEmailChange({
      userId,
      currentSessionId: session.id,
      newEmail: requested,
    });
  });

/** Signs up and returns the account's id (the mail `signUp` dispatches is ignored). */
const signedUpUser = (address = email) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const users = yield* Users.Users;
    yield* password.signUp({ email: address, password: strongPassword });
    yield* (yield* TestMailbox.Mailbox).mail.waitFor({
      to: address,
      template: "verify-email",
    });
    return Option.getOrThrow(yield* users.findByEmail(address));
  });

describe("BAM-009: request", () => {
  it.effect("mails a change-email token to the new address only and changes nothing yet", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const box = yield* TestMailbox.Mailbox;
      const user = yield* signedUpUser();
      yield* requestChange(user.id, newEmail);
      const mail = yield* box.mail.waitFor(changeEmail);
      yield* box.mail.refute(changeEmail, { beyond: 1 });
      assert.strictEqual(mail.to, newEmail);
      // The token is a credential: Redacted, and not the user's id.
      assert.isTrue(Redacted.isRedacted(mail.data?.["token"]));
      assert.notInclude(TestMailbox.secret(mail), user.id);
      // The address is still the old one, and the new one is free.
      assert.strictEqual(
        Users.emailOf(yield* users.findById(user.id)).pipe(Option.getOrThrow),
        email,
      );
      assert.isTrue(Option.isNone(yield* users.findByEmail(newEmail)));
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("the same address (in any case) is a no-op and sends nothing", () =>
    Effect.gen(function* () {
      const user = yield* signedUpUser();
      yield* requestChange(user.id, email.toUpperCase());
      yield* (yield* TestMailbox.Mailbox).mail.refute(changeEmail);
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("a link builder puts the confirmation URL in the mail", () =>
    Effect.gen(function* () {
      const user = yield* signedUpUser();
      yield* requestChange(user.id, newEmail);
      const mail = yield* (yield* TestMailbox.Mailbox).mail.waitFor(changeEmail);
      assert.strictEqual(
        mail.data?.["url"],
        `https://app.example/confirm-email#${TestMailbox.secret(mail)}`,
      );
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(
        makeTestLayer({
          config: {
            links: { changeEmail: (token) => `https://app.example/confirm-email#${token}` },
          },
        }),
      ),
    ),
  );
});

describe("BAM-009: confirm", () => {
  it.effect(
    "replaces the address, marks it verified, publishes auth.user.emailChanged and tells the old address",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const users = yield* Users.Users;
        const box = yield* TestMailbox.Mailbox;
        const events = yield* AuthEvents.AuthEvents;
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const subscription = yield* events.subscribe;
        yield* Effect.forkScoped(
          subscription.pipe(
            Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event._tag])),
          ),
          { startImmediately: true },
        );
        const user = yield* signedUpUser();
        yield* requestChange(user.id, newEmail);
        const token = Redacted.make(TestMailbox.secret(yield* box.mail.waitFor(changeEmail)));

        yield* password.confirmEmailChange({ token });
        // The previous address is told (template only, no data), the new one is not re-mailed.
        const notice = yield* box.mail.waitFor({ template: "email-changed" });
        yield* box.mail.refute({ template: "email-changed" }, { beyond: 1 });

        const changed = yield* users.findById(user.id);
        assert.strictEqual(Option.getOrThrow(Users.emailOf(changed)), newEmail);
        assert.isTrue(Users.isEmailVerified(changed));
        assert.isTrue(Option.isNone(yield* users.findByEmail(email)));
        assert.include(yield* Ref.get(seen), "auth.user.emailChanged");
        assert.strictEqual(notice.to, email);
        assert.isUndefined(notice.data);
      }).pipe(Effect.scoped, TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  // BEH-EA-053 (REQ-EA-686): an email change is a privilege change. It is confirmed by a token that
  // may be opened anywhere, so there is no caller session to rotate: every session of the account
  // ends (reason `emailChanged`) and the owner signs in afresh under the new address.
  it.effect("ends every session of the account, with reason emailChanged", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const sessions = yield* Sessions.Sessions;
      const box = yield* TestMailbox.Mailbox;
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
      const subscription = yield* events.subscribe;
      yield* Effect.forkScoped(
        subscription.pipe(
          Stream.filter(AuthEvents.is(AuthEvents.eventTags)),
          Stream.runForEach((event) => Ref.update(seen, (all) => [...all, event])),
        ),
        { startImmediately: true },
      );
      const users = yield* Users.Users;
      // The sign-up session is the live one (sign-in would need the mailbox verified first).
      const signedIn = yield* password.signUp({
        email,
        password: strongPassword,
      });
      const user = Option.getOrThrow(yield* users.findByEmail(email));
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(sessions.verify(signedIn.token))));
      yield* requestChange(user.id, newEmail);
      const token = Redacted.make(TestMailbox.secret(yield* box.mail.waitFor(changeEmail)));

      yield* password.confirmEmailChange({ token });
      yield* box.mail.waitFor({ template: "email-changed" });

      const stale = yield* sessions.verify(signedIn.token).pipe(Effect.flip);
      assert.strictEqual(stale._tag, "Sessions/NotFound");
      assert.deepStrictEqual(yield* sessions.list(user.id), []);
      const revoked = (yield* Ref.get(seen)).filter(
        (event) => event._tag === "auth.session.revoked" && event.reason === "emailChanged",
      );
      assert.isAbove(revoked.length, 0);
    }).pipe(Effect.scoped, TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("an address taken in the meantime is EmailAlreadyExists and the address stays", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const user = yield* signedUpUser();
      yield* requestChange(user.id, newEmail);
      const token = Redacted.make(
        TestMailbox.secret(yield* (yield* TestMailbox.Mailbox).mail.waitFor(changeEmail)),
      );
      yield* signedUpUser(newEmail);
      const failure = yield* password.confirmEmailChange({ token }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailAlreadyExists");
      assert.strictEqual(Option.getOrThrow(Users.emailOf(yield* users.findById(user.id))), email);
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );
});

describe("BAM-009: typed mail failure and rate limits", () => {
  const failingMailer = Layer.mock(Mailer.Mailer)({
    send: (message) =>
      Effect.fail(
        new Mailer.MailDeliveryFailed({
          template: message.template,
          reason: "provider down",
          retryable: true,
        }),
      ),
  });

  it.effect("the authenticated requester sees EmailDeliveryFailed, not a silent success", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      // signUp's own mail is dispatched in the background and lost quietly; create the user directly.
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
      const failure = yield* requestChange(user.id, newEmail).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailDeliveryFailed");
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer({ mailer: failingMailer }))),
  );

  it.effect("a phone-only account has no address to replace", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest" });
      const failure = yield* requestChange(user.id, newEmail).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailChangeNotSupported");
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

  it.effect("a requester is budgeted, and so is one target inbox across requesters", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
      const other = yield* users.create({
        identity: { _tag: "Email", email: "grace@example.com" },
        name: "Grace",
      });
      // The target inbox: 3 per 15 minutes, however many accounts ask.
      yield* requestChange(user.id, newEmail);
      yield* requestChange(other.id, newEmail);
      yield* requestChange(user.id, newEmail);
      const limited = yield* requestChange(other.id, newEmail).pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
      // The requester: 5 per hour to different targets (two of them are spent above).
      for (let i = 0; i < 3; i++) {
        yield* requestChange(user.id, `t${i}@example.org`);
      }
      const requesterLimited = yield* requestChange(user.id, "t99@example.org").pipe(Effect.flip);
      assert.strictEqual(requesterLimited._tag, "RateLimited");
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer({ limiter: realLimiter }))),
  );
});

describe("BEH-EA-320: starting an email change needs a fresh session", () => {
  it.effect(
    "a stale session gets PasswordReauthRequired; reauthenticating then retrying succeeds",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const box = yield* TestMailbox.Mailbox;
        const issued = yield* password.signUp({
          email,
          password: strongPassword,
        });
        const request = password.requestEmailChange({
          userId: issued.session.userId,
          currentSessionId: issued.session.id,
          newEmail,
        });

        // `PasswordConfig.reauthMaxAge` defaults to 5 minutes.
        yield* TestClock.adjust(Duration.minutes(6));
        const refused = yield* request.pipe(Effect.flip);
        if (refused._tag !== "PasswordReauthRequired") return assert.fail(refused._tag);
        assert.strictEqual(refused.maxAgeSeconds, 300);
        // Nothing was mailed and the target inbox's budget was not spent.
        yield* box.mail.refute(changeEmail);

        yield* password.reauthenticate({
          userId: issued.session.userId,
          currentSessionId: issued.session.id,
          currentPassword: strongPassword,
        });
        yield* request;
        yield* box.mail.waitFor(changeEmail);
        yield* box.mail.refute(changeEmail, { beyond: 1 });
      }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("a session that has ended is refused the same way", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const sessions = yield* Sessions.Sessions;
      const issued = yield* password.signUp({ email, password: strongPassword });
      yield* sessions.revoke(issued.session.id, "signOut");
      const refused = yield* password
        .requestEmailChange({
          userId: issued.session.userId,
          currentSessionId: issued.session.id,
          newEmail,
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "PasswordReauthRequired");
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("reauthMaxAge: Duration.infinity turns the gate off", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const box = yield* TestMailbox.Mailbox;
      const issued = yield* password.signUp({
        email,
        password: strongPassword,
      });
      yield* TestClock.adjust(Duration.hours(2));
      yield* password.requestEmailChange({
        userId: issued.session.userId,
        currentSessionId: issued.session.id,
        newEmail,
      });
      yield* box.mail.waitFor(changeEmail);
      yield* box.mail.refute(changeEmail, { beyond: 1 });
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ config: { reauthMaxAge: Duration.infinity } })),
    ),
  );
});
