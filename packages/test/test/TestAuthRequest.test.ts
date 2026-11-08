// ADR-EA-047 (plan 26 ticket 12): `TestAuth` sets the request context. A wire request through `TestAuth.app` goes
// through the real `RequestContext` middleware (the address is the harness's fixed `clientAddress`); `run` answers no
// request unless `app`'s `request` option names one; `signInAs({ request })` records the facts it is given.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as TestAuth from "../src/TestAuth.ts";

const Minted = Schema.Struct({
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
});

const ProbeApi = HttpApi.make("auth").add(
  HttpApiGroup.make("probe")
    .add(HttpApiEndpoint.post("mint", "/probe/mint", { success: Minted }))
    .middleware(Api.RequestContext),
);

// The handler mints a session for a fresh user and answers what the row recorded.
const ProbeHandlers = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    return handlers.handle("mint", () =>
      Effect.gen(function* () {
        const user = yield* users
          .create({
            identity: { _tag: "Email", email: `probe-${Math.random()}@example.com` },
            name: "Probe",
          })
          .pipe(Effect.orDie);
        const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        return {
          ip: Option.getOrNull(issued.session.ipAddress),
          userAgent: Option.getOrNull(issued.session.userAgent),
        };
      }),
    );
  }),
);

class Probe extends AuthPlugin.Service<Probe, Record<string, never>>()("probe", {
  apiVersion: 1,
  contract: ProbeApi,
  tables: {},
}) {
  static readonly layer = AuthPlugin.layer(Probe, {
    make: Effect.succeed({}),
    handlers: ProbeHandlers,
  });
}

const built = Auth.make([Probe]);

describe("TestAuth request context (ADR-EA-047)", () => {
  it("a wire request records the fixed clientAddress and the user-agent header it sent", async () => {
    const app = TestAuth.app(TestAuth.layer(built, { clientAddress: "198.51.100.4" }));
    try {
      const response = await app.request("POST", "/probe/mint", {
        headers: { "user-agent": "probe-agent/1" },
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), {
        ip: "198.51.100.4",
        userAgent: "probe-agent/1",
      });
    } finally {
      await app.dispose();
    }
  });

  it("without clientAddress a web-handler request records no address", async () => {
    const app = TestAuth.app(TestAuth.layer(built));
    try {
      const response = await app.request("POST", "/probe/mint");
      assert.deepStrictEqual(await response.json(), { ip: null, userAgent: null });
    } finally {
      await app.dispose();
    }
  });

  it("run answers no request by default, and the request app's option names", async () => {
    const plain = TestAuth.app(TestAuth.layer(built));
    const requested = TestAuth.app(TestAuth.layer(built), {
      request: { ip: "203.0.113.5", userAgent: "run/1" },
    });
    try {
      assert.deepStrictEqual(
        await plain.run(Effect.service(Api.AuthRequestContext)),
        Api.AuthRequestContext.noRequest,
      );
      const signedIn = await requested.run(
        Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
          Effect.flatMap(Effect.service(Users.Users), (users) =>
            users
              .create({ identity: { _tag: "Email", email: "run@example.com" }, name: "Run" })
              .pipe(Effect.flatMap((user) => sessions.issue({ userId: user.id }))),
          ),
        ),
      );
      assert.deepStrictEqual(signedIn.session.ipAddress, Option.some("203.0.113.5"));
      assert.deepStrictEqual(signedIn.session.userAgent, Option.some("run/1"));
    } finally {
      await plain.dispose();
      await requested.dispose();
    }
  });

  it.effect("signInAs({ request }) records the facts; without one the session records none", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const withFacts = yield* TestAuth.signInAs({
        email: "facts@example.com",
        request: { ip: "203.0.113.9", userAgent: "signed/1" },
      });
      const bare = yield* TestAuth.signInAs({ email: "bare@example.com" });
      const a = yield* sessions.verify(withFacts.token);
      const b = yield* sessions.verify(bare.token);
      assert.deepStrictEqual(a.session.ipAddress, Option.some("203.0.113.9"));
      assert.deepStrictEqual(a.session.userAgent, Option.some("signed/1"));
      assert.isTrue(Option.isNone(b.session.ipAddress));
    }).pipe(Effect.provide(TestAuth.layer(built))),
  );
});
