// Hand-wired on purpose: the user agent against a minimal router (plan 08 exemption), the
// `InProcessClient.test.ts` harness. spec/behaviors/24-nextjs-ssr.md, BEH-EA-344: one in-process user agent
// keeps the cookie state, the CSRF echo and the bearer token, against the real `CsrfProtection`.
import { Api } from "@awthaq/api";
import { Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as UserAgent from "../src/UserAgent.ts";

const secret = "test-csrf-secret-0123456789-0123456789";

const Ok = Schema.Struct({ ok: Schema.Boolean });
const Seen = Schema.Struct({ session: Schema.NullOr(Schema.String) });

const TestApi = HttpApi.make("user-agent-test").add(
  HttpApiGroup.make("auth")
    .add(HttpApiEndpoint.post("signIn", "/sign-in", { success: Ok }))
    .add(HttpApiEndpoint.post("rotate", "/rotate", { success: Ok }))
    .add(HttpApiEndpoint.post("signOut", "/sign-out", { success: Ok }))
    .add(HttpApiEndpoint.get("whoami", "/whoami", { success: Seen }))
    .middleware(Api.CsrfProtection),
);

const sessionCookie = (value: string, maxAge?: number) =>
  HttpApiBuilder.securitySetCookie(Api.SessionCookie, value, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    ...(maxAge === undefined ? {} : { maxAge }),
  });

const Handlers = HttpApiBuilder.group(TestApi, "auth", (handlers) =>
  handlers
    .handle("signIn", () => Effect.as(sessionCookie("first"), { ok: true }))
    .handle("rotate", () => Effect.as(sessionCookie("second"), { ok: true }))
    .handle("signOut", () => Effect.as(sessionCookie("", 0), { ok: true }))
    .handle(
      "whoami",
      Effect.fnUntraced(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return { session: request.cookies[Api.SessionCookie.key] ?? null };
      }),
    ),
);

const AppLayer = HttpApiBuilder.layer(TestApi).pipe(
  Layer.provide(Handlers),
  Layer.provide(Csrf.CsrfProtectionLive),
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(secret),
      allowedOrigins: ["http://localhost"],
    }),
  ),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(
    Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
      Layer.provideMerge(FileSystem.layerNoop({})),
    ),
  ),
  Layer.provideMerge(HttpRouter.layer),
);

const withHandler = async (
  body: (handler: (request: Request) => Promise<Response>) => Promise<void>,
) => {
  const { handler, dispose } = HttpRouter.toWebHandler(AppLayer);
  try {
    await body(handler);
  } finally {
    await dispose();
  }
};

const whoami = async (agent: UserAgent.UserAgent) =>
  (await (await agent.request("GET", "/whoami")).json()).session;

/** A handler that answers every request with `headers` and records the requests it saw. */
const scripted = (headers: (request: Request) => HeadersInit = () => ({})) => {
  const seen: Array<Request> = [];
  return {
    seen,
    handler: async (request: Request) => {
      seen.push(request);
      return new Response("{}", { status: 200, headers: headers(request) });
    },
  };
};

