// SOS-002: the SMS capability port, mirroring Mailer (see src/SmsSender.ts).
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as SmsSender from "../src/SmsSender.ts";

describe("SmsSender.layerMemory", () => {
  it.effect("records every sent message, in order, and starts empty", () =>
    Effect.gen(function* () {
      const sms = yield* SmsSender.SmsSender;
      assert.deepStrictEqual(yield* sms.sent, []);
      yield* sms.send({ to: "+15550100", template: "otp", data: { code: "123456" } });
      yield* sms.send({ to: "+442079460958", template: "notice" });
      assert.deepStrictEqual(yield* sms.sent, [
        { to: "+15550100", template: "otp", data: { code: "123456" } },
        { to: "+442079460958", template: "notice" },
      ]);
      assert.isTrue(sms.development);
    }).pipe(Effect.provide(SmsSender.layerMemory)),
  );
});

describe("SmsSender.layerNoop", () => {
  it.effect("dies loudly, and the defect names the template but never the recipient or code", () =>
    Effect.gen(function* () {
      const sms = yield* SmsSender.SmsSender;
      const exit = yield* Effect.exit(
        sms.send({ to: "+15550100", template: "otp", data: { code: "s3cret" } }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause);
        assert.include(rendered, "otp");
        assert.notInclude(rendered, "+15550100");
        assert.notInclude(rendered, "s3cret");
      }
      assert.deepStrictEqual(yield* sms.sent, []);
      assert.isTrue(sms.development);
    }).pipe(Effect.provide(SmsSender.layerNoop)),
  );
});

describe("SmsSender.SmsDeliveryFailed", () => {
  it.effect("a provider failure surfaces in the error channel, not as a defect", () =>
    Effect.gen(function* () {
      const sms = yield* SmsSender.SmsSender;
      const failure = yield* sms.send({ to: "+15550100", template: "otp" }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SmsDeliveryFailed");
      assert.strictEqual(failure.template, "otp");
      assert.strictEqual(failure.reason, "unroutable number");
      assert.isFalse(failure.retryable);
    }).pipe(
      Effect.provide(
        Layer.succeed(
          SmsSender.SmsSender,
          SmsSender.SmsSender.of({
            send: (message) =>
              Effect.fail(
                new SmsSender.SmsDeliveryFailed({
                  template: message.template,
                  reason: "unroutable number",
                  retryable: false,
                }),
              ),
            sent: Effect.succeed([]),
          }),
        ),
      ),
    ),
  );
});

describe("SmsSender.layerConsole", () => {
  it.effect(
    "logs the recipient, template and data (a Redacted code unwrapped) and records it",
    () =>
      Effect.gen(function* () {
        const logged: Array<Record<string, unknown>> = [];
        const capture = Logger.make<unknown, void>((options) => {
          logged.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
        });
        const sms = yield* SmsSender.SmsSender;
        yield* sms
          .send({ to: "+15550100", template: "otp", data: { code: Redacted.make("424242") } })
          .pipe(Effect.provide(Logger.layer([capture])));
        assert.deepStrictEqual(logged, [{ to: "+15550100", template: "otp", code: "424242" }]);
        assert.strictEqual((yield* sms.sent).length, 1);
        assert.isTrue(sms.development);
      }).pipe(Effect.provide(SmsSender.layerConsole)),
  );
});
