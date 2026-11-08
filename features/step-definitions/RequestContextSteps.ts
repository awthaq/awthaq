// ADR-EA-047 (plan 26 ticket 27): every request awthaq serves carries one request context, captured once at its edge;
// in-process work states that it answers none. Driven through `TestAuth.app` over `Auth.make([Password])`, whose
// requests go through the real `RequestContext` middleware (the harness fixes the address every request resolves to).
import { Api } from "@awthaq/api";
import { AuditLog, Auth, Sessions, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { assertTypeGate } from "./FoundationsWorld.ts";

const PASSWORD = "correct horse battery staple";

const built = Auth.make([Password.Password]);

const makeApp = (clientAddress: string) =>
  TestAuth.app(
    TestAuth.layer(built, {
      services: TestAuth.httpClient.noBreach,
      rateLimiter: "enforcing",
      clientAddress,
    }),
  );

/** One scenario's app and what it observed. Scenarios of a feature run one after another. */
interface Observed {
  app?: ReturnType<typeof makeApp> | undefined;
  session?: Sessions.SessionView | undefined;
  correlationIds?: ReadonlyArray<Option.Option<string>>;
  outcomes?: ReadonlyArray<string>;
  exceeded?: ReadonlyArray<string>;
}
let observed: Observed = {};

const serve = (clientAddress: string) => {
  // The previous scenario's app is released before the next is served.
  const previous = observed.app;
  if (previous !== undefined) void previous.dispose();
  observed = { app: makeApp(clientAddress) };
};

const appOf = () => {
  const app = observed.app;
  if (app === undefined) throw new Error("a Given must serve the composition first");
  return app;
};

const SessionBody = Schema.Struct({ token: Schema.optional(Schema.String) });

export const requestContextSteps = defineSteps(({ Given, When, Then }) => {
  Given(
    "a composition served with the request context, whose clients resolve to {string}",
    function* (address: string) {
      serve(address);
    },
  );

  When(
    "a person signs up over HTTP with request id {string} and user agent {string}",
    function* (requestId: string, userAgent: string) {
      const app = appOf();
      const response = yield* Effect.promise(() =>
        app.request("POST", "/password/sign-up", {
          json: { email: `${requestId}@example.com`, password: PASSWORD },
          headers: {
            "x-request-id": requestId,
            "user-agent": userAgent,
            [Api.TOKEN_DELIVERY_HEADER]: "bearer",
          },
        }),
      );
      assert.equal(response.status, 200);
      const body = Schema.decodeUnknownSync(SessionBody)(
        yield* Effect.promise(() => response.json()),
      );
      const verified = yield* Effect.promise(() =>
        app.run(
          Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
            sessions.verify(Redacted.make(body.token ?? "")),
          ),
        ),
      );
      const rows = yield* Effect.promise(() =>
        app.run(Effect.flatMap(Effect.service(AuditLog.AuditLog), (log) => log.list())),
      );
      observed.session = verified.session;
      observed.correlationIds = rows
        .filter((row) => Option.getOrUndefined(row.correlationId) === requestId)
        .map((row) => row.correlationId);
    },
  );

  Then(
    "every audit row that request caused carries the correlation id {string}",
    function* (requestId: string) {
      const ids = observed.correlationIds ?? [];
      // A sign-up writes several rows (the user, the session, the sign-in): all of them carry it.
      assert.ok(ids.length >= 2, `${ids.length} rows carry ${requestId}`);
      for (const id of ids) assert.deepEqual(id, Option.some(requestId));
    },
  );

  Then(
    "the session records the address {string} and the user agent {string}",
    function* (address: string, userAgent: string) {
      assert.deepEqual(observed.session?.ipAddress, Option.some(address));
      assert.deepEqual(observed.session?.userAgent, Option.some(userAgent));
    },
  );

  When("in-process work that answers no request mints a session", function* () {
    const app = appOf();
    const issued = yield* Effect.promise(() =>
      app.run(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users
            .create({ identity: { _tag: "Email", email: "job@example.com" }, name: "Job" })
            .pipe(Effect.orDie);
          return yield* sessions.issue({ userId: user.id }).pipe(TestAuth.withoutRequest);
        }),
      ),
    );
    observed.session = issued.session;
  });

  Then("the session records no address and no user agent", function* () {
    assert.ok(Option.isNone(observed.session?.ipAddress ?? Option.some("missing")));
    assert.ok(Option.isNone(observed.session?.userAgent ?? Option.some("missing")));
  });

  When(
    "in-process work that answers no request asks for {int} password resets for one address",
    function* (count: number) {
      const app = appOf();
      const outcomes: Array<string> = [];
      for (let i = 0; i < count; i++) {
        outcomes.push(
          yield* Effect.promise(() =>
            app.run(
              Effect.flatMap(Effect.service(Password.Password), (password) =>
                password.requestReset({ email: "victim@example.com" }),
              ).pipe(
                TestAuth.withoutRequest,
                Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "accepted" }),
              ),
            ),
          ),
        );
      }
      const rows = yield* Effect.promise(() =>
        app.run(
          Effect.flatMap(Effect.service(AuditLog.AuditLog), (log) =>
            log.list({ eventTag: "auth.rateLimit.exceeded" }),
          ),
        ),
      );
      observed.outcomes = outcomes;
      observed.exceeded = rows.map((row) =>
        row.payload._tag === "auth.rateLimit.exceeded" ? row.payload.rule : "?",
      );
    },
  );

  Then(
    "the per-address rule refuses the {int}th, and no per-source rule was applied",
    function* (nth: number) {
      const outcomes = observed.outcomes ?? [];
      assert.deepEqual(
        outcomes.slice(0, nth - 1),
        Array.from({ length: nth - 1 }, () => "accepted"),
      );
      assert.equal(outcomes[nth - 1], "RateLimited");
      assert.deepEqual(observed.exceeded, ["requestReset"]);
    },
  );

  Given("a group whose handler reads the request context", function* () {
    observed = {};
  });

  When("it is served without the request context's populator", function* () {
    observed.outcomes = ["checked by the compiler"];
  });

  Then("the composition does not compile", function* () {
    assertTypeGate("serving-without-request-context-does-not-compile", "CompileTimeGates.ts", [
      "@ts-expect-error",
      "contextHandlers",
    ]);
  });
});
