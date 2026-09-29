// spec/behaviors/10-csrf.md, BEH-EA-073 through BEH-EA-080.
import { Api } from "@awthaq/api";
import { SessionCookie } from "@awthaq/core";
import { Hmac } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as Etag from "effect/unstable/http/Etag";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
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
const secret = "test-csrf-secret-padded-to-thirty-two-bytes";
// CDS-006: `<iat>.<random>.<hmac(iat.random)>`. `it.effect` runs under a
// TestClock that starts at 0, so a default `iat` of 0 is a token minted "now".
const validCookieValue = (iat = 0): string => {
  const signed = `${iat}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", secret).update(signed).digest("hex");
  return `${signed}.${signature}`;
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
      // With a cookie present: the exemption below (no Cookie header at all) does not apply.
      const failure = yield* client.protected
        .write({ headers: { authorization: "   ", cookie: "__Host-session=abc.def" } })
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

// Native first sign-in (BEH-EA-077, cookie-less exemption): CSRF defends ambient browser credentials,
// and a request with no `Cookie` header at all carries none, so the double-submit pair is not
// demanded of it; the site checks still run, and a stricter form of them guards the login-CSRF case.
describe("Csrf cookie-less requests (native first sign-in)", () => {
  const layerWith = (extra: { readonly requireTokenWithoutCookies?: boolean }) =>
    GroupLayer.pipe(
      Layer.provideMerge(Csrf.CsrfProtectionLive),
      Layer.provideMerge(CsrfClientPassthrough),
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: Redacted.make(secret),
          allowedOrigins: ["https://example.com"],
          ...extra,
        }),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(TestServices),
    );

  const post = (headers: Record<string, string>, layer: ReturnType<typeof layerWith> = TestLayer) =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      return yield* client.protected.write({ headers }).pipe(Effect.result);
    }).pipe(Effect.provide(layer));

  const assertAllowed = (headers: Record<string, string>) =>
    Effect.gen(function* () {
      const result = yield* post(headers);
      assert.isTrue(result._tag === "Success", "expected the request to pass CsrfProtection");
    });

  const assertRejected = (
    headers: Record<string, string>,
    layer: ReturnType<typeof layerWith> = TestLayer,
  ) =>
    Effect.gen(function* () {
      const result = yield* post(headers, layer);
      assert.isTrue(result._tag === "Failure" && result.failure._tag === "CsrfRejected");
    });

  it.effect("a native client's first sign-in (no cookies, no site headers) needs no token", () =>
    assertAllowed({}),
  );

  it.effect("a browser's same-origin cookie-less POST (first visit) needs no token", () =>
    Effect.gen(function* () {
      yield* assertAllowed({ "sec-fetch-site": "same-origin" });
      yield* assertAllowed({ "sec-fetch-site": "none" });
      yield* assertAllowed({ origin: "https://example.com" });
    }),
  );

  it.effect("login CSRF: a cross-site or foreign-Origin cookie-less POST is still rejected", () =>
    Effect.gen(function* () {
      yield* assertRejected({ "sec-fetch-site": "cross-site" });
      yield* assertRejected({ origin: "https://evil.example" });
      yield* assertRejected({ origin: "null" });
    }),
  );

  it.effect(
    "a same-site sibling (Sec-Fetch-Site: same-site) is refused unless its Origin is allowed",
    () =>
      Effect.gen(function* () {
        yield* assertRejected({ "sec-fetch-site": "same-site" });
        yield* assertRejected({
          "sec-fetch-site": "same-site",
          origin: "https://evil.example.com",
        });
        yield* assertAllowed({ "sec-fetch-site": "same-site", origin: "https://example.com" });
      }),
  );

  it.effect("a browser with a stale session cookie still needs the double-submit pair", () =>
    Effect.gen(function* () {
      yield* assertRejected({
        cookie: "__Host-session=stale.secret",
        "sec-fetch-site": "same-origin",
      });
      // Any cookie at all means ambient credentials may be attached: not only the session cookie.
      yield* assertRejected({ cookie: "_ga=GA1.2.3", "sec-fetch-site": "same-origin" });
      yield* assertRejected({ cookie: `${Api.CSRF_COOKIE_NAME}=not-a-valid-token` });
    }),
  );

  it.effect("a blank Cookie header is no cookies", () => assertAllowed({ cookie: "   " }));

  it.effect("requireTokenWithoutCookies: true restores the pair for cookie-less requests too", () =>
    assertRejected({}, layerWith({ requireTokenWithoutCookies: true })),
  );
});

// SMS-004/ACS-007: the Config-backed layer.
describe("Csrf.layerConfig", () => {
  const configLayer = (env: Record<string, string>) =>
    Csrf.layerConfig.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

  const read = (env: Record<string, string>) =>
    Effect.gen(function* () {
      return yield* Csrf.CsrfConfig;
    }).pipe(Effect.provide(configLayer(env)));

  it.effect("reads AWTHAQ_CSRF_SECRET and AWTHAQ_CSRF_ALLOWED_ORIGINS", () =>
    Effect.gen(function* () {
      const config = yield* read({
        AWTHAQ_CSRF_SECRET: "s".repeat(32),
        AWTHAQ_CSRF_ALLOWED_ORIGINS: "https://a.example,https://b.example",
      });
      assert.strictEqual(Redacted.value(config.secret), "s".repeat(32));
      assert.deepStrictEqual(config.allowedOrigins, ["https://a.example", "https://b.example"]);
    }),
  );

  it.effect("defaults allowedOrigins to none", () =>
    Effect.gen(function* () {
      const config = yield* read({ AWTHAQ_CSRF_SECRET: "s".repeat(32) });
      assert.deepStrictEqual(config.allowedOrigins, []);
    }),
  );

  it.effect("a missing secret fails with a ConfigError", () =>
    Effect.gen(function* () {
      const failure = yield* read({}).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ConfigError");
    }),
  );

  it.effect("a short secret dies with WeakSigningSecret", () =>
    Effect.gen(function* () {
      const exit = yield* read({ AWTHAQ_CSRF_SECRET: "too-short" }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (!Exit.isFailure(exit)) return;
      assert.instanceOf(Cause.squash(exit.cause), Hmac.WeakSigningSecret);
    }),
  );
});

// AGA-004: the double-submit cookie follows the session cookie's embedded mode.
describe("Csrf cookie attributes follow the session cookie mode (AGA-004)", () => {
  const appLayer = (cookieConfig: Layer.Layer<never>) =>
    HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(GroupLayer),
      Layer.provideMerge(Csrf.CsrfProtectionLive),
      Layer.provideMerge(CsrfClientPassthrough),
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: Redacted.make(secret),
          allowedOrigins: ["https://example.com"],
        }),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(cookieConfig),
      Layer.provideMerge(TestServices),
      Layer.provideMerge(HttpRouter.layer),
    );

  const mintedCookie = Effect.scoped(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      let written: HttpServerResponse.HttpServerResponse | undefined;
      yield* HttpEffect.toHandled(router.asHttpEffect(), (_request, response) =>
        Effect.sync(() => {
          written = response;
        }),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("http://localhost/thing")),
        ),
      );
      return written === undefined ? undefined : Cookies.get(written.cookies, Api.CSRF_COOKIE_NAME);
    }),
  );

  it.effect("the default mints __Host-csrf with SameSite=Strict and Secure", () =>
    Effect.gen(function* () {
      const cookie = yield* mintedCookie;
      assert.isDefined(cookie);
      if (cookie === undefined || cookie._tag === "None") return;
      assert.strictEqual(cookie.value.options?.sameSite, "strict");
      assert.isTrue(cookie.value.options?.secure);
      assert.isUndefined(cookie.value.options?.partitioned);
    }).pipe(Effect.provide(appLayer(SessionCookie.config({})))),
  );

  it.effect("HostEmbedded mints __Host-csrf with SameSite=None; Partitioned", () =>
    Effect.gen(function* () {
      const cookie = yield* mintedCookie;
      assert.isDefined(cookie);
      if (cookie === undefined || cookie._tag === "None") return;
      assert.strictEqual(cookie.value.options?.sameSite, "none");
      assert.isTrue(cookie.value.options?.partitioned);
      assert.isTrue(cookie.value.options?.secure);
    }).pipe(Effect.provide(appLayer(SessionCookie.config({ mode: SessionCookie.HostEmbedded })))),
  );
});

// CDS-006: the double-submit token is time-bound and re-minted at half-life.
describe("Csrf token lifetime (CDS-006)", () => {
  it.effect("a token older than maxAge is rejected on POST", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const cookie = validCookieValue(0);
      yield* TestClock.adjust(Duration.hours(25));
      const failure = yield* client.protected
        .write({
          headers: {
            "sec-fetch-site": "same-origin",
            cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
            "x-csrf-token": cookie,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a token within maxAge is accepted on POST, even past half-life", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const cookie = validCookieValue(0);
      yield* TestClock.adjust(Duration.hours(20));
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

  it.effect("a token with a tampered iat fails the signature", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const genuine = validCookieValue(0);
      // Same signature, a fresher-looking iat.
      const [, random, signature] = genuine.split(".");
      yield* TestClock.adjust(Duration.hours(25));
      const forged = `${25 * 3600}.${random}.${signature}`;
      const failure = yield* client.protected
        .write({
          headers: {
            "sec-fetch-site": "same-origin",
            cookie: `${Api.CSRF_COOKIE_NAME}=${forged}`,
            "x-csrf-token": forged,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a token minted in the future beyond the skew allowance is rejected", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["protected"]);
      const cookie = validCookieValue(3600);
      const failure = yield* client.protected
        .write({
          headers: {
            "sec-fetch-site": "same-origin",
            cookie: `${Api.CSRF_COOKIE_NAME}=${cookie}`,
            "x-csrf-token": cookie,
          },
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CsrfRejected");
    }).pipe(Effect.provide(TestLayer)),
  );

  describe("re-minting", () => {
    const appLayer = HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(GroupLayer),
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
      Layer.provideMerge(HttpRouter.layer),
    );

    const getWithCookie = (cookieValue: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          let written: HttpServerResponse.HttpServerResponse | undefined;
          yield* HttpEffect.toHandled(router.asHttpEffect(), (_request, response) =>
            Effect.sync(() => {
              written = response;
            }),
          ).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/thing", {
                  headers: { cookie: `${Api.CSRF_COOKIE_NAME}=${cookieValue}` },
                }),
              ),
            ),
          );
          return written === undefined
            ? undefined
            : Cookies.get(written.cookies, Api.CSRF_COOKIE_NAME);
        }),
      );

    it.effect("a token older than maxAge/2 is re-minted on a GET", () =>
      Effect.gen(function* () {
        const cookie = validCookieValue(0);
        yield* TestClock.adjust(Duration.hours(13));
        const reminted = yield* getWithCookie(cookie);
        assert.isDefined(reminted);
        if (reminted === undefined || reminted._tag === "None") return;
        assert.notStrictEqual(reminted.value.value, cookie);
        assert.strictEqual(reminted.value.value.split(".")[0], String(13 * 3600));
      }).pipe(Effect.provide(appLayer)),
    );

    it.effect("a fresh token is not re-minted", () =>
      Effect.gen(function* () {
        const cookie = validCookieValue(0);
        yield* TestClock.adjust(Duration.hours(1));
        const reminted = yield* getWithCookie(cookie);
        assert.isTrue(reminted === undefined || reminted._tag === "None");
      }).pipe(Effect.provide(appLayer)),
    );
  });
});

// ACS-007: no composition may run CSRF signing with a key under 32 bytes.
describe("CsrfProtectionLive secret floor (ACS-007)", () => {
  const build = (secretText: string) =>
    Csrf.CsrfProtectionLive.pipe(
      Layer.provide(
        Layer.succeed(Csrf.CsrfConfig, {
          secret: Redacted.make(secretText),
          allowedOrigins: [] as ReadonlyArray<string>,
        }),
      ),
      Layer.provide(NodeCrypto.layer),
      Layer.build,
      Effect.scoped,
    );

  it.effect("building it with a 16-byte secret dies with WeakSigningSecret", () =>
    Effect.gen(function* () {
      const exit = yield* build("a".repeat(16)).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (!Exit.isFailure(exit)) return;
      assert.instanceOf(Cause.squash(exit.cause), Hmac.WeakSigningSecret);
    }),
  );

  it.effect("a 32-byte secret builds", () =>
    Effect.gen(function* () {
      const exit = yield* build("a".repeat(32)).pipe(Effect.exit);
      assert.isTrue(Exit.isSuccess(exit));
    }),
  );
});
