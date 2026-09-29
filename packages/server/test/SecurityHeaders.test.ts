// PDR-004: the opt-in security-headers middleware — defaults, per-header
// overrides/omission, and never clobbering a header a handler already set.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SecurityHeaders from "../src/SecurityHeaders.ts";

const respond = (options: SecurityHeaders.SecurityHeadersOptions | undefined) =>
  Effect.gen(function* () {
    const routes = HttpRouter.add("GET", "/plain", HttpServerResponse.text("hi")).pipe(
      Layer.merge(
        HttpRouter.add(
          "GET",
          "/own-referrer",
          HttpServerResponse.setHeader(
            HttpServerResponse.text("hi"),
            "referrer-policy",
            "no-referrer",
          ),
        ),
      ),
    );
    const app = Layer.mergeAll(routes, SecurityHeaders.layer(options));
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    const plain = yield* Effect.promise(() => handler(new Request("http://localhost/plain")));
    const own = yield* Effect.promise(() => handler(new Request("http://localhost/own-referrer")));
    yield* Effect.promise(dispose);
    return { plain, own };
  });

describe("SecurityHeaders (PDR-004)", () => {
  it.effect("sends the default set on every response", () =>
    Effect.gen(function* () {
      const { plain } = yield* respond(undefined);
      assert.strictEqual(
        plain.headers.get("strict-transport-security"),
        "max-age=31536000; includeSubDomains",
      );
      assert.strictEqual(plain.headers.get("x-content-type-options"), "nosniff");
      assert.strictEqual(plain.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.strictEqual(plain.headers.get("x-frame-options"), "DENY");
      assert.strictEqual(plain.headers.get("content-security-policy"), "frame-ancestors 'none'");
    }),
  );

  it.effect("honors overrides and omits a header set to false", () =>
    Effect.gen(function* () {
      const { plain } = yield* respond({
        strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
        frameOptions: false,
        contentSecurityPolicy: false,
      });
      assert.strictEqual(
        plain.headers.get("strict-transport-security"),
        "max-age=63072000; includeSubDomains; preload",
      );
      assert.isNull(plain.headers.get("x-frame-options"));
      assert.isNull(plain.headers.get("content-security-policy"));
    }),
  );

  it.effect("never overrides a header the handler already set", () =>
    Effect.gen(function* () {
      const { own } = yield* respond(undefined);
      assert.strictEqual(own.headers.get("referrer-policy"), "no-referrer");
      assert.strictEqual(own.headers.get("x-content-type-options"), "nosniff");
    }),
  );
});
