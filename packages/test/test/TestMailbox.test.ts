// BEH-EA-359: the test mailbox records every mail and SMS, waits for a match by subscription under a real-clock
// deadline (suites run under TestClock), refutes one within a real-time window, and reads a mailed secret.
import { Mailer, SmsSender } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as TestMailbox from "../src/TestMailbox.ts";

const verify = (to = "ada@example.com") => ({
  to,
  template: "verify-email",
  data: { token: Redacted.make("t") },
});

/** Sends after `ms` of real time on a detached fiber: the shape of a plugin's background mail. */
const sendLater = (message: Mailer.MailMessage, ms: number) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer.Mailer;
    yield* Effect.forkDetach(
      Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms))).pipe(
        Effect.andThen(mailer.send(message)),
      ),
    );
  });

describe("TestMailbox (BEH-EA-359)", () => {
  it.effect("waitFor returns a mail a detached fiber sends after real async work", () =>
    Effect.gen(function* () {
      const box = yield* TestMailbox.Mailbox;
      yield* sendLater(verify(), 20);
      const mail = yield* box.mail.waitFor({ template: "verify-email" });
      assert.strictEqual(mail.to, "ada@example.com");
    }).pipe(Effect.provide(TestMailbox.layer)),
  );

  it.effect("waitFor counts nth over matching messages and accepts a predicate", () =>
    Effect.gen(function* () {
      const box = yield* TestMailbox.Mailbox;
      const mailer = yield* Mailer.Mailer;
      yield* mailer.send({ to: "a", template: "x" });
      yield* mailer.send({ to: "b", template: "y" });
      yield* mailer.send({ to: "c", template: "x" });
      assert.strictEqual((yield* box.mail.waitFor({ template: "x" }, { nth: 2 })).to, "c");
      assert.strictEqual((yield* box.mail.waitFor((m) => m.to === "b")).template, "y");
    }).pipe(Effect.provide(TestMailbox.layer)),
  );

  it.effect(
    "waitFor dies at a real deadline naming the template and count, never the recipient",
    () =>
      Effect.gen(function* () {
        const box = yield* TestMailbox.Mailbox;
        const exit = yield* Effect.exit(
          box.mail.waitFor(
            { to: "ghost@example.com", template: "never" },
            { timeout: "40 millis" },
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        const text = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
        assert.include(text, "never");
        assert.include(text, "0");
        assert.notInclude(text, "ghost@example.com");
      }).pipe(Effect.provide(TestMailbox.layer)),
  );

  it.effect(
    "refute succeeds on silence and dies on a mail recorded before or inside the window",
    () =>
      Effect.gen(function* () {
        const box = yield* TestMailbox.Mailbox;
        yield* box.mail.refute({ template: "x" }, { window: "30 millis" });
        yield* sendLater({ to: "a", template: "x" }, 5);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(box.mail.refute({ template: "x" }, { window: "60 millis" })),
          ),
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(box.mail.refute({ template: "x" }))));
        // `beyond: 1` tolerates the one already recorded, and dies on a second.
        yield* box.mail.refute({ template: "x" }, { beyond: 1, window: "30 millis" });
        yield* sendLater({ to: "b", template: "x" }, 5);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              box.mail.refute({ template: "x" }, { beyond: 1, window: "60 millis" }),
            ),
          ),
        );
        assert.strictEqual((yield* box.mail.messages).length, 2);
      }).pipe(Effect.provide(TestMailbox.layer)),
  );

  it("secret unwraps a Redacted token, passes a string, and names what is missing", () => {
    assert.strictEqual(TestMailbox.secret(verify()), "t");
    assert.strictEqual(
      TestMailbox.secret({ template: "otp", data: { code: "123456" } }, "code"),
      "123456",
    );
    assert.throws(() => TestMailbox.secret({ template: "otp" }, "code"), /code.*otp|otp.*code/);
  });

  it.effect("the layer's senders are development-only and record into separate outboxes", () =>
    Effect.gen(function* () {
      const box = yield* TestMailbox.Mailbox;
      const mailer = yield* Mailer.Mailer;
      const sms = yield* SmsSender.SmsSender;
      assert.isTrue(mailer.development);
      assert.isTrue(sms.development);
      yield* sms.send({ to: "+15550100", template: "otp", data: {} });
      assert.strictEqual((yield* box.sms.waitFor({ to: "+15550100" })).template, "otp");
      assert.strictEqual((yield* box.mail.messages).length, 0);
    }).pipe(Effect.provide(TestMailbox.layer)),
  );

  it.effect("eight concurrent sends are all recorded", () =>
    Effect.gen(function* () {
      const box = yield* TestMailbox.Mailbox;
      const mailer = yield* Mailer.Mailer;
      yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => i),
        (i) => mailer.send({ to: `u${i}`, template: "x" }),
        { concurrency: "unbounded" },
      );
      assert.strictEqual((yield* box.mail.messages).length, 8);
      yield* box.mail.waitFor({}, { nth: 8 });
    }).pipe(Effect.provide(TestMailbox.layer)),
  );
});
