// AR-003 / BEH-EA-071: the admin group is an admin-tier group, so a host can serve it on
// its own listener (and behind its own authentication) without forking the contract.
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as Admin from "../src/Admin.ts";
import { TestAuth } from "@awthaq/test";

const ORIGIN = "http://localhost:3000";

// One composition, three ways to serve it.
const auth = Auth.make([Admin.Admin]);

type AdminHandler = HttpApiMiddleware.HttpApiMiddlewareSecurity<
  {
    readonly impersonation: typeof Api.ImpersonationCookie;
    readonly cookie: typeof Api.SessionCookie;
    readonly bearer: typeof Api.BearerToken;
  },
  Api.CurrentPrincipal,
  typeof Api.Unauthenticated,
  never
>["cookie"];

/** What a host's replacement admin scheme has to supply: the same three handlers `Api.AdminAuthentication` declares. */
type AdminScheme = Layer.Layer<Api.AdminAuthentication>;

/**
 * The composition, served through the harness: `/admin` is the same group the admin listener serves, and a
 * `services` layer providing `Api.AdminAuthentication` replaces the derived scheme (a host's own).
 */
const adminHandler = (adminAuthentication?: AdminScheme) =>
  TestAuth.app(
    TestAuth.layer(auth, {
      services: Layer.mergeAll(
        Admin.config({ canImpersonate: () => Effect.succeed(true) }),
        adminAuthentication ?? Layer.empty,
      ),
    }),
    { baseUrl: ORIGIN },
  ).handler;

describe("AR-003: the admin tier", () => {
  it.effect("adminApi carries the admin group and publicApi does not", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(Object.keys(auth.adminApi.groups), ["admin"]);
      // MW-002: the public tier is core's own groups; `admin` is not among them.
      assert.deepStrictEqual(Object.keys(auth.publicApi.groups).sort(), ["account", "session"]);
      // The default composition still serves it, beside core's groups.
      assert.deepStrictEqual(Object.keys(auth.api.groups).sort(), ["account", "admin", "session"]);
    }),
  );

  // AR-003 through the harness (plan 15): `tier: "public"` is `AuthHost`'s, so the listener under test is the one a
  // production host serves. The admin group is not routed; core's groups still are.
  it.effect(
    "a listener serving only publicApi answers /admin with 404 and still serves /session",
    () =>
      Effect.gen(function* () {
        const app = TestAuth.app(
          TestAuth.layer(auth, {
            tier: "public",
            services: Admin.config({ canImpersonate: () => Effect.succeed(true) }),
          }),
          { baseUrl: ORIGIN },
        );
        try {
          const admin = yield* Effect.promise(() => app.handler(new Request(`${ORIGIN}/admin`)));
          assert.strictEqual(admin.status, 404);
          const session = yield* Effect.promise(() =>
            app.handler(new Request(`${ORIGIN}/session`)),
          );
          assert.strictEqual(session.status, 401);
        } finally {
          yield* Effect.promise(() => app.dispose());
        }
      }),
  );

  it.effect("the admin listener with a swapped AdminAuthentication authenticates its own way", () =>
    Effect.gen(function* () {
      // A host-supplied scheme (stand-in for mTLS / a service principal): every handler
      // resolves a fixed operator identity from a header instead of any session.
      const operator = Api.UserPrincipal.make({
        ref: Api.PrincipalRef.make({ type: "user", id: "operator-1" }),
        sessionId: "mtls",
      });
      const resolveOperator: AdminHandler = (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers["x-client-cert"] !== "operator") {
            return yield* Effect.fail(new Api.Unauthenticated());
          }
          return yield* Effect.provideService(httpEffect, Api.CurrentPrincipal, operator);
        });
      const CustomAdminAuthentication = Layer.succeed(Api.AdminAuthentication, {
        impersonation: resolveOperator,
        cookie: resolveOperator,
        bearer: resolveOperator,
      });
      const handler = adminHandler(CustomAdminAuthentication);

      // The gate passes for anyone, so what is under test is only *who is let in*.
      const withoutCert = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/admin`)));
      assert.strictEqual(withoutCert.status, 401);
      const withCert = yield* Effect.promise(() =>
        handler(new Request(`${ORIGIN}/admin`, { headers: { "x-client-cert": "operator" } })),
      );
      assert.strictEqual(withCert.status, 200);
    }),
  );

  it.effect("the default AdminAuthentication is the ordinary session authentication", () =>
    Effect.gen(function* () {
      const handler = adminHandler();
      const anonymous = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/admin`)));
      assert.strictEqual(anonymous.status, 401);
    }),
  );
});
