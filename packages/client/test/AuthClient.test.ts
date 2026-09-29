// spec/behaviors/22-client-effect.md, BEH-EA-169, BEH-EA-174, BEH-EA-176.
//
// `CsrfClientLive` (BEH-EA-170) and its cold-start bootstrap (CDS-007) are
// tested in `Csrf.test.ts`; `readCookie`'s own logic (what `CsrfClientLive`
// actually reads) is tested directly below.
import * as DateTime from "effect/DateTime";
import { Api, SessionContract } from "@awthaq/api";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as AuthClient from "../src/AuthClient.ts";

describe("AuthClient re-exports (BEH-EA-169/173)", () => {
  it("make/makeWith/group/endpoint/urlBuilder are the real HttpApiClient functions, not reimplementations", () => {
    assert.strictEqual(AuthClient.make, HttpApiClient.make);
    assert.strictEqual(AuthClient.makeWith, HttpApiClient.makeWith);
    assert.strictEqual(AuthClient.group, HttpApiClient.group);
    assert.strictEqual(AuthClient.endpoint, HttpApiClient.endpoint);
    assert.strictEqual(AuthClient.urlBuilder, HttpApiClient.urlBuilder);
  });
});

describe("readCookie (BEH-EA-170)", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  it("returns undefined with no global document at all", () => {
    assert.isUndefined(AuthClient.readCookie("__Host-csrf"));
  });

  it("returns undefined when the named cookie is absent", () => {
    Reflect.set(globalThis, "document", { cookie: "other=value" });
    assert.isUndefined(AuthClient.readCookie("__Host-csrf"));
  });

  it("returns the matching cookie's value among several", () => {
    Reflect.set(globalThis, "document", { cookie: "a=1; __Host-csrf=secret-token; b=2" });
    assert.strictEqual(AuthClient.readCookie("__Host-csrf"), "secret-token");
  });

  it("URL-decodes the cookie value", () => {
    Reflect.set(globalThis, "document", { cookie: `__Host-csrf=${encodeURIComponent("a b/c")}` });
    assert.strictEqual(AuthClient.readCookie("__Host-csrf"), "a b/c");
  });
});

const session = (id: string): AuthClient.Session =>
  new SessionContract.SessionDto({
    id,
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    lastActiveAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
    userAgent: null,
    current: true,
  });

describe("SessionStore (BEH-EA-174)", () => {
  it.effect("get() reflects nothing until set or hydrated", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.SessionStore;
      const initial = yield* store.get;
      assert.isTrue(Option.isNone(initial));
    }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
  );

  it.effect("set() always overwrites", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.SessionStore;
      yield* store.set(session("s-1"));
      yield* store.set(session("s-2"));
      const current = yield* store.get;
      assert.strictEqual(current.pipe(Option.getOrThrow).id, "s-2");
    }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
  );

  it.effect("hydrate() only takes effect the first time — first non-null wins", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.SessionStore;
      yield* store.hydrate(session("ssr-seeded"));
      yield* store.hydrate(session("a-later-hydrate-call"));
      const current = yield* store.get;
      assert.strictEqual(current.pipe(Option.getOrThrow).id, "ssr-seeded");
    }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
  );

  it.effect("a hydrate() after a real set() is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.SessionStore;
      yield* store.set(session("from-a-real-fetch"));
      yield* store.hydrate(session("ssr-seeded"));
      const current = yield* store.get;
      assert.strictEqual(current.pipe(Option.getOrThrow).id, "from-a-real-fetch");
    }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
  );

  it.effect("set(null) clears the store", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.SessionStore;
      yield* store.set(session("s-1"));
      yield* store.set(null);
      const current = yield* store.get;
      assert.isTrue(Option.isNone(current));
    }).pipe(Effect.provide(AuthClient.SessionStoreLive)),
  );
});

class BoomFailure extends Data.TaggedError("BoomFailure")<{ readonly reason: string }> {}

describe("toPromiseFacade (BEH-EA-176)", () => {
  it("wraps a nested client's methods, resolving the same Effect a caller would run", async () => {
    const fakeClient = {
      password: {
        signIn: (input: { readonly email: string }) => Effect.succeed({ userId: input.email }),
      },
      version: "1.0.0",
    };
    const facade = AuthClient.toPromiseFacade(fakeClient);
    const result = await facade.password.signIn({ email: "a@example.com" });
    assert.deepStrictEqual(result, { userId: "a@example.com" });
    assert.strictEqual(facade.version, "1.0.0");
  });

  it("a failing Effect rejects the Promise with the same typed error", async () => {
    const fakeClient = {
      password: {
        signIn: () => Effect.fail(new BoomFailure({ reason: "wrong password" })),
      },
    };
    const facade = AuthClient.toPromiseFacade(fakeClient);
    await facade.password.signIn().then(
      () => assert.fail("expected the promise to reject"),
      (error) => assert.instanceOf(error, BoomFailure),
    );
  });
});

class OtherFailure extends Data.TaggedError("OtherFailure")<{ readonly code: number }> {}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

