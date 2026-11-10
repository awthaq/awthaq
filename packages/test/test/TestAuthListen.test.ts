// BEH-EA-353: `TestAuth.listen` serves the same app on a real socket; `run`, `handler` and the socket share instances.
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as TestAuth from "../src/TestAuth.ts";
import { Pins } from "./support/Pins.ts";

describe("TestAuth.listen (BEH-EA-353)", () => {
  it.effect(
    "one session, two transports: a session minted through run authenticates over the socket",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* TestAuth.listen(TestAuth.layer(Auth.make([Pins])));
          assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
          const anonymous = yield* Effect.promise(() => fetch(`${app.url}/session`));
          assert.strictEqual(anonymous.status, 401);
          const signed = yield* Effect.promise(() =>
            app.run(TestAuth.signInAs({ email: "socket@example.com" })),
          );
          const authed = yield* Effect.promise(() =>
            fetch(`${app.url}/session`, {
              headers: { authorization: `Bearer ${Redacted.value(signed.token)}` },
            }),
          );
          assert.strictEqual(authed.status, 200);
          assert.isString((yield* Effect.promise(() => authed.json())).id);
        }),
      ),
  );

  it.effect(
    "requests lists the socket's requests in order; leaving the scope closes the socket and the app",
    () =>
      Effect.gen(function* () {
        const apps = TestAuth.openApps();
        const url = yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TestAuth.listen(TestAuth.layer(Auth.make([Pins])));
            yield* Effect.promise(() => fetch(`${app.url}/session`));
            yield* Effect.promise(() => fetch(`${app.url}/session`));
            yield* Effect.promise(() => fetch(`${app.url}/pins?x=1`));
            // An in-process request is not the socket's.
            yield* Effect.promise(() => app.request("GET", "/session"));
            assert.deepStrictEqual(app.requests(), [
              "GET /session",
              "GET /session",
              "GET /pins?x=1",
            ]);
            return app.url;
          }),
        );
        const afterwards = yield* Effect.exit(Effect.tryPromise(() => fetch(`${url}/session`)));
        assert.isTrue(Exit.isFailure(afterwards));
        assert.strictEqual(TestAuth.openApps(), apps);
      }),
  );
});
