// BEH-EA-T3: `TestAuth.app` serves the composition and its context together: the handler and the context
// runner share one instance of every service, and `request` satisfies CSRF for the composition's own config.
import { Api } from "@awthaq/api";
import { Auth, Persistence, SessionCookie, Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as TestAuth from "../src/TestAuth.ts";
import { Pins } from "./support/Pins.ts";

describe("TestAuth.app (BEH-EA-T3)", () => {
  it("a session minted through `run` authenticates a request through `handler`", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const signedIn = await app.run(TestAuth.signInAs({ email: "shared@example.com" }));
      const browser = await app.agent();
      assert.strictEqual(browser.cookies.receive(signedIn.setCookie)._tag, "Stored");
      const response = await browser.request("GET", "/pins");
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

  it("an agent's unsafe request passes CSRF with the seeded cookie, computed independently of `Csrf.ts`", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const poster = await app.signIn("poster@example.com");
      const csrf = poster.cookies.get(Api.CSRF_COOKIE_NAME);
      assert.isDefined(csrf);
      assert.isFalse(csrf?.httpOnly);
      const posted = await poster.request("POST", "/pins", { json: { label: "csrf-ok" } });
      assert.strictEqual(posted.status, 200);
      assert.strictEqual(poster.sent[0]?.headers.get(Api.CSRF_HEADER_NAME), csrf?.value);
      // The same call without the echo carries the cookies but no header, and is refused.
      const bare = await poster.request("POST", "/pins", {
        json: { label: "no-pair" },
        headers: { [Api.CSRF_HEADER_NAME]: "" },
      });
      assert.strictEqual(bare.status, 403);
    } finally {
      await app.dispose();
    }
  });

  it("`signIn` returns an agent that is signed in, with the `amr` the test asked for", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const alice = await app.signIn("amr@example.com", { amr: ["pwd"] });
      const session = await alice.request("GET", "/session");
      assert.strictEqual(session.status, 200);
      const body = await session.json();
      assert.deepStrictEqual(body.amr, ["pwd"]);
      assert.strictEqual(alice.cookies.get(Api.SESSION_COOKIE_NAME)?.httpOnly, true);
    } finally {
      await app.dispose();
    }
  });

  it("`signIn` under `SecureDomain` holds `__Secure-session; Domain=…` and authenticates `GET /session`", async () => {
    const app = TestAuth.app(
      TestAuth.layer(Auth.make([Pins]), {
        services: SessionCookie.config({
          mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }),
        }),
      }),
      { baseUrl: "https://app.example.com" },
    );
    try {
      const alice = await app.signIn("secure-domain@example.com");
      const cookie = alice.cookies.get("__Secure-session");
      assert.strictEqual(cookie?.domain, "example.com");
      assert.isFalse(cookie?.hostOnly);
      assert.isUndefined(alice.cookies.get(Api.SESSION_COOKIE_NAME));
      const session = await alice.request("GET", "/session");
      assert.strictEqual(session.status, 200);
    } finally {
      await app.dispose();
    }
  });

  it('`signIn({ delivery: "bearer" })` authenticates with Authorization and sends no cookie', async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const native = await app.signIn("native@example.com", { delivery: "bearer" });
      assert.strictEqual(native.bearer.current(), Redacted.value(native.token));
      const session = await native.request("GET", "/session");
      assert.strictEqual(session.status, 200);
      assert.isFalse(native.sent[0]?.headers.has("cookie"));
      assert.strictEqual(native.sent[0]?.headers.get(Api.TOKEN_DELIVERY_HEADER), "bearer");
      assert.isTrue(native.sent[0]?.headers.get("authorization")?.startsWith("Bearer "));
    } finally {
      await app.dispose();
    }
  });

  it("two agents of one app do not share cookies, and `request` is a fresh anonymous agent each call", async () => {
    const app = TestAuth.app(TestAuth.layer(Auth.make([Pins])));
    try {
      const alice = await app.signIn("alice@example.com");
      const bob = await app.agent();
      assert.strictEqual((await alice.request("GET", "/session")).status, 200);
      assert.strictEqual((await bob.request("GET", "/session")).status, 401);
      assert.strictEqual((await app.request("GET", "/session")).status, 401);
      // A forged cookie travels for one request only.
      const forged = await app.request("GET", "/session", {
        extraCookies: { [Api.SESSION_COOKIE_NAME]: "forged" },
      });
      assert.strictEqual(forged.status, 401);
    } finally {
      await app.dispose();
    }
  });

  it("`runtime` and `memoMap` share the composition's instances with `handler` and `run`", async () => {
    const layer = TestAuth.layer(Auth.make([Pins]));
    const app = TestAuth.app(layer);
    try {
      const signedIn = await app.runtime.runPromise(TestAuth.signInAs({ email: "rt@example.com" }));
      const browser = await app.agent();
      browser.cookies.receive(signedIn.setCookie);
      const response = await browser.request("GET", "/pins");
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
      const alice = await app.signIn("clock@example.com");
      const before = await alice.request("GET", "/session");
      assert.strictEqual(before.status, 200);
      const start = await app.run(Clock.currentTimeMillis);
      await app.advance(Duration.days(400));
      assert.strictEqual(
        await app.run(Clock.currentTimeMillis),
        start + Duration.toMillis(Duration.days(400)),
      );
      // The session lived past its absolute expiry on the clock the handler reads; the agent's store reads the
      // same clock, so the cookie's Max-Age lapsed with it and nothing is sent. A fresh agent still passes CSRF.
      assert.isUndefined(alice.cookies.get(Api.SESSION_COOKIE_NAME));
      const after = await alice.request("GET", "/session");
      assert.strictEqual(after.status, 401);
      const later = await app.signIn("later@example.com");
      const posted = await later.request("POST", "/pins", { json: { label: "after-advance" } });
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
      const signedIn = await first.run(TestAuth.signInAs({ email: "shared-map@example.com" }));
      const browser = await second.agent();
      browser.cookies.receive(signedIn.setCookie);
      const response = await browser.request("GET", "/pins");
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
