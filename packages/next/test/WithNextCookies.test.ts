// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189.
//
// Two layers of proof: a pure-parsing suite against synthetic `Response`
// objects (no HTTP router needed — this is what actually exercises the
// `Set-Cookie` attribute translation), and one integration test proving
// `withNextCookies` works against a *real* `Response` produced by
// dispatching a request through a composed router whose handler calls
// `HttpApiBuilder.securitySetCookie` — the same `LoginGroup`/`LoginHandlers`
// pattern `packages/qadi/test/SubjectApi.test.ts` already established for
// "mint a real session over HTTP."
//
// There is no test here for "wrapping a plain domain-service call produces
// no cookies": `withNextCookies` takes a `Response`, and a domain service
// (`Users.rename`, `Sessions.issue` called directly) returns plain data, not
// a `Response` — the type system already makes that misuse impossible to
// even attempt, a stronger guarantee than a runtime assertion could give.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { withNextCookies } from "../src/WithNextCookies.ts";
import type { CookieSetOptions } from "../src/index.ts";

type Recorded = readonly [name: string, value: string, options: CookieSetOptions | undefined];

const recordingJar = (): {
  readonly calls: Array<Recorded>;
  readonly set: (...args: Recorded) => void;
} => {
  const calls: Array<Recorded> = [];
  return { calls, set: (name, value, options) => calls.push([name, value, options]) };
};

describe("withNextCookies — parsing a Response's Set-Cookie headers (BEH-EA-189)", () => {
  it("writes nothing into the jar when the response has no Set-Cookie header", () => {
    const jar = recordingJar();
    withNextCookies(new Response(null), jar);
    assert.deepStrictEqual(jar.calls, []);
  });

  it("translates one Set-Cookie header's name, value, and attributes", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie": "session=abc123; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Strict",
      },
    });
    const jar = recordingJar();
    withNextCookies(response, jar);
    assert.strictEqual(jar.calls.length, 1);
    const [name, value, options] = jar.calls[0]!;
    assert.strictEqual(name, "session");
    assert.strictEqual(value, "abc123");
    assert.deepStrictEqual(options, {
      maxAge: 3600,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
  });

  it("writes every Set-Cookie header on a response carrying more than one", () => {
    const response = new Response(null);
    response.headers.append("Set-Cookie", "a=1; Path=/");
    response.headers.append("Set-Cookie", "b=2; Path=/");
    const jar = recordingJar();
    withNextCookies(response, jar);
    assert.deepStrictEqual(jar.calls.map(([name, value]) => [name, value]).sort(), [
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("degrades unknown attributes silently, keeping the known ones", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "session=abc123; Path=/; SomeFutureAttribute=whatever" },
    });
    const jar = recordingJar();
    withNextCookies(response, jar);
    const [, , options] = jar.calls[0]!;
    assert.deepStrictEqual(options, { path: "/" });
  });
});

describe("withNextCookies — a real HTTP response (BEH-EA-189)", () => {
  const LoginGroup = HttpApiGroup.make("login").add(
    HttpApiEndpoint.post("login", "/login", { success: Schema.Void }),
  );
  const LoginApi = HttpApi.make("with-next-cookies-test-login").add(LoginGroup);

  const LoginHandlers = HttpApiBuilder.group(LoginApi, "login", (handlers) =>
    handlers.handleAll({
      login: Effect.fnUntraced(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const user = yield* users
          .create({ email: "with-next-cookies@example.com", name: "Cookie Test" })
          .pipe(Effect.orDie);
        const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
      }),
    }),
  );

  const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
    Layer.provideMerge(FileSystem.layerNoop({})),
  );
  const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
    Layer.provideMerge(NodeCrypto.layer),
  );
  const AppLayer = AuthHttp.routes(LoginApi, {}).pipe(
    Layer.provide(LoginHandlers),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

  it.effect(
    "harvests the real session cookie a sign-in-shaped call through the composed router produces",
    () =>
      Effect.gen(function* () {
        const { handler } = HttpRouter.toWebHandler(AppLayer);
        const response = yield* Effect.promise(() =>
          handler(new Request("http://localhost/login", { method: "POST" })),
        );
        const jar = recordingJar();
        withNextCookies(response, jar);
        assert.strictEqual(jar.calls.length, 1);
        const [name, , options] = jar.calls[0]!;
        assert.strictEqual(name, Api.SessionCookie.key);
        assert.strictEqual(options?.secure, true);
        assert.strictEqual(options?.httpOnly, true);
        assert.strictEqual(options?.sameSite, "strict");
        assert.strictEqual(options?.path, "/");
      }),
  );
});
