// BEH-EA-T3: `TestAuth.app` serves the composition and its context together: the handler and the context
// runner share one instance of every service, and `request` satisfies CSRF for the composition's own config.
import { Api } from "@awthaq/api";
import { Auth, Persistence, Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
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

  it("`runtime` and `memoMap` share the composition's instances with `handler` and `run`", async () => {
    const layer = TestAuth.layer(Auth.make([Pins]));
    const app = TestAuth.app(layer);
    try {
      const signedIn = await app.runtime.runPromise(TestAuth.signInAs({ email: "rt@example.com" }));
      const response = await app.handler(
        new Request("http://localhost/pins", { headers: { cookie: signedIn.cookieHeader } }),
      );
      assert.strictEqual(response.status, 200);
      // A layer built through the app's memo map is the instance `run` and the runtime see, not a second copy.
      const viaMemoMap = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.buildWithMemoMap(layer, app.memoMap, yield* Effect.scope);
            return Context.get(context, Sessions.Sessions);
          }),
        ),
      );
      assert.strictEqual(viaMemoMap, await app.run(Sessions.Sessions));
      assert.strictEqual(viaMemoMap, await app.runtime.runPromise(Sessions.Sessions));
    } finally {
      await app.dispose();
    }
  });

  it("`testClock` serves the composition over one TestClock that `advance` moves for the handler and for `run`", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])), { testClock: true });
    try {
      const signedIn = await app.signIn("clock@example.com");
      const before = await app.request("GET", "/session", { cookie: signedIn.cookieHeader });
      assert.strictEqual(before.status, 200);
      const start = await app.run(Clock.currentTimeMillis);
      await app.advance(Duration.days(400));
      assert.strictEqual(
        await app.run(Clock.currentTimeMillis),
        start + Duration.toMillis(Duration.days(400)),
      );
      // The session lived past its absolute expiry on the clock the handler reads, and a POST still passes CSRF.
      const after = await app.request("GET", "/session", { cookie: signedIn.cookieHeader });
      assert.strictEqual(after.status, 401);
      const posted = await app.request("POST", "/pins", {
        cookie: (await app.signIn("later@example.com")).cookieHeader,
        json: { label: "after-advance" },
      });
      assert.strictEqual(posted.status, 200);
    } finally {
      await app.dispose();
    }
  });

  it("`advance` without the `testClock` option rejects instead of silently doing nothing", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      await app.advance(Duration.seconds(1)).then(
        () => assert.fail("expected a rejection"),
        (error) => assert.include(String(error), "testClock"),
      );
    } finally {
      await app.dispose();
    }
  });

  it("`memoMap` lets two apps share the instances they have in common", async () => {
    const memoMap = Layer.makeMemoMapUnsafe();
    const layer = TestAuth.layer(Auth.make([Pins]));
    const first = TestAuth.app(layer, { memoMap });
    const second = TestAuth.app(layer, { memoMap });
    try {
      const signedIn = await first.signIn("shared-map@example.com");
      const response = await second.handler(
        new Request("http://localhost/pins", { headers: { cookie: signedIn.cookieHeader } }),
      );
      assert.strictEqual(response.status, 200);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it("`buildContext` builds on the real clock into a context the caller owns", async () => {
    const scope = Scope.makeUnsafe();
    const context = await TestAuth.buildContext(
      Sessions.layer.pipe(
        Layer.provide(Persistence.memory),
        Layer.provide(TestAuth.memoryFoundation),
      ),
      { scope },
    );
    assert.isDefined(Context.get(context, Sessions.Sessions));
    await Effect.runPromise(Scope.close(scope, Exit.void));
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
