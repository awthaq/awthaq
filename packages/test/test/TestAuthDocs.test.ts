// P20a/BEH-EA-084: `TestAuth.layer`'s `openapiPath`/`docsPath` options mount the generated OpenAPI
// document and the Scalar docs page on the composition's own router, over the same `built.api`
// the routes are registered from — and mount nothing when they are not given.
import { Auth, AuthPlugin } from "@awthaq/core";
import { Authentication, Csrf } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as TestAuth from "../src/TestAuth.ts";

const PingApi = HttpApi.make("auth").add(
  HttpApiGroup.make("ping").add(
    HttpApiEndpoint.get("get", "/ping/get", { success: Schema.String }),
  ),
);

class PingPlugin extends AuthPlugin.Service<PingPlugin, Record<string, never>>()("ping", {
  apiVersion: 1,
  contract: PingApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(PingPlugin, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(PingApi, "ping", (handlers) =>
      handlers.handle("get", () => Effect.succeed("pong")),
    ),
  });
}

const built = Auth.make([PingPlugin]);

const services = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(
      Layer.succeed(Csrf.CsrfConfig, {
        secret: Redacted.make("test-auth-docs-test-csrf-secret-padded-to-thirty-two-bytes"),
        allowedOrigins: [],
      }),
    ),
  ),
);

const serve = (options?: TestAuth.LayerOptions) =>
  HttpRouter.toWebHandler(TestAuth.layer(built, services, options)).handler;

describe("TestAuth.layer options (BEH-EA-084)", () => {
  it.effect("openapiPath and docsPath serve the document and the page derived from built.api", () =>
    Effect.gen(function* () {
      const handler = serve({ openapiPath: "/spec.json", docsPath: "/reference" });
      const spec = yield* Effect.promise(() => handler(new Request("http://localhost/spec.json")));
      assert.strictEqual(spec.status, 200);
      const served = yield* Effect.promise(() => spec.json());
      assert.deepStrictEqual(served, JSON.parse(JSON.stringify(OpenApi.fromApi(built.api))));
      const page = yield* Effect.promise(() => handler(new Request("http://localhost/reference")));
      assert.strictEqual(page.status, 200);
      assert.include(yield* Effect.promise(() => page.text()), "/ping/get");
    }),
  );

  it.effect("without them, neither is mounted", () =>
    Effect.gen(function* () {
      const handler = serve();
      for (const path of ["/spec.json", "/reference", "/docs", "/openapi.json"]) {
        const response = yield* Effect.promise(() => handler(new Request(`http://localhost${path}`)));
        assert.strictEqual(response.status, 404, path);
      }
      const ping = yield* Effect.promise(() => handler(new Request("http://localhost/ping/get")));
      assert.strictEqual(ping.status, 200);
    }),
  );
});
