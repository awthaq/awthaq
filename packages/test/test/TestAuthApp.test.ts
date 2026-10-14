// BEH-EA-T3: `TestAuth.app` serves the composition and its context together: the handler and the context
// runner share one instance of every service, and `request` satisfies CSRF for the composition's own config.
import { Api } from "@awthaq/api";
import { Auth, Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestAuth from "../src/TestAuth.ts";
import { Pins } from "./support/Pins.ts";

describe("TestAuth.app (BEH-EA-T3)", () => {
  it("a session minted through `run` authenticates a request through `handler`", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const signedIn = await app.run(TestAuth.signInAs({ email: "shared@example.com" }));
      const response = await app.handler(
        new Request("http://localhost/pins", { headers: { cookie: signedIn.cookieHeader } }),
      );
      assert.strictEqual(response.status, 200);
      // ...and the other way: a session the handler's world holds is visible to `run`.
      const verified = await app.run(
        Effect.flatMap(Sessions.Sessions, (sessions) => sessions.verify(signedIn.token)),
      );
      assert.strictEqual(verified.session.userId, signedIn.userId);
    } finally {
      await app.dispose();
    }
  });

  it("`request` passes CSRF on POST, with the double-submit pair of the composition's own config", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const signedIn = await app.signIn("poster@example.com");
      const posted = await app.request("POST", "/pins", {
        cookie: signedIn.cookieHeader,
        json: { label: "csrf-ok" },
      });
      assert.strictEqual(posted.status, 200);
      // The same call without the helper carries a cookie but no pair, and is refused.
      const bare = await app.handler(
        new Request("http://localhost/pins", {
          method: "POST",
          headers: { cookie: signedIn.cookieHeader, "content-type": "application/json" },
          body: JSON.stringify({ label: "no-pair" }),
        }),
      );
      assert.strictEqual(bare.status, 403);
    } finally {
      await app.dispose();
    }
  });

  it("`signIn` returns a working cookie, with the `amr` the test asked for", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const signedIn = await app.signIn("amr@example.com", { amr: ["pwd"] });
      const session = await app.request("GET", "/session", { cookie: signedIn.cookieHeader });
      assert.strictEqual(session.status, 200);
      const body = await session.json();
      assert.deepStrictEqual(body.amr, ["pwd"]);
      assert.isString(Api.SESSION_COOKIE_NAME);
    } finally {
      await app.dispose();
    }
  });

  it("`dispose` releases the scope: a finalizer of the composition has run after it", async () => {
    let released = 0;
    const app = TestAuth.app(
      TestAuth.layer(Auth.make([Pins]), {
        services: Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              released += 1;
            }),
          ),
        ),
      }),
    );
    await app.run(Effect.void);
    assert.strictEqual(released, 0);
    await app.dispose();
    assert.strictEqual(released, 1);
  });
});
