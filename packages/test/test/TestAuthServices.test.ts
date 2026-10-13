// BEH-EA-193 regression: `services` is merged into the output, so a service only `services` provides is
// `yield*`-able (the type said so; it used to die at runtime), and a port both `services` and the base could
// provide has one instance, the one the plugin used.
import { Auth } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestAuth from "../src/TestAuth.ts";

class Marker extends Context.Service<Marker, { readonly label: string }>()("test/Marker") {}

/** A capturing `Mailer` of the test's own: the instance the plugin must send through and the test must read. */
const capturing = Layer.effect(
  Mailer.Mailer,
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<Mailer.MailMessage>>([]);
    return Mailer.Mailer.of({
      send: (message) => Ref.update(messages, (all) => [...all, message]),
      sent: Ref.get(messages),
    });
  }),
);

describe("TestAuth.layer `services` reach the output (BEH-EA-193)", () => {
  it("a service only `services` provides is `yield*`-able", async () => {
    const app = TestAuth.app(
      TestAuth.layer(Auth.make([Password.Password]), {
        services: Layer.merge(
          TestAuth.httpClient.noBreach,
          Layer.succeed(Marker, { label: "mine" }),
        ),
      }),
    );
    try {
      const marker = await app.run(Effect.service(Marker));
      assert.strictEqual(marker.label, "mine");
    } finally {
      await app.dispose();
    }
  });

  it("a capturing Mailer in `services` is the instance the plugin sends through and the test reads", async () => {
    const app = TestAuth.app(
      TestAuth.layer(Auth.make([Password.Password]), {
        services: Layer.merge(TestAuth.httpClient.noBreach, capturing),
      }),
    );
    try {
      await app.run(
        Effect.gen(function* () {
          const password = yield* Password.Password;
          yield* password.signUp({
            email: "capture@example.com",
            password: Redacted.make("a sufficiently long test password"),
          });
        }),
      );
      // The sign-up mail is dispatched in the background; give it a moment on the real clock.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const sent = await app.run(Effect.flatMap(Mailer.Mailer, (mailer) => mailer.sent));
      assert.isTrue(sent.some((message) => message.template === "verify-email"));
    } finally {
      await app.dispose();
    }
  });
});