describe("UserAgent (BEH-EA-344)", () => {
  it("a sign-in through `request` is followed by an authenticated call, with no cookie handling in the test", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      assert.strictEqual((await agent.request("POST", "/sign-in")).status, 200);
      assert.strictEqual(await whoami(agent), "first");
    }));

  it("a fresh agent's first POST passes the cookie-less exemption, and the minted __Host-csrf is echoed next", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      await agent.request("POST", "/sign-in");
      assert.isFalse(agent.sent[0]?.headers.has("cookie"));
      const csrf = agent.cookies.value(Api.CSRF_COOKIE_NAME);
      assert.isString(csrf);
      assert.strictEqual((await agent.request("POST", "/rotate")).status, 200);
      assert.strictEqual(agent.sent[1]?.headers.get(Api.CSRF_HEADER_NAME), csrf);
      // A safe method carries no echo.
      await agent.request("GET", "/whoami");
      assert.isFalse(agent.sent[2]?.headers.has(Api.CSRF_HEADER_NAME));
    }));

  it("a rotated session cookie replaces the stored one; a sign-out's expiry removes it", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      await agent.request("POST", "/sign-in");
      await agent.request("POST", "/rotate");
      assert.strictEqual(await whoami(agent), "second");
      await agent.request("POST", "/sign-out");
      assert.isUndefined(agent.cookies.get(Api.SessionCookie.key));
      assert.isNull(await whoami(agent));
    }));

  it("extraCookies are sent after the store's and are not stored", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      await agent.request("POST", "/sign-in");
      await agent.request("GET", "/whoami", { extraCookies: { legacy: "forged" } });
      const cookie = agent.sent[1]?.headers.get("cookie") ?? "";
      assert.match(cookie, /__Host-session=first.*; legacy=forged$/);
      assert.isUndefined(agent.cookies.get("legacy"));
    }));

  it("a cross-site request sends Sec-Fetch-Site and an Origin, and withholds a Strict session cookie", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      await agent.request("POST", "/sign-in");
      const response = await agent.request("GET", "/whoami", {
        site: "cross-site",
        navigation: true,
      });
      assert.isNull((await response.json()).session);
      const sent = agent.sent[1]?.headers;
      assert.strictEqual(sent?.get("sec-fetch-site"), "cross-site");
      assert.strictEqual(sent?.get("origin"), "https://elsewhere.example");
      // ...and the server refuses a cross-site unsafe request.
      assert.strictEqual(
        (await agent.request("POST", "/rotate", { site: "cross-site" })).status,
        403,
      );
    }));

  it("a Set-Cookie a browser refuses rejects the request under `browser`; `record` keeps it in `refused`", async () => {
    const bad = scripted(() => ({ "set-cookie": "__Host-bad=1; Secure; Path=/narrow" }));
    const strict = UserAgent.make({ handler: bad.handler });
    await strict.request("GET", "/x").then(
      () => assert.fail("expected a rejection"),
      (error) => assert.include(String(error), "HostPrefix"),
    );
    const lenient = UserAgent.make({ handler: bad.handler, onRefused: "record" });
    assert.strictEqual((await lenient.request("GET", "/x")).status, 200);
    assert.strictEqual(lenient.refused[0]?.refusal, "HostPrefix");
    assert.isUndefined(lenient.cookies.get("__Host-bad"));
  });

  it("bearer: the delivery header and Authorization, no Cookie; set-auth-token replaces, x-awthaq-session-ended clears", async () => {
    const server = scripted((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/mint")
        return { [Api.ROTATED_TOKEN_HEADER]: "t1", "set-cookie": "__Host-csrf=c; Secure; Path=/" };
      if (path === "/end")
        return { [Api.ROTATED_TOKEN_HEADER]: "t2", [Api.SESSION_ENDED_HEADER]: "1" };
      return {};
    });
    const agent = UserAgent.make({ handler: server.handler, delivery: "bearer" });
    await agent.request("POST", "/mint");
    assert.strictEqual(server.seen[0]?.headers.get(Api.TOKEN_DELIVERY_HEADER), "bearer");
    assert.isFalse(server.seen[0]?.headers.has("authorization"));
    assert.strictEqual(agent.bearer.current(), "t1");
    await agent.request("POST", "/use");
    assert.strictEqual(server.seen[1]?.headers.get("authorization"), "Bearer t1");
    assert.isFalse(server.seen[1]?.headers.has("cookie"));
    assert.isFalse(server.seen[1]?.headers.has(Api.CSRF_HEADER_NAME));
    await agent.request("POST", "/end");
    assert.isUndefined(agent.bearer.current());
  });

  it("mirror receives every Set-Cookie; forward copies user-agent and x-forwarded-for only when absent", async () => {
    const server = scripted(() => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=x%20y; Path=/");
      return headers;
    });
    const mirrored: Array<{ readonly name: string; readonly value: string }> = [];
    const agent = UserAgent.make({
      handler: server.handler,
      mirror: { set: (name, value) => mirrored.push({ name, value }) },
      forward: {
        from: {
          get: (name) => ({ "user-agent": "ua/1", "x-forwarded-for": "203.0.113.7" })[name] ?? null,
        },
        names: ["user-agent", "x-forwarded-for"],
      },
    });
    await agent.request("GET", "/x", { headers: { "user-agent": "explicit/2" } });
    assert.deepStrictEqual(mirrored, [
      { name: "a", value: "1" },
      { name: "b", value: "x y" },
    ]);
    assert.strictEqual(server.seen[0]?.headers.get("user-agent"), "explicit/2");
    assert.strictEqual(server.seen[0]?.headers.get("x-forwarded-for"), "203.0.113.7");
  });

  it("hold leaves the request pending and logs it in `sent`", async () => {
    const server = scripted();
    const agent = UserAgent.make({
      handler: server.handler,
      hold: (url) => url.pathname === "/slow",
    });
    const pending = agent.fetch("/slow");
    const settled = await Promise.race([pending.then(() => "settled"), Promise.resolve("pending")]);
    assert.strictEqual(settled, "pending");
    assert.strictEqual(agent.sent[0]?.url.pathname, "/slow");
    assert.strictEqual(server.seen.length, 0);
  });

  it("`client` signs in typed and the session reaches the next call", () =>
    withHandler(async (handler) => {
      const agent = UserAgent.make({ handler });
      const seen = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* UserAgent.client(agent, TestApi);
          yield* client.auth.signIn();
          yield* client.auth.rotate();
          return yield* client.auth.whoami();
        }),
      );
      assert.deepStrictEqual(seen, { session: "second" });
    }));
});