describe("toPromiseFacade result mode (EHA-005)", () => {
  const fakeClient = {
    password: {
      signIn: (input: { readonly email: string }) =>
        input.email === "boom@example.com"
          ? Effect.fail(new BoomFailure({ reason: "wrong password" }))
          : input.email === "other@example.com"
            ? Effect.fail(new OtherFailure({ code: 7 }))
            : Effect.succeed({ userId: input.email }),
    },
    version: "1.0.0",
  };

  it("resolves a Success carrying the value", async () => {
    const facade = AuthClient.toPromiseFacade(fakeClient, { mode: "result" });
    const result = await facade.password.signIn({ email: "a@example.com" });
    assert.isTrue(Result.isSuccess(result));
    assert.deepStrictEqual(Result.isSuccess(result) ? result.success : undefined, {
      userId: "a@example.com",
    });
    assert.strictEqual(facade.version, "1.0.0");
  });

  it("resolves a Failure carrying the typed contract error instead of rejecting", async () => {
    const facade = AuthClient.toPromiseFacade(fakeClient, { mode: "result" });
    const result = await facade.password.signIn({ email: "boom@example.com" });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      // Exhaustive over the error union: adding a variant breaks this switch at compile time.
      switch (result.failure._tag) {
        case "BoomFailure":
          assert.strictEqual(result.failure.reason, "wrong password");
          break;
        case "OtherFailure":
          assert.fail("unexpected variant");
      }
    }
  });

  it("the failure type is exactly the endpoint's error union", () => {
    const facade = AuthClient.toPromiseFacade(fakeClient, { mode: "result" });
    type Resolved = Awaited<ReturnType<typeof facade.password.signIn>>;
    type Failure = Resolved extends Result.Result<infer _A, infer E> ? E : never;
    const check: Expect<Equal<Failure, BoomFailure | OtherFailure>> = true;
    assert.isTrue(check);
  });

  it("the default mode still rejects (BEH-EA-176 unchanged)", async () => {
    const facade = AuthClient.toPromiseFacade(fakeClient);
    await facade.password.signIn({ email: "other@example.com" }).then(
      () => assert.fail("expected the promise to reject"),
      (error) => assert.instanceOf(error, OtherFailure),
    );
  });
});

// MNA-005/PIL-005: a bearer client survives unlimited server-side rotations
// with no code of its own beyond wiring the shipped transform.
describe("bearerTransformClient (MNA-005)", () => {
  const BearerApi = HttpApi.make("bearer").add(
    HttpApiGroup.make("g").add(HttpApiEndpoint.get("ping", "/ping", { success: Schema.String })),
  );

  // A fake transport: records the Authorization header it was sent and
  // answers with the queued response headers.
  const fakeTransport = (
    seen: Array<string | undefined>,
    responseHeaders: ReadonlyArray<Record<string, string>>,
  ) => {
    let call = 0;
    return HttpClient.make((request) => {
      seen.push(request.headers["authorization"]);
      const headers = { "content-type": "application/json", ...responseHeaders[call++] };
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify("pong"), { status: 200, headers }),
        ),
      );
    });
  };

  const run = (
    store: AuthClient.BearerTokenStoreShape,
    transport: HttpClient.HttpClient,
    calls: number,
  ) =>
    Effect.gen(function* () {
      const client = yield* AuthClient.make(BearerApi, {
        baseUrl: "http://localhost",
        transformClient: AuthClient.bearerTransformClient(store),
      });
      for (let i = 0; i < calls; i++) yield* client.g.ping();
    }).pipe(Effect.provideService(HttpClient.HttpClient, transport));

  it.effect("persists set-auth-token from a response and sends it on the next request", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.BearerTokenStore;
      yield* store.set(Redacted.make("token-0"));
      const seen: Array<string | undefined> = [];
      yield* run(
        store,
        fakeTransport(seen, [
          { [Api.ROTATED_TOKEN_HEADER]: "token-1" },
          { [Api.ROTATED_TOKEN_HEADER]: "token-2" },
          {},
        ]),
        3,
      );
      assert.deepStrictEqual(seen, ["Bearer token-0", "Bearer token-1", "Bearer token-2"]);
      assert.strictEqual(Option.getOrThrow(yield* store.get).pipe(Redacted.value), "token-2");
    }).pipe(Effect.provide(AuthClient.BearerTokenStoreMemory)),
  );

  it.effect("a response without the header leaves the stored token unchanged", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.BearerTokenStore;
      yield* store.set(Redacted.make("token-0"));
      const seen: Array<string | undefined> = [];
      yield* run(store, fakeTransport(seen, [{}, {}]), 2);
      assert.deepStrictEqual(seen, ["Bearer token-0", "Bearer token-0"]);
      assert.strictEqual(Option.getOrThrow(yield* store.get).pipe(Redacted.value), "token-0");
    }).pipe(Effect.provide(AuthClient.BearerTokenStoreMemory)),
  );

  it.effect("sends no Authorization header while the store is empty", () =>
    Effect.gen(function* () {
      const store = yield* AuthClient.BearerTokenStore;
      const seen: Array<string | undefined> = [];
      yield* run(store, fakeTransport(seen, [{ [Api.ROTATED_TOKEN_HEADER]: "fresh" }, {}]), 2);
      assert.deepStrictEqual(seen, [undefined, "Bearer fresh"]);
    }).pipe(Effect.provide(AuthClient.BearerTokenStoreMemory)),
  );
});
