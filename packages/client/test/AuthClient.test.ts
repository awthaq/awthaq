// spec/behaviors/22-client-effect.md, BEH-EA-169, BEH-EA-174, BEH-EA-176.
//
// `CsrfClientLive` (BEH-EA-170) has no dedicated behavioral test here — see
// `AuthClient.ts`'s own header comment: no plugin group in this repository
// declares `.middleware(Api.CsrfProtection)` yet, so there is no real,
// generated client to exercise it against. `readCookie`'s own logic (what
// `CsrfClientLive` actually reads) is tested directly below instead.
import { SessionContract } from "@awthaq/api";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AuthClient } from "../src/index.ts";

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
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
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
