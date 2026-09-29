// verification-token-delivery + mail-delivery-reliability: MLO-009, ARF-009,
// EOTS-010, EEM-002, ERS-002 as seen from the password plugin.
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
import * as TestClock from "effect/testing/TestClock";
import * as Password from "../src/Password.ts";
import { email, letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

describe("MLO-009/EOTS-010: mail data", () => {
  it.effect("the mailed token is Redacted and String(data) does not reveal it", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      yield* password.signUp({ email, password: strongPassword });
      yield* letForkedFibersRun;
      const mail = (yield* mailer.sent).find((m) => m.template === "verify-email");
      const token = mail?.data?.["token"];
      assert.isTrue(Redacted.isRedacted(token));
      assert.notInclude(String(token), tokenOf(mail));
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("mail data carries expiresAt, and a url only when a link builder is configured", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const mailer = yield* Mailer.Mailer;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      yield* letForkedFibersRun;
      const sent = yield* mailer.sent;
      const verify = sent.find((m) => m.template === "verify-email");
      const reset = sent.find((m) => m.template === "reset-password");
      for (const mail of [verify, reset]) {
        assert.isString(mail?.data?.["expiresAt"]);
        assert.isTrue(DateTime.isDateTime(DateTime.makeUnsafe(String(mail?.data?.["expiresAt"]))));
      }
      assert.strictEqual(reset?.data?.["url"], `https://app.example/reset#${tokenOf(reset)}`);
      assert.strictEqual(verify?.data?.["url"], undefined);
    }).pipe(
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
      const mailer = yield* Mailer.Mailer;
      const users = yield* Users.Users;
      yield* password.signUp({ email, password: strongPassword });
      yield* password.requestReset({ email });
      yield* letForkedFibersRun;
      const userId = Option.getOrThrow(yield* users.findByEmail(email)).id;
      for (const mail of yield* mailer.sent) {
        assert.notInclude(tokenOf(mail), userId);
        // UUIDv7 puts a millisecond timestamp in its first 48 bits.
        assert.notInclude(tokenOf(mail), userId.slice(0, 8));
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );
});

/** A `Mailer` whose first `failures` sends fail with `MailDeliveryFailed`, then succeed and record. */
const flakyMailer = (failures: number, retryable: boolean) =>
  Layer.effect(
    Mailer.Mailer,
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const messages = yield* Ref.make<ReadonlyArray<Mailer.MailMessage>>([]);
      return Mailer.Mailer.of({
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
                : Ref.update(messages, (all) => [...all, message]),
            ),
          ),
        sent: Ref.get(messages),
      });
    }),
  );

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("EEM-002/ERS-002: delivery failure policy", () => {
  it.effect(
    "requestReset answers uniformly and the mail is retried until the provider recovers",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const mailer = yield* Mailer.Mailer;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* settle;
        const sent = yield* mailer.sent;
        // signUp's verification mail hit the first failure; both mails land once retried.
        assert.strictEqual(sent.filter((m) => m.template === "reset-password").length, 1);
        assert.strictEqual(sent.filter((m) => m.template === "verify-email").length, 1);
      }).pipe(Effect.provide(makeTestLayer({ mailer: flakyMailer(1, true) }))),
  );

  it.effect(
    "a permanently failing Mailer publishes auth.mail.failed with no recipient or token",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        const events = yield* AuthEvents.AuthEvents;
        const failed = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((event) => event._tag === "auth.mail.failed"),
            Stream.take(1),
            Stream.runCollect,
          ),
          { startImmediately: true },
        );
        yield* password.signUp({ email, password: strongPassword });
        yield* settle;
        const collected = yield* Fiber.join(failed);
        const serialized = JSON.stringify(collected);
        assert.include(serialized, "verify-email");
        assert.notInclude(serialized, email);
      }).pipe(Effect.provide(makeTestLayer({ mailer: flakyMailer(100, false) }))),
  );
});
