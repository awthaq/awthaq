// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189.
//
// Two layers of proof: a pure-parsing suite against synthetic `Response`
// objects (no HTTP router needed — this is what actually exercises the
// `Set-Cookie` attribute translation), and one integration test proving
// `applyResponseCookies` works against a *real* `Response` produced by
// dispatching a request through a composed router whose handler calls
// `HttpApiBuilder.securitySetCookie` — the same `LoginGroup`/`LoginHandlers`
// pattern `packages/qadi/test/SubjectApi.test.ts` already established for
// "mint a real session over HTTP."
//
// There is no test here for "wrapping a plain domain-service call produces
// no cookies": `applyResponseCookies` takes a `Response`, and a domain service
// (`Users.rename`, `Sessions.issue` called directly) returns plain data, not
// a `Response` — the type system already makes that misuse impossible to
// even attempt, a stronger guarantee than a runtime assertion could give.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, SessionCookie, Sessions, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { applyResponseCookies } from "../src/CookieJar.ts";
import type { CookieJarLike, CookieSetOptions } from "../src/CookieJar.ts";

type Recorded = readonly [name: string, value: string, options: CookieSetOptions | undefined];

const recordingJar = (): {
  readonly calls: Array<Recorded>;
  readonly set: (...args: Recorded) => void;
} => {
  const calls: Array<Recorded> = [];
  return { calls, set: (name, value, options) => calls.push([name, value, options]) };
};

describe("applyResponseCookies — parsing a Response's Set-Cookie headers (BEH-EA-189)", () => {
  it("writes nothing into the jar when the response has no Set-Cookie header", () => {
    const jar = recordingJar();
    applyResponseCookies(new Response(null), jar);
    assert.deepStrictEqual(jar.calls, []);
  });

  it("translates one Set-Cookie header's name, value, and attributes", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie": "session=abc123; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Strict",
      },
    });
    const jar = recordingJar();
    applyResponseCookies(response, jar);
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
    applyResponseCookies(response, jar);
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
    applyResponseCookies(response, jar);
    const [, , options] = jar.calls[0]!;
    assert.deepStrictEqual(options, { path: "/" });
  });
});

describe("applyResponseCookies — hostile attribute values and value fidelity (NSA-006)", () => {
  const setFrom = (header: string) => {
    const jar = recordingJar();
    applyResponseCookies(new Response(null, { headers: { "set-cookie": header } }), jar);
    return jar.calls[0]!;
  };

  it("drops a non-numeric Max-Age instead of writing NaN", () => {
    const [, , options] = setFrom("a=1; Max-Age=abc; Path=/");
    assert.deepStrictEqual(options, { path: "/" });
  });

  it("drops an empty Max-Age", () => {
    const [, , options] = setFrom("a=1; Max-Age=; Path=/");
    assert.deepStrictEqual(options, { path: "/" });
  });

  it("keeps Max-Age=0 and negative values, which delete the cookie", () => {
    assert.strictEqual(setFrom("a=1; Max-Age=0")[2]?.maxAge, 0);
    assert.strictEqual(setFrom("a=1; Max-Age=-1")[2]?.maxAge, -1);
  });

  it("drops an unparseable Expires instead of writing an Invalid Date", () => {
    const [, , options] = setFrom("a=1; Expires=garbage; Path=/");
    assert.deepStrictEqual(options, { path: "/" });
  });

  it("keeps a valid Expires", () => {
    const [, , options] = setFrom("a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT");
    assert.strictEqual(options?.expires?.toISOString(), "2015-10-21T07:28:00.000Z");
  });

  it("a percent-encoded value reaches the wire unchanged once Next re-encodes it", () => {
    // Next's `ResponseCookies.set` writes `encodeURIComponent(value)`.
    const wire = "tok%3Den%20with%2Fchars";
    const [, value] = setFrom(`session=${wire}; Path=/`);
    assert.strictEqual(encodeURIComponent(value), wire);
  });
});

// BO-010: the shapes a second and third adapter hands `applyResponseCookies`.
// SvelteKit's `Cookies.set` (`@sveltejs/kit`'s `Cookies` interface) *requires*
// `path`, and Astro's `AstroCookies.set` widens the value. Declared here as
// function-typed properties (strict parameter contravariance, not method
// bivariance), so the assignments below are a compile-time proof that
// `CookieJarLike` fits them.
interface SvelteKitCookieSerializeOptions {
  readonly domain?: string | undefined;
  readonly expires?: Date | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly maxAge?: number | undefined;
  readonly partitioned?: boolean | undefined;
  readonly sameSite?: boolean | "lax" | "strict" | "none" | undefined;
  readonly secure?: boolean | undefined;
}

interface SvelteKitCookies {
  readonly set: (
    name: string,
    value: string,
    opts: SvelteKitCookieSerializeOptions & { readonly path: string },
  ) => void;
}

interface AstroCookies {
  readonly set: (
    key: string,
    value: string | number | boolean | object,
    options?: {
      readonly domain?: string;
      readonly expires?: Date;
      readonly httpOnly?: boolean;
      readonly maxAge?: number;
      readonly path?: string;
      readonly sameSite?: boolean | "lax" | "strict" | "none";
      readonly secure?: boolean;
    },
  ) => void;
}

describe("CookieJarLike — second-adapter fit (BO-010)", () => {
  it("a SvelteKit-shaped jar (path required) is accepted, and every cookie arrives with a path", () => {
    const written: Array<readonly [string, string, string]> = [];
    const svelteKit: SvelteKitCookies = {
      set: (name, value, opts) => {
        written.push([name, value, opts.path]);
      },
    };
    const jar: CookieJarLike = svelteKit;
    // A `Set-Cookie` with no `Path` attribute still lands with `path: "/"`.
    applyResponseCookies(new Response(null, { headers: { "set-cookie": "a=1; HttpOnly" } }), jar);
    applyResponseCookies(new Response(null, { headers: { "set-cookie": "b=2; Path=/app" } }), jar);
    assert.deepStrictEqual(written, [
      ["a", "1", "/"],
      ["b", "2", "/app"],
    ]);
  });

  it("an Astro-shaped jar (path optional, wider value) is accepted too", () => {
    const written: Array<string> = [];
    const astro: AstroCookies = { set: (key) => void written.push(key) };
    const jar: CookieJarLike = astro;
    applyResponseCookies(new Response(null, { headers: { "set-cookie": "c=3; Path=/" } }), jar);
    assert.deepStrictEqual(written, ["c"]);
  });
});

describe("applyResponseCookies — a real HTTP response (BEH-EA-189)", () => {
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
          .create({
            identity: { _tag: "Email", email: "with-next-cookies@example.com" },
            name: "Cookie Test",
          })
          .pipe(Effect.orDie);
        const { token, session } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* SessionCookie.set(session, token);
      }),
    }),
  );

  const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
    Layer.provideMerge(FileSystem.layerNoop({})),
  );
  const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
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
        applyResponseCookies(response, jar);
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
