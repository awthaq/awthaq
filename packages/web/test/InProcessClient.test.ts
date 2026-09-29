// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189/190 (BO-002/NSA-008): the typed
// in-process server-action client, against a *real* composed router — the
// same `HttpRouter.toWebHandler` shape an application builds next to its
// runtime — with the real `CsrfProtection` guarding the mutating group.
import { Api } from "@awthaq/api";
import { Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { inProcessClient, makeInProcessClient } from "../src/InProcessClient.ts";

// CSRF secrets must be at least 32 bytes (the layer dies at build otherwise).
const secret = "test-csrf-secret-0123456789-0123456789";
// `<iatSeconds>.<random>.<hmac>` — the wire format `CsrfProtectionLive` mints and verifies.
const validCsrfCookie = (): string => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("hex")}`;
};

const Echo = Schema.Struct({
  userAgent: Schema.NullOr(Schema.String),
  forwardedFor: Schema.NullOr(Schema.String),
  cookie: Schema.NullOr(Schema.String),
});

const TestApi = HttpApi.make("server-action-test").add(
  HttpApiGroup.make("login")
    .add(
      HttpApiEndpoint.post("signIn", "/sign-in", {
        success: Schema.Struct({ ok: Schema.Boolean }),
      }),
    )
    .add(HttpApiEndpoint.post("echo", "/echo", { success: Echo }))
    .middleware(Api.CsrfProtection),
);

const Handlers = HttpApiBuilder.group(TestApi, "login", (handlers) =>
  handlers
    .handle(
      "signIn",
      Effect.fnUntraced(function* () {
        yield* HttpApiBuilder.securitySetCookie(Api.SessionCookie, "issued-session-token", {
          httpOnly: true,
          secure: true,
          sameSite: "strict",
          path: "/",
        });
        return { ok: true };
      }),
    )
    .handle(
      "echo",
      Effect.fnUntraced(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return {
          userAgent: request.headers["user-agent"] ?? null,
          forwardedFor: request.headers["x-forwarded-for"] ?? null,
          cookie: request.headers["cookie"] ?? null,
        };
      }),
    ),
);

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const AppLayer = HttpApiBuilder.layer(TestApi).pipe(
  Layer.provide(Handlers),
  Layer.provide(Csrf.CsrfProtectionLive),
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

const actionHeaders = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()] ?? null,
});

const recordingJar = () => {
  const calls: Array<{ readonly name: string; readonly value: string }> = [];
  return { calls, set: (name: string, value: string) => calls.push({ name, value }) };
};

describe("inProcessClient (BO-002/NSA-008)", () => {
  it("signIn through the in-process client writes the session cookie into the jar", async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(AppLayer);
    try {
      const csrf = validCsrfCookie();
      const jar = recordingJar();
      const client = await inProcessClient(TestApi, {
        handler,
        headers: actionHeaders({ cookie: `${Api.CSRF_COOKIE_NAME}=${csrf}` }),
        jar,
      });
      const result = await client.login.signIn();
      assert.deepStrictEqual(result, { ok: true });
      const session = jar.calls.find((call) => call.name === Api.SessionCookie.key);
      assert.strictEqual(session?.value, "issued-session-token");
    } finally {
      await dispose();
    }
  });

  it("a cold action (no CSRF cookie yet) succeeds on the bootstrap retry and hands the fresh cookie to the jar", async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(AppLayer);
    try {
      const jar = recordingJar();
      const client = await inProcessClient(TestApi, {
        handler,
        headers: actionHeaders({}),
        jar,
      });
      assert.deepStrictEqual(await client.login.signIn(), { ok: true });
      const names = jar.calls.map((call) => call.name);
      assert.include(names, Api.CSRF_COOKIE_NAME);
      assert.include(names, Api.SessionCookie.key);
    } finally {
      await dispose();
    }
  });

  it("the action's user-agent, x-forwarded-for and cookies reach the handler", async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(AppLayer);
    try {
      const csrf = validCsrfCookie();
      const client = await inProcessClient(TestApi, {
        handler,
        headers: actionHeaders({
          cookie: `theme=dark; ${Api.CSRF_COOKIE_NAME}=${csrf}`,
          "user-agent": "action-browser/1.0",
          "x-forwarded-for": "203.0.113.7",
        }),
        jar: recordingJar(),
      });
      const echoed = await client.login.echo();
      assert.strictEqual(echoed.userAgent, "action-browser/1.0");
      assert.strictEqual(echoed.forwardedFor, "203.0.113.7");
      assert.include(echoed.cookie ?? "", "theme=dark");
      assert.include(echoed.cookie ?? "", `${Api.CSRF_COOKIE_NAME}=${csrf}`);
    } finally {
      await dispose();
    }
  });

  it("result mode resolves a typed CsrfRejected when the handler keeps rejecting, instead of throwing", async () => {
    const client = await inProcessClient(TestApi, {
      handler: async () =>
        new Response(JSON.stringify({ _tag: "CsrfRejected" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      headers: actionHeaders({}),
      jar: recordingJar(),
      mode: "result",
    });
    const result = await client.login.signIn();
    assert.isTrue(Result.isFailure(result));
    assert.strictEqual(Result.isFailure(result) ? result.failure._tag : undefined, "CsrfRejected");
  });

  it("makeInProcessClient is the same client as an Effect", async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(AppLayer);
    try {
      const csrf = validCsrfCookie();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeInProcessClient(TestApi, {
            handler,
            headers: actionHeaders({ cookie: `${Api.CSRF_COOKIE_NAME}=${csrf}` }),
            jar: recordingJar(),
          });
          return yield* client.login.signIn();
        }),
      );
      assert.deepStrictEqual(result, { ok: true });
    } finally {
      await dispose();
    }
  });
});
