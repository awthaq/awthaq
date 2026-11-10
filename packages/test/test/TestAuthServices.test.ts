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
import * as TestAuth from "../src/TestAuth.ts";

class Marker extends Context.Service<Marker, { readonly label: string }>()("test/Marker") {}

describe("TestAuth.layer `services` reach the output (BEH-EA-193)", () => {
  it("a service only `services` provides is `yield*`-able", async () => {
    await TestAuth.withApp(
      TestAuth.layer(Auth.make([Password.Password]), {
        services: Layer.merge(
          TestAuth.httpClient.noBreach,
          Layer.succeed(Marker, { label: "mine" }),
        ),
      }),
      undefined,
      async (app) => {
        const marker = await app.run(Effect.service(Marker));
        assert.strictEqual(marker.label, "mine");
      },
    );
  });

  it("a Mailer in `services` shadows the mailbox for the plugin, and is the instance it sends through", async () => {
    const sent: Array<Mailer.MailMessage> = [];
    let arrived = () => {};
    const delivered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const own = Layer.mock(Mailer.Mailer)({
      send: (message) =>
        Effect.sync(() => {
          sent.push(message);
          arrived();
        }),
    });
    await TestAuth.withApp(
      TestAuth.layer(Auth.make([Password.Password]), {
        services: Layer.merge(TestAuth.httpClient.noBreach, own),
      }),
      undefined,
      async (app) => {
        await app.run(
          Effect.gen(function* () {
            const password = yield* Password.Password;
            yield* password.signUp({
              email: "capture@example.com",
              password: Redacted.make("a sufficiently long test password"),
            });
          }),
        );
        // The sign-up mail is dispatched in the background; the double resolves `delivered` when it lands.
        await delivered;
        assert.isTrue(sent.some((message) => message.template === "verify-email"));
      },
    );
  });
});
