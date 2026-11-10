// Plan 34: the leak guard's two counters return to their prior value once the serving scope closes.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestAuth from "../src/TestAuth.ts";
import * as TestSql from "../src/TestSql.ts";
import { Pins } from "./support/Pins.ts";

describe("TestAuth.openApps and TestSql.openClients (plan 34)", () => {
  const sqlComposition = () =>
    TestAuth.layer(Auth.make([Pins]), { records: "sql", suite: "test_lifetime" });

  it.effect("serve releases the app and its SQL client when the scope ends", () =>
    Effect.gen(function* () {
      const apps = TestAuth.openApps();
      const clients = TestSql.openClients();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const served = yield* TestAuth.serve(sqlComposition());
          yield* Effect.promise(() => served.request("POST", "/session/sign-out"));
          assert.strictEqual(TestAuth.openApps(), apps + 1);
          assert.strictEqual(TestSql.openClients(), clients + 1);
        }),
      );
      assert.strictEqual(TestAuth.openApps(), apps);
      assert.strictEqual(TestSql.openClients(), clients);
    }),
  );

  it.effect("serve releases on failure and on interruption", () =>
    Effect.gen(function* () {
      const apps = TestAuth.openApps();
      const clients = TestSql.openClients();
      const failed = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const served = yield* TestAuth.serve(sqlComposition());
            yield* Effect.promise(() => served.request("POST", "/session/sign-out"));
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(failed));
      const interrupted = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const served = yield* TestAuth.serve(sqlComposition());
            yield* Effect.promise(() => served.request("POST", "/session/sign-out"));
            return yield* Effect.interrupt;
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(interrupted));
      assert.strictEqual(TestAuth.openApps(), apps);
      assert.strictEqual(TestSql.openClients(), clients);
    }),
  );

  it.effect("serve builds on the real clock even under a TestClock at the epoch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const served = yield* TestAuth.serve(TestAuth.layer(Auth.make([Pins])));
        const now = yield* Effect.promise(() => served.run(Clock.currentTimeMillis));
        assert.isBelow(Math.abs(now - Date.now()), 60_000);
      }),
    ),
  );

  it("withApp resolves with the callback's value and releases the app", async () => {
    const apps = TestAuth.openApps();
    const value = await TestAuth.withApp(
      TestAuth.layer(Auth.make([Pins])),
      undefined,
      async (a) => {
        assert.strictEqual(TestAuth.openApps(), apps + 1);
        return (await a.request("POST", "/session/sign-out")).status > 0 ? "ok" : "no";
      },
    );
    assert.strictEqual(value, "ok");
    assert.strictEqual(TestAuth.openApps(), apps);
  });

  it("withApp rejects with the callback's own error and still releases", async () => {
    const apps = TestAuth.openApps();
    const boom = new Error("boom");
    const caught = await TestAuth.withApp(TestAuth.layer(Auth.make([Pins])), undefined, () =>
      Promise.reject(boom),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.strictEqual(caught, boom);
    assert.strictEqual(TestAuth.openApps(), apps);
  });

  it('testClock "now" starts at the wall clock and advances; true starts at the epoch', async () => {
    await TestAuth.withApp(TestAuth.layer(Auth.make([Pins])), { testClock: "now" }, async (a) => {
      const start = await a.run(Clock.currentTimeMillis);
      assert.isBelow(Math.abs(start - Date.now()), 60_000);
      await a.advance("1 day");
      assert.isAtLeast(await a.run(Clock.currentTimeMillis), start + 86_400_000);
    });
    await TestAuth.withApp(TestAuth.layer(Auth.make([Pins])), { testClock: true }, async (a) => {
      assert.isBelow(await a.run(Clock.currentTimeMillis), 60_000);
    });
  });
});
