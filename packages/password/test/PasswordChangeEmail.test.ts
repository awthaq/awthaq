// BAM-009 step 3 (BEH-EA-042/057/058): the mailed change-email flow — request mails a
// `change-email` token to the NEW address and changes nothing; confirming it replaces the
// address, marks it verified and tells the old address, all in one transaction with the
// token's consumption.
import { AuthEvents, Users } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Password from "../src/Password.ts";
import { email, letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

const newEmail = "ada.lovelace@example.org";

const changeEmailMail = (mails: ReadonlyArray<Mailer.MailMessage>) =>
  mails.filter((mail) => mail.template === "change-email");

/** Signs up and returns the account's id (the mail `signUp` dispatches is ignored). */
const signedUpUser = (address = email) =>
  Effect.gen(function* () {
    const password = yield* Password.Password;
    const users = yield* Users.Users;
    yield* password.signUp({ email: address, password: strongPassword });
    yield* letForkedFibersRun;
    return Option.getOrThrow(yield* users.findByEmail(address));
  });

describe("BAM-009: request", () => {
  it.effect("mails a change-email token to the new address only and changes nothing yet", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const [mail, ...rest] = changeEmailMail(yield* mailer.sent);
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(mail?.to, newEmail);
      // The token is a credential: Redacted, and not the user's id.
      assert.isTrue(Redacted.isRedacted(mail?.data?.["token"]));
      assert.notInclude(tokenOf(mail), user.id);
      // The address is still the old one, and the new one is free.
      assert.strictEqual(Users.emailOf(yield* users.findById(user.id)).pipe(Option.getOrThrow), email);
      assert.isTrue(Option.isNone(yield* users.findByEmail(newEmail)));
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("the same address (in any case) is a no-op and sends nothing", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      yield* password.requestEmailChange({ userId: user.id, newEmail: email.toUpperCase() });
      assert.strictEqual(changeEmailMail(yield* mailer.sent).length, 0);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("a link builder puts the confirmation URL in the mail", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const mail = changeEmailMail(yield* mailer.sent)[0];
      assert.strictEqual(mail?.data?.["url"], `https://app.example/confirm-email#${tokenOf(mail)}`);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          config: { links: { changeEmail: (token) => `https://app.example/confirm-email#${token}` } },
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
        const mailer = yield* Mailer.Mailer;
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
        yield* password.requestEmailChange({ userId: user.id, newEmail });
        const token = Redacted.make(tokenOf(changeEmailMail(yield* mailer.sent)[0]));

        yield* password.confirmEmailChange({ token });
        yield* letForkedFibersRun;

        const changed = yield* users.findById(user.id);
        assert.strictEqual(Option.getOrThrow(Users.emailOf(changed)), newEmail);
        assert.isTrue(Users.isEmailVerified(changed));
        assert.isTrue(Option.isNone(yield* users.findByEmail(email)));
        assert.include(yield* Ref.get(seen), "auth.user.emailChanged");
        // The previous address is told (template only, no data), the new one is not re-mailed.
        const notice = (yield* mailer.sent).filter((mail) => mail.template === "email-changed");
        assert.deepStrictEqual(
          notice.map((mail) => mail.to),
          [email],
        );
        assert.isUndefined(notice[0]?.data);
      }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  );

  it.effect("the token is single-use", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const token = Redacted.make(tokenOf(changeEmailMail(yield* mailer.sent)[0]));
      yield* password.confirmEmailChange({ token });
      const replay = yield* password.confirmEmailChange({ token }).pipe(Effect.flip);
      assert.strictEqual(replay._tag, "TokenConsumed");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("an address taken in the meantime is EmailAlreadyExists and the address stays", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const token = Redacted.make(tokenOf(changeEmailMail(yield* mailer.sent)[0]));
      yield* signedUpUser(newEmail);
      const failure = yield* password.confirmEmailChange({ token }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailAlreadyExists");
      assert.strictEqual(
        Option.getOrThrow(Users.emailOf(yield* users.findById(user.id))),
        email,
      );
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("a token of another purpose is refused, and a change-email token cannot verify an address", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      const user = yield* signedUpUser();
      const verifyMail = (yield* mailer.sent).find((mail) => mail.template === "verify-email");
      const crossed = yield* password
        .confirmEmailChange({ token: Redacted.make(tokenOf(verifyMail)) })
        .pipe(Effect.flip);
      assert.strictEqual(crossed._tag, "TokenConsumed");
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const changeMail = changeEmailMail(yield* mailer.sent)[0];
      const other = yield* password
        .verifyEmail({ token: Redacted.make(tokenOf(changeMail)) })
        .pipe(Effect.flip);
      assert.strictEqual(other._tag, "TokenConsumed");
      // Malformed input is a dead token, not a defect.
      const junk = yield* password
        .confirmEmailChange({ token: Redacted.make("not-a-token") })
        .pipe(Effect.flip);
      assert.strictEqual(junk._tag, "TokenConsumed");
    }).pipe(Effect.provide(makeTestLayer())),
  );
});

describe("BAM-009: typed mail failure and rate limits", () => {
  const failingMailer = Layer.succeed(
    Mailer.Mailer,
    Mailer.Mailer.of({
      send: (message) =>
        Effect.fail(
          new Mailer.MailDeliveryFailed({
            template: message.template,
            reason: "provider down",
            retryable: true,
          }),
        ),
      sent: Effect.succeed([]),
    }),
  );

  it.effect("the authenticated requester sees EmailDeliveryFailed, not a silent success", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      // signUp's own mail is dispatched in the background and lost quietly; create the user directly.
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
      const failure = yield* password
        .requestEmailChange({ userId: user.id, newEmail })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailDeliveryFailed");
    }).pipe(Effect.provide(makeTestLayer({ mailer: failingMailer }))),
  );

  it.effect("a phone-only account has no address to replace", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const user = yield* users.create({ identity: { _tag: "Anonymous" }, name: "Guest" });
      const failure = yield* password
        .requestEmailChange({ userId: user.id, newEmail })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "EmailChangeNotSupported");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

  it.effect("a requester is budgeted, and so is one target inbox across requesters", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Ada" });
      const other = yield* users.create({
        identity: { _tag: "Email", email: "grace@example.com" },
        name: "Grace",
      });
      // The target inbox: 3 per 15 minutes, however many accounts ask.
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      yield* password.requestEmailChange({ userId: other.id, newEmail });
      yield* password.requestEmailChange({ userId: user.id, newEmail });
      const limited = yield* password
        .requestEmailChange({ userId: other.id, newEmail })
        .pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
      // The requester: 5 per hour to different targets (two of them are spent above).
      for (let i = 0; i < 3; i++) {
        yield* password.requestEmailChange({ userId: user.id, newEmail: `t${i}@example.org` });
      }
      const requesterLimited = yield* password
        .requestEmailChange({ userId: user.id, newEmail: "t99@example.org" })
        .pipe(Effect.flip);
      assert.strictEqual(requesterLimited._tag, "RateLimited");
    }).pipe(Effect.provide(makeTestLayer({ limiter: realLimiter }))),
  );
});
