// AR-003 / BEH-EA-071: the admin group is an admin-tier group, so a host can serve it on
// its own listener (and behind its own authentication) without forking the contract.
import { Api } from "@awthaq/api";
import {
  Accounts,
  Auth,
  DataExport,
  Erasure,
  Persistence,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
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

  // Hand-wired on purpose: which API tier a listener serves (`AuthHttp.routes(auth.publicApi)` alone) is the wiring
  // under test, and `TestAuth.layer` always serves the whole composition (plan 08 exemption). Nothing here
  // authenticates, so the principal resolver is a stub.
  it.effect("a listener serving only publicApi answers /admin with 404", () =>
    Effect.gen(function* () {
      const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
        Layer.provideMerge(FileSystem.layerNoop({})),
      );
      const CoreLive = Layer.mergeAll(
        Sessions.layer.pipe(Layer.provide(Persistence.memory)),
        Users.layer.pipe(Layer.provide(Persistence.memory)),
      ).pipe(Layer.provideMerge(TestAuth.memoryFoundation));
      const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
        Layer.provide(
          Layer.succeed(Csrf.CsrfConfig, {
            secret: Redacted.make("admin-tier-test-csrf-secret-padded-to-thirty-two-bytes"),
            allowedOrigins: [] as ReadonlyArray<string>,
          }),
        ),
        Layer.provide(NodeCrypto.layer),
      );
      const AuthenticationLive = Authentication.AuthenticationLive.pipe(
        Layer.provide(
          Layer.succeed(
            Authentication.PrincipalResolver,
            Authentication.PrincipalResolver.of({ resolve: () => Effect.die("not used") }),
          ),
        ),
      );
      const { handler } = HttpRouter.toWebHandler(
        AuthHttp.routes(auth.publicApi).pipe(
          Layer.provide(AuthHttp.coreHandlers),
          // CSG-001/CSG-005: the account handlers call core's erasure and export, and rate limit the export.
          Layer.provide(
            Layer.mergeAll(
              Erasure.layer,
              DataExport.layer,
              RateLimiter.layerPermissive,
              RateLimits.layer,
            ),
          ),
          Layer.provide(AuthenticationLive),
          Layer.provide(CsrfProtectionLive),
          // The account group's erasure cascade and data export (CSG-001/CSG-005), and its limiter.
          Layer.provide(Layer.mergeAll(Erasure.layer, DataExport.layer)),
          Layer.provideMerge(RateLimiter.layerPermissive),
          Layer.provideMerge(SqlTransaction.layerNoop),
          Layer.provideMerge(Accounts.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provideMerge(Verification.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(TestServices),
          Layer.provideMerge(HttpRouter.layer),
        ),
      );
      const response = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/admin`)));
      assert.strictEqual(response.status, 404);
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
