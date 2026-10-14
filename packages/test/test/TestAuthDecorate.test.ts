// `decorate` wraps a base service in place: the plugin and the test both see the decorated one, so an outage
// can be injected without rebuilding the composition.
import { Auth, Errors, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestAuth from "../src/TestAuth.ts";

const usersDown = Layer.effect(
  Users.Users,
  Effect.gen(function* () {
    const real = yield* Users.Users;
    return Users.Users.of({
      ...real,
      findByEmail: () =>
        Effect.fail(new Errors.StoreUnavailable({ operation: "Users.findByEmail" })),
    });
  }),
);

describe("TestAuth.layer `decorate`", () => {
  it("the plugin's sign-in sees the outage, and so does the test's own `Users`", async () => {
    const app = TestAuth.app(
      TestAuth.layer(Auth.make([Password.Password]), {
        services: TestAuth.httpClient.noBreach,
        decorate: usersDown,
      }),
    );
    try {
      const response = await app.request("POST", "/password/sign-in", {
        json: { email: "down@example.com", password: "a sufficiently long test password" },
      });
      assert.strictEqual(response.status, 503);
      const lookup = await app.run(
        Effect.flatMap(Users.Users, (users) => users.findByEmail("down@example.com")).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
        ),
      );
      assert.isTrue(Option.isNone(lookup));
    } finally {
      await app.dispose();
    }
  });
});
