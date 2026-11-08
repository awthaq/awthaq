// EEM-005 (BEH-EA-165): the reauth obligation's error crosses the wire.
//
// `ObligationHandlers.reauth` used to fail with a `Data.TaggedError`, which no
// `HttpApiEndpoint` could declare or encode, so the documented "confirm your
// password" prompt was unimplementable for a browser client. It now fails with
// `Api.ReauthRequired` (a `Schema.TaggedError`, 403): a Path A endpoint that
// enforces a policy carrying `reauth(...)` declares it in `error:` and a client
// decodes it — the very schema asserted against below — telling a reauth demand
// (with its window) apart from a plain permission denial.
import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import { SessionDelivery } from "@awthaq/server";
import { Auth, AuthPlugin, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import { allOf, enforce, EvaluationServicesNone, obliged } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as AuthorizedSubject from "../src/AuthorizedSubject.ts";
import * as Resolvers from "../src/Resolvers.ts";
import { TestAuth, UserAgent } from "@awthaq/test";

// A window of 0 makes any elapsed time "stale" without needing a test clock the
// router's own runtime would not share; a wide window is never stale.
const LoginGroup = HttpApiGroup.make("login").add(
  HttpApiEndpoint.post("login", "/login", { success: SessionContract.SessionDto }).middleware(
    SessionLifecycle.Mints,
  ),
);

const StaleGroup = HttpApiGroup.make("reauth")
  .add(
    HttpApiEndpoint.post("stale", "/sensitive/stale", {
      success: Schema.Void,
      error: Api.ReauthRequired,
    }),
  )
  .add(
    HttpApiEndpoint.post("fresh", "/sensitive/fresh", {
      success: Schema.Void,
      error: Api.ReauthRequired,
    }),
  )
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.Authentication);

const TestApi = HttpApi.make("auth").add(LoginGroup).add(StaleGroup);

const guarded = (maxAgeSeconds: number) =>
  enforce(obliged(Resolvers.reauth(maxAgeSeconds), allOf([])), {
    onObligations: Resolvers.ObligationHandlers.reauth,
  })(Effect.void).pipe(
    // Only the reauth demand is a client-visible outcome here; every other
    // enforcement failure would be a defect in this fixture.
    Effect.catch((error) =>
      error._tag === "ReauthRequired" ? Effect.fail(error) : Effect.die(error),
    ),
  );

const LoginHandlers = HttpApiBuilder.group(
  TestApi,
  "login",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* Sessions.Sessions;
    const users = yield* Users.Users;
    return handlers.handleAll({
      login: Effect.fnUntraced(function* () {
        const user = yield* users
          .create({ identity: { _tag: "Email", email: "reauth@example.com" }, name: "Reauth" })
          .pipe(Effect.orDie);
        const { token, session } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        return yield* SessionDelivery.respond(Effect.succeed({ session, token }));
      }),
    });
  }),
);

const Handlers = HttpApiBuilder.group(TestApi, "reauth", (handlers) =>
  handlers.handleAll({
    stale: () => guarded(0),
    fresh: () => guarded(3600),
  }),
);

/**
 * An empty host plugin carrying no routes of its own: the two test groups ride beside it as `extraGroups`, with their
 * handlers and the bridge middleware provided as the test's own `services`, through the composition a host builds.
 */
class HostPlugin extends AuthPlugin.Service<HostPlugin, Record<string, never>>()("host", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables: {},
}) {
  static readonly layer = AuthPlugin.layer(HostPlugin, { make: Effect.succeed({}) });
}

// Not `TestAuth.app`: the handler is called with the evaluation services as its per-request context.
const AppLayer = TestAuth.layer(
  Auth.make([HostPlugin], { extraGroups: [LoginGroup, StaleGroup] }),
  {
    services: Layer.mergeAll(LoginHandlers, Handlers).pipe(
      Layer.provideMerge(AuthorizedSubject.AuthorizedSubjectLive),
    ),
  },
);

describe("Path A reauth over real HTTP (EEM-005)", () => {
  it.effect("a stale session answers 403 whose body decodes to ReauthRequired{maxAgeSeconds}", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const evaluation = yield* Layer.build(EvaluationServicesNone);
        // A browser over the handler (with the evaluation services as each request's context): it signs in
        // through `/login` and keeps the session cookie itself.
        const browser = UserAgent.make({ handler: (request) => handler(request, evaluation) });
        const loginResponse = yield* Effect.promise(() => browser.request("POST", "/login"));
        assert.strictEqual(loginResponse.status, 200);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 15)));

        const stale = yield* Effect.promise(() => browser.request("POST", "/sensitive/stale"));
        assert.strictEqual(stale.status, 403);
        const decoded = Schema.decodeUnknownSync(Api.ReauthRequired)(
          yield* Effect.promise(() => stale.json()),
        );
        assert.isTrue(Api.isReauthRequired(decoded));
        assert.strictEqual(decoded.maxAgeSeconds, 0);

        // A session within its window discharges the same obligation.
        const fresh = yield* Effect.promise(() => browser.request("POST", "/sensitive/fresh"));
        assert.strictEqual(fresh.status, 200);
      }),
    ),
  );
});
