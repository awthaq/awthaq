// spec/behaviors/10-csrf.md, BEH-EA-073 through BEH-EA-080.
import { Api } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Csrf from "../src/Csrf.ts";

// `HttpApiTest.groups` needs these platform services regardless of which
// middleware is under test — the same bundle effect's own HttpApiBuilder
// test suite provides for every test exercising it.
const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

// A reference HMAC computed independently of `Csrf.ts`'s own implementation
// (Node's `node:crypto`, not `effect/Crypto`) so a passing "valid double-submit"
// test actually exercises RFC 2104 compatibility, not just self-consistency.
const secret = "test-csrf-secret";
const validCookieValue = (): string => {
  const token = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret).update(token).digest("hex");
  return `${token}.${signature}`;
};

const RequestHeaders = {
  "sec-fetch-site": Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  authorization: Schema.optional(Schema.String),
  cookie: Schema.optional(Schema.String),
  "x-csrf-token": Schema.optional(Schema.String),
};

const TestApi = HttpApi.make("test").add(
  HttpApiGroup.make("protected")
    .add(HttpApiEndpoint.get("read", "/thing", { headers: RequestHeaders, success: Schema.String }))
    .add(
      HttpApiEndpoint.post("write", "/thing", { headers: RequestHeaders, success: Schema.String }),
    )
    .middleware(Api.CsrfProtection),
);

const GroupLayer = HttpApiBuilder.group(TestApi, "protected", (handlers) =>
  handlers.handle("read", () => Effect.succeed("ok")).handle("write", () => Effect.succeed("ok")),
);

// BEH-EA-076/INV-EA-011: `CsrfProtection` is `requiredForClient: true`, so the
// generated client refuses to type-check without this — proof the invariant
// holds. This test drives the cookie/header pair manually, so the client-side
// layer itself is a no-op passthrough.
const CsrfClientPassthrough = HttpApiMiddleware.layerClient(
  Api.CsrfProtection,
  ({ next, request }) => next(request),
);

const TestLayer = GroupLayer.pipe(
  Layer.provideMerge(Csrf.CsrfProtectionLive),
  Layer.provideMerge(CsrfClientPassthrough),
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(secret),
      allowedOrigins: ["https://example.com"],
    }),
  ),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
);

describe("CsrfProtection", () => {
  it.effect("BEH-EA-077: a safe GET is exempt even with no CSRF signal at all", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const result = yield* client.protected.read({ headers: {} });
      assert.strictEqual(result, "ok");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-073: Sec-Fetch-Site: cross-site rejects an unsafe request", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const cookie = validCookieValue();
      const failure = yield* client.protected
        .write({
          headers: {
            "sec-fetch-site": "cross-site",
            cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
            "x-csrf-token": cookie,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-074: an Origin mismatch rejects when Sec-Fetch-Site is absent", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const cookie = validCookieValue();
      const failure = yield* client.protected
        .write({
          headers: {
            origin: "https://evil.example",
            cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
            "x-csrf-token": cookie,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-075/077: a missing double-submit header rejects even when the site check passes",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
        const cookie = validCookieValue();
        const failure = yield* client.protected
          .write({
            headers: {
              origin: "https://example.com",
              cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
              // no x-csrf-token: the header must echo the cookie, not just exist alongside it
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CsrfRejected");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-073/075: a matching Sec-Fetch-Site and a valid double-submit pair succeed",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
        const cookie = validCookieValue();
        const result = yield* client.protected.write({
          headers: {
            "sec-fetch-site": "same-origin",
            cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
            "x-csrf-token": cookie,
          },
        });
        assert.strictEqual(result, "ok");
      }).pipe(Effect.provide(TestLayer)),
  );

  // MNA-008/decision 24 §2: a request authenticating through an explicit
  // `Authorization` header is outside CSRF's threat model (a cross-site page
  // cannot set it without a CORS preflight), so a cookie-less bearer/native
  // client is not 403'd on unsafe methods.
  it.effect("MNA-008: an unsafe request with an Authorization header needs no CSRF pair", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const result = yield* client.protected.write({
        headers: { authorization: "Bearer some-token" },
      });
      assert.strictEqual(result, "ok");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("MNA-008: an empty Authorization header grants no exemption", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const failure = yield* client.protected
        .write({ headers: { authorization: "   " } })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("MNA-008: a cookie-only unsafe request without the pair is still rejected", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const failure = yield* client.protected
        .write({ headers: { cookie: "__Host-session=abc.def" } })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );
});
