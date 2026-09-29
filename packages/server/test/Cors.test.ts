// AGA-002/CDS-008: `AuthHttp.cors`, the blessed CORS preset (spec/behaviors/10-csrf.md,
// BEH-EA-073/074, and 11-http-error-mapping.md BEH-EA-083). Its origin allowlist is
// `CsrfConfig.allowedOrigins`, the same value the CSRF origin check reads, so the edge
// policy and the CSRF policy cannot drift; opening CORS never relaxes `CsrfProtection`.
import { Api, AuthCore } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  DataExport,
  Erasure,
  AuthEvents,
  Hooks,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { SqlTransaction, RateLimiter } from "@awthaq/ports";
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
import * as Account from "../src/Account.ts";
import * as Authentication from "../src/Authentication.ts";
import * as AuthHttp from "../src/AuthHttp.ts";
import * as Csrf from "../src/Csrf.ts";
import * as Session from "../src/Session.ts";

const APP_ORIGIN = "https://app.example.com";
const OTHER_ORIGIN = "https://evil.example.com";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const csrfConfig = (allowedOrigins: ReadonlyArray<string>) =>
  Layer.succeed(Csrf.CsrfConfig, {
    secret: Redacted.make("server-cors-test-csrf-secret-padded-to-thirty-two-bytes"),
    allowedOrigins,
  });

/** The real core session/account routes behind `CsrfProtection`, with `AuthHttp.cors` installed over the same `CsrfConfig`. */
const appLayer = (allowedOrigins: ReadonlyArray<string>) =>
  Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, {}).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.cors(),
  ).pipe(
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provide(Csrf.CsrfProtectionLive),
    // CSG-001: `Account.deleteUser` runs core's `AccountErasure` and `Account.exportData` its `AccountExport` (CSG-005).
    Layer.provide(Layer.mergeAll(Erasure.layer, DataExport.layer)),
    // CSG-005: the export endpoint rate-limits per account.
    Layer.provide(RateLimiter.layerPermissive),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(Users.layerMemory),
    Layer.provideMerge(Accounts.layerMemory),
    Layer.provideMerge(Verification.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(csrfConfig(allowedOrigins)),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const send = (allowedOrigins: ReadonlyArray<string>, request: Request) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(appLayer(allowedOrigins), { disableLogger: true })),
    ({ handler }) => Effect.promise(() => handler(request)),
    ({ dispose }) => Effect.promise(dispose),
  );

const preflight = (origin: string) =>
  new Request("http://localhost/session/sign-out", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-csrf-token",
    },
  });

describe("AuthHttp.cors (AGA-002)", () => {
  it.effect(
    "a preflight from an allowed origin is echoed with credentials and the CSRF header",
    () =>
      Effect.gen(function* () {
        const response = yield* send([APP_ORIGIN], preflight(APP_ORIGIN));
        assert.strictEqual(response.status, 204);
        assert.strictEqual(response.headers.get("access-control-allow-origin"), APP_ORIGIN);
        assert.strictEqual(response.headers.get("access-control-allow-credentials"), "true");
        const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
        assert.include(allowedHeaders, Api.CSRF_HEADER_NAME);
        assert.include(allowedHeaders, "authorization");
        assert.include(response.headers.get("access-control-allow-methods") ?? "", "PATCH");
      }),
  );

  it.effect("a preflight from a disallowed origin gets no Access-Control-Allow-Origin", () =>
    Effect.gen(function* () {
      const response = yield* send([APP_ORIGIN], preflight(OTHER_ORIGIN));
      // Without an allowed origin the browser refuses the response, whatever else is sent.
      assert.isNull(response.headers.get("access-control-allow-origin"));
    }),
  );

  it.effect("with an empty allowlist nothing is opened, never the wildcard", () =>
    Effect.gen(function* () {
      const response = yield* send([], preflight(APP_ORIGIN));
      assert.isNull(response.headers.get("access-control-allow-origin"));
    }),
  );

  it.effect("exposes the rotated-token header on actual responses to an allowed origin", () =>
    Effect.gen(function* () {
      const response = yield* send(
        [APP_ORIGIN],
        new Request("http://localhost/session", { headers: { origin: APP_ORIGIN } }),
      );
      assert.strictEqual(response.headers.get("access-control-allow-origin"), APP_ORIGIN);
      assert.include(response.headers.get("access-control-expose-headers") ?? "", "set-auth-token");
    }),
  );

  it.effect(
    "installing CORS never relaxes CSRF: a cross-site POST without the pair is still 403",
    () =>
      Effect.gen(function* () {
        const response = yield* send(
          [APP_ORIGIN],
          new Request("http://localhost/session/sign-out", {
            method: "POST",
            headers: { origin: OTHER_ORIGIN, "sec-fetch-site": "cross-site" },
          }),
        );
        assert.strictEqual(response.status, 403);
        assert.isNull(response.headers.get("access-control-allow-origin"));
      }),
  );
});
