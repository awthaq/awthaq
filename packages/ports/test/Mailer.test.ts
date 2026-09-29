// See src/Mailer.ts's own header comment for what this port is grounded in
// (no BEH-EA range is allocated for the Ports stratum yet).
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Mailer from "../src/Mailer.ts";

describe("Mailer.layerMemory", () => {
  it.effect("records every sent message, in order", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      yield* mailer.send({ to: "a@example.com", template: "welcome" });
      yield* mailer.send({ to: "b@example.com", template: "reset", data: { token: "abc" } });
      const sent = yield* mailer.sent;
      assert.deepStrictEqual(sent, [
        { to: "a@example.com", template: "welcome" },
        { to: "b@example.com", template: "reset", data: { token: "abc" } },
      ]);
    }).pipe(Effect.provide(Mailer.layerMemory)),
  );

  it.effect("starts empty", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      assert.deepStrictEqual(yield* mailer.sent, []);
    }).pipe(Effect.provide(Mailer.layerMemory)),
  );
});

describe("Mailer.layerNoop", () => {
  it.effect("dies loudly instead of silently dropping mail", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      const exit = yield* Effect.exit(mailer.send({ to: "a@example.com", template: "welcome" }));
      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(Mailer.layerNoop)),
  );

  it.effect("sent is always empty", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      assert.deepStrictEqual(yield* mailer.sent, []);
    }).pipe(Effect.provide(Mailer.layerNoop)),
  );
});

describe("Mailer.layerNoop defect", () => {
  // EOTS-010: a defect message reaches logs and error trackers — no PII.
  it.effect("does not contain the recipient", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      const exit = yield* Effect.exit(
        mailer.send({ to: "victim@example.com", template: "welcome", data: { token: "s3cret" } }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const rendered = Cause.pretty(exit.cause);
        assert.notInclude(rendered, "victim@example.com");
        assert.notInclude(rendered, "s3cret");
        assert.include(rendered, "welcome");
      }
    }).pipe(Effect.provide(Mailer.layerNoop)),
  );
});

describe("Mailer.MailDeliveryFailed", () => {
  // EEM-002: a provider outage is an expected failure, not a defect.
  it.effect("a provider failure surfaces in the error channel, not as a defect", () =>
    Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      const failure = yield* mailer
        .send({ to: "a@example.com", template: "welcome" })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MailDeliveryFailed");
      assert.strictEqual(failure.template, "welcome");
      assert.strictEqual(failure.reason, "provider down");
      assert.isTrue(failure.retryable);
    }).pipe(
      Effect.provide(
        Layer.succeed(
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
        ),
      ),
    ),
  );
});

describe("Mailer.layerConsole (DESS-002)", () => {
  it.effect("logs the recipient, template and data (a Redacted token unwrapped) and records the message for `sent`", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = [];
      const capture = Logger.make<unknown, void>((options) => {
        logged.push({
          message: JSON.stringify(options.message),
          annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const mailer = yield* Mailer.Mailer;
      yield* mailer
        .send({
          to: "ada@example.com",
          template: "verify-email",
          data: { token: Redacted.make("tok-123"), locale: "en" },
        })
        .pipe(Effect.provide(Logger.layer([capture])));
      assert.strictEqual(logged.length, 1);
      assert.include(logged[0]?.message, "awthaq mail");
      assert.deepStrictEqual(logged[0]?.annotations, {
        to: "ada@example.com",
        template: "verify-email",
        token: "tok-123",
        locale: "en",
      });
      const sent = yield* mailer.sent;
      assert.deepStrictEqual(
        sent.map((message) => [message.to, message.template]),
        [["ada@example.com", "verify-email"]],
      );
      assert.isTrue(mailer.development);
    }).pipe(Effect.provide(Mailer.layerConsole)),
  );
});
