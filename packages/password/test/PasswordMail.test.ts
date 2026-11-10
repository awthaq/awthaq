// verification-token-delivery + mail-delivery-reliability: MLO-009, ARF-009,
// EOTS-010, EEM-002, ERS-002 as seen from the password plugin.
import { TestAuth, TestMailbox } from "@awthaq/test";
import { AuthEvents, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Password from "../src/Password.ts";
import { email, makeTestLayer, strongPassword } from "./harness.ts";

describe("MLO-009/EOTS-010: mail data", () => {
  it.effect("the mailed token is Redacted and String(data) does not reveal it", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* password.signUp({ email, password: strongPassword });
      const mail = yield* (yield* TestMailbox.Mailbox).mail.waitFor({
        template: "verify-email",
      });
      const token = mail.data?.["token"];
      assert.isTrue(Redacted.isRedacted(token));
      assert.notInclude(String(token), TestMailbox.secret(mail));
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );

  it.effect("mail data carries expiresAt, and a url only when a link builder is configured", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const box = yield* TestMailbox.Mailbox;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      const verify = yield* box.mail.waitFor({ template: "verify-email" });
      const reset = yield* box.mail.waitFor({ template: "reset-password" });
      for (const mail of [verify, reset]) {
        assert.isString(mail.data?.["expiresAt"]);
        assert.isTrue(DateTime.isDateTime(DateTime.makeUnsafe(String(mail.data?.["expiresAt"]))));
      }
      assert.strictEqual(
        reset.data?.["url"],
        `https://app.example/reset#${TestMailbox.secret(reset)}`,
      );
      assert.strictEqual(verify.data?.["url"], undefined);
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(
        makeTestLayer({
          config: { links: { resetPassword: (token) => `https://app.example/reset#${token}` } },
        }),
      ),
    ),
  );
});

describe("ARF-009: opaque token identifiers", () => {
  it.effect("reset and verify mail tokens do not contain the userId", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const box = yield* TestMailbox.Mailbox;
      const users = yield* Users.Users;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      yield* box.mail.waitFor({ template: "verify-email" });
      yield* box.mail.waitFor({ template: "reset-password" });
      const userId = Option.getOrThrow(yield* users.findByEmail(email)).id;
      for (const mail of yield* box.mail.messages) {
        assert.notInclude(TestMailbox.secret(mail), userId);
        // UUIDv7 puts a millisecond timestamp in its first 48 bits.
        assert.notInclude(TestMailbox.secret(mail), userId.slice(0, 8));
      }
    }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer())),
  );
});

/**
 * A `Mailer` whose first `failures` sends fail with `MailDeliveryFailed`, then succeed; `delivered` is every message
 * that got through, observable as it grows (the base `TestMailbox` is replaced, so it records nothing here).
 */
const flakyMailer = (failures: number, retryable: boolean) => {
  const attempts = Ref.makeUnsafe(0);
  const delivered = Effect.runSync(SubscriptionRef.make<ReadonlyArray<Mailer.MailMessage>>([]));
  const layer = Layer.mock(Mailer.Mailer)({
    send: (message) =>
      Ref.getAndUpdate(attempts, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n < failures
            ? Effect.fail(
                new Mailer.MailDeliveryFailed({
                  template: message.template,
                  reason: "provider down",
                  retryable,
                }),
              )
            : SubscriptionRef.update(delivered, (all) => [...all, message]),
        ),
      ),
  });
  return { layer, delivered };
};

// Orders `TestClock`, not mail: the failed first attempt must reach its retry sleep before `TestClock.adjust` can wake it.
const letRetryArm = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("EEM-002/ERS-002: delivery failure policy", () => {
  it.effect(
    "requestReset answers uniformly and the mail is retried until the provider recovers",
    () => {
      const flaky = flakyMailer(1, true);
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        yield* letRetryArm;
        yield* TestClock.adjust(Duration.seconds(30));
        const sent = Option.getOrThrow(
          yield* Stream.runHead(
            Stream.filter(SubscriptionRef.changes(flaky.delivered), (all) => all.length >= 2),
          ),
        );
        // signUp's verification mail hit the first failure; both mails land once retried.
        assert.strictEqual(sent.filter((m) => m.template === "reset-password").length, 1);
        assert.strictEqual(sent.filter((m) => m.template === "verify-email").length, 1);
      }).pipe(TestAuth.withoutRequest, Effect.provide(makeTestLayer({ mailer: flaky.layer })));
    },
  );

  it.effect(
    "a permanently failing Mailer publishes auth.mail.failed with no recipient or token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const events = yield* AuthEvents.AuthEvents;
        const failed = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter(AuthEvents.is("auth.mail.failed")),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        yield* password.signUp({ email, password: strongPassword });
        const collected = yield* Fiber.join(failed);
        const serialized = JSON.stringify(collected);
        assert.include(serialized, "verify-email");
        assert.notInclude(serialized, email);
      }).pipe(
        TestAuth.withoutRequest,
        Effect.provide(makeTestLayer({ mailer: flakyMailer(100, false).layer })),
      ),
  );
});
