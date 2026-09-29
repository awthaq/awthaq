// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Authentication from "../src/Authentication.ts";

// `HttpApiTest.groups` needs these platform services regardless of which
// middleware is under test — the same bundle effect's own HttpApiBuilder
// test suite provides for every test exercising it.
const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

// Endpoints declare `cookie`/`authorization` as ordinary request headers so
// the test client can set the exact same raw HTTP headers `Authentication`'s
// `security` scheme independently reads off the request (BEH-EA-065/066) —
// the same technique effect's own HttpApiBuilder test suite uses to drive a
// security-scheme credential through a typed client call. Setting a header
// literally named `cookie` really does set the wire-level `Cookie` header,
// which `HttpServerRequest` parses into `request.cookies` regardless of
// which endpoint schema field happened to carry it.
const RequestHeaders = {
  cookie: Schema.optional(Schema.String),
  authorization: Schema.optional(Schema.String),
};

const TestApi = HttpApi.make("test")
  .add(
    HttpApiGroup.make("required")
      .add(
        HttpApiEndpoint.get("whoAmI", "/who-am-i", {
          headers: RequestHeaders,
          success: Schema.String,
        }),
      )
      .add(
        HttpApiEndpoint.get("whoIsActingAs", "/who-is-acting-as", {
          headers: RequestHeaders,
          success: Schema.NullOr(Schema.String),
        }),
      )
      .middleware(Api.Authentication),
  )
  .add(
    HttpApiGroup.make("optional")
      .add(
        HttpApiEndpoint.get("whoAmI", "/who-am-i-optional", {
          headers: RequestHeaders,
          success: Schema.String,
        }),
      )
      .middleware(Api.OptionalAuthentication),
  );

const whoAmI = () =>
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    return principal._tag === "User" ? principal.ref.id : principal._tag;
  });

const whoIsActingAs = () =>
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    return principal._tag === "User" && principal.actingAs !== undefined
      ? principal.actingAs.id
      : null;
  });

const RequiredLayer = HttpApiBuilder.group(TestApi, "required", (handlers) =>
  handlers.handle("whoAmI", whoAmI).handle("whoIsActingAs", whoIsActingAs),
);

const OptionalLayer = HttpApiBuilder.group(TestApi, "optional", (handlers) =>
  handlers.handle("whoAmI", whoAmI),
);

const TestLayer = Layer.mergeAll(RequiredLayer, OptionalLayer).pipe(
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provideMerge(Authentication.OptionalAuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(Sessions.layerMemory),
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
);

const userId = Users.UserId("33333333-3333-3333-3333-333333333333");

// NHS-002/EEM-003: simulates a backing-store outage — `verify` fails with
// the same `PlatformError` a real `Sessions.layerSql` would report on a
// database failure, distinct from `SessionNotFound`/`SessionExpired`.
const outage = PlatformError.systemError({
  _tag: "Unknown",
  module: "Sessions",
  method: "verify",
  description: "simulated backing-store outage",
});

const UnreliableSessions: Layer.Layer<Sessions.Sessions> = Layer.succeed(Sessions.Sessions, {
  issue: () => Effect.die("not used in this test"),
  verify: () => Effect.fail(outage),
  revoke: () => Effect.die("not used in this test"),
  revokeOwned: () => Effect.die("not used in this test"),
  revokeOthers: () => Effect.die("not used in this test"),
  revokeAll: () => Effect.die("not used in this test"),
  list: () => Effect.die("not used in this test"),
  findOwned: () => Effect.die("not used in this test"),
  isLive: () => Effect.die("not used in this test"),
  reauthenticate: () => Effect.die("not used in this test"),
});

describe("Authentication", () => {
  it.effect("BEH-EA-067: fails Unauthenticated when neither cookie nor bearer resolves", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const failure = yield* client.required.whoAmI({ headers: {} }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Unauthenticated");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-065: a valid session cookie resolves CurrentPrincipal as the session's own user",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        const result = yield* client.required.whoAmI({
          headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
        });
        assert.strictEqual(result, userId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-066: a valid bearer token resolves the same UserPrincipal a cookie would", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoAmI({
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      });
      assert.strictEqual(result, userId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-065/072: cookie is tried before bearer — an invalid bearer doesn't stop a valid cookie",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        const result = yield* client.required.whoAmI({
          headers: {
            cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
            authorization: "Bearer garbage",
          },
        });
        assert.strictEqual(result, userId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-068/029: OptionalAuthentication resolves Anonymous instead of failing", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.optional.whoAmI({ headers: {} });
      assert.strictEqual(result, "Anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-068: OptionalAuthentication still resolves a real principal from a valid bearer token",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        const result = yield* client.optional.whoAmI({
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        });
        assert.strictEqual(result, userId);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-211: a session issued with actingAs resolves to a UserPrincipal carrying the identical actingAs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({
          userId,
          actingAs: { type: "user", id: "admin-1" },
        });
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        const result = yield* client.required.whoIsActingAs({
          headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
        });
        assert.strictEqual(result, "admin-1");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an ordinary session (no actingAs) resolves to a UserPrincipal with no actingAs", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoIsActingAs({
        headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
      });
      assert.strictEqual(result, null);
    }).pipe(Effect.provide(TestLayer)),
  );

  // .scratch/jwt/issues/16-automatic-response-mirroring.md: `PostAuthResponseHook`
  // defaults to a no-op (every test above already proves this — none of
  // them override it, and all pass unchanged). This is the one test
  // proving a tapped override is actually consulted, with the correctly-
  // resolved principal, and that its result is what the request ultimately
  // returns — the mechanism `@awthaq/jwt` builds on, exercised here
  // with no knowledge of that plugin at all.
  it.effect("a tapped PostAuthResponseHook is consulted with the resolved principal", () => {
    const seen = Effect.runSync(Ref.make<Option.Option<string>>(Option.none()));
    const TappedHook = Layer.succeed(Authentication.PostAuthResponseHook, {
      decorate: (principal: Api.Principal, response: HttpServerResponse.HttpServerResponse) =>
        Ref.set(
          seen,
          Option.some(principal._tag === "User" ? principal.ref.id : principal._tag),
        ).pipe(Effect.as(HttpServerResponse.setHeader(response, "x-tapped", "yes"))),
    });
    return Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoAmI({
        headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
      });
      assert.strictEqual(result, userId);
      assert.deepStrictEqual(yield* Ref.get(seen), Option.some(userId));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RequiredLayer, OptionalLayer).pipe(
          Layer.provideMerge(Authentication.AuthenticationLive),
          Layer.provideMerge(Authentication.OptionalAuthenticationLive),
          Layer.provide(Authentication.PrincipalResolverLive),
          Layer.provide(TappedHook),
          Layer.provideMerge(Sessions.layerMemory),
          // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layerMemory),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });

  // Spec-fidelity fix: `.scratch/jwt/spec.md`'s own "Automatic response
  // mirroring" decision consults `PostAuthResponseHook` only "immediately
  // after a successful `resolvePrincipal`" — the anonymous principal
  // `OptionalAuthenticationLive`'s `bearer` branch falls back to on a
  // missing/invalid credential is a *recovery* from failure, not a success,
  // and must never reach the hook (an unauthenticated caller must never be
  // handed a decorated response, e.g. a `@awthaq/jwt`-minted token
  // asserting "anonymous" identity).
  it.effect("a tapped PostAuthResponseHook is NOT consulted for the anonymous fallback", () => {
    const seen = Effect.runSync(Ref.make<Option.Option<string>>(Option.none()));
    const TappedHook = Layer.succeed(Authentication.PostAuthResponseHook, {
      decorate: (principal: Api.Principal, response: HttpServerResponse.HttpServerResponse) =>
        Ref.set(
          seen,
          Option.some(principal._tag === "User" ? principal.ref.id : principal._tag),
        ).pipe(Effect.as(HttpServerResponse.setHeader(response, "x-tapped", "yes"))),
    });
    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.optional.whoAmI({ headers: {} });
      assert.strictEqual(result, "Anonymous");
      assert.deepStrictEqual(yield* Ref.get(seen), Option.none());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RequiredLayer, OptionalLayer).pipe(
          Layer.provideMerge(Authentication.AuthenticationLive),
          Layer.provideMerge(Authentication.OptionalAuthenticationLive),
          Layer.provide(Authentication.PrincipalResolverLive),
          Layer.provide(TappedHook),
          Layer.provideMerge(Sessions.layerMemory),
          // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layerMemory),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });

  // NHS-002/EEM-003: `resolveSession` used to blanket-map every `verify`
  // failure — including a `PlatformError` backing-store outage — to
  // `Api.Unauthenticated`, so a database outage answered 401 on every
  // request, indistinguishable from a bad credential. `Effect.exit` (not
  // `Effect.flip`) is required here: the fix turns `PlatformError` into an
  // unhandled defect via `Effect.orDie`, which `flip` cannot observe (it
  // only flips a typed failure) but `exit` captures as `Cause.isDie`.
  it.effect(
    "resolveSession dies (does not fail Unauthenticated) when the session store is unreachable",
    () =>
      Effect.gen(function* () {
        const request = HttpServerRequest.fromWeb(new Request("http://localhost/whatever"));
        const exit = yield* Authentication.resolveSession(
          yield* Sessions.Sessions,
          Redacted.make("some-id.some-secret"),
          "cookie",
        ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.isTrue(Cause.hasDies(exit.cause));
        assert.isFalse(Cause.hasFails(exit.cause));
      }).pipe(Effect.provide(UnreliableSessions)),
  );
});

// PIL-005/TS-003/NHS-006/MAPS-008: real serving path. Pre-response handlers
// only run under `HttpEffect.toHandled`, so these tests drive the router the
// way a real server does and inspect the response actually written.
class Boom extends Schema.TaggedError<Boom>()("Boom", {}, { httpApiStatus: 404 }) {}

const RotationApi = HttpApi.make("rotation").add(
  HttpApiGroup.make("g")
    .add(HttpApiEndpoint.get("ok", "/ok", { success: Schema.String }))
    .add(HttpApiEndpoint.get("boom", "/boom", { success: Schema.String, error: Boom }))
    .middleware(Api.Authentication),
);

const RotationHandlers = HttpApiBuilder.group(RotationApi, "g", (handlers) =>
  handlers.handle("ok", () => Effect.succeed("ok")).handle("boom", () => Effect.fail(new Boom())),
);

const RotationLayer = HttpApiBuilder.layer(RotationApi).pipe(
  Layer.provide(RotationHandlers),
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(Sessions.layerMemory),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const serve = (path: string, headers: Record<string, string>) =>
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
        HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, { headers })),
      ),
    );
    if (written === undefined) return yield* Effect.die("no response was written");
    return written;
  });

const cookieOf = (response: HttpServerResponse.HttpServerResponse) =>
  Cookies.getValue(response.cookies, Sessions.SESSION_COOKIE_NAME);

describe("Authentication rotation delivery (PIL-005)", () => {
  it.effect(
    "a handler failing with a typed error after a rotating verify still carries the rotated cookie",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.hours(2));
          const response = yield* serve("/boom", {
            cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
          });
          assert.strictEqual(response.status, 404);
          const rotated = cookieOf(response);
          assert.isTrue(Option.isSome(rotated));
          if (Option.isNone(rotated)) return;
          assert.notStrictEqual(rotated.value, Redacted.value(token));
          // The delivered secret is the live one — the old one no longer verifies.
          yield* sessions.verify(Redacted.make(rotated.value));
          assert.strictEqual(response.headers["cache-control"], "no-store");
        }),
      ).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("a successful response carries the rotated cookie exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        yield* TestClock.adjust(Duration.hours(2));
        const response = yield* serve("/ok", {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(Object.keys(response.cookies.cookies).length, 1);
        assert.isTrue(Option.isSome(cookieOf(response)));
      }),
    ).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("bearer rotation sets the rotated-token header and Cache-Control: no-store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        yield* TestClock.adjust(Duration.hours(2));
        const response = yield* serve("/ok", { authorization: `Bearer ${Redacted.value(token)}` });
        assert.strictEqual(response.status, 200);
        const rotated = response.headers[Api.ROTATED_TOKEN_HEADER];
        assert.isDefined(rotated);
        assert.notStrictEqual(rotated, Redacted.value(token));
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.isTrue(Option.isNone(cookieOf(response)));
        yield* sessions.verify(Redacted.make(rotated ?? ""));
      }),
    ).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("no rotation, no delivery: a fresh session's response is left untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* serve("/ok", {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
        });
        assert.isTrue(Option.isNone(cookieOf(response)));
        assert.isUndefined(response.headers["cache-control"]);
      }),
    ).pipe(Effect.provide(RotationLayer)),
  );
});

describe("Authentication per-request cache (TS-003/NHS-006)", () => {
  const countingSessions = (verifies: Ref.Ref<number>): Layer.Layer<Sessions.Sessions> =>
    Layer.succeed(Sessions.Sessions, {
      issue: () => Effect.die("not used in this test"),
      verify: () =>
        Ref.update(verifies, (n) => n + 1).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(10))),
          Effect.andThen(
            Effect.fail(new Sessions.SessionNotFound({ message: "awthaq: no such session" })),
          ),
        ),
      revoke: () => Effect.die("not used in this test"),
      revokeOwned: () => Effect.die("not used in this test"),
      revokeOthers: () => Effect.die("not used in this test"),
      revokeAll: () => Effect.die("not used in this test"),
      list: () => Effect.die("not used in this test"),
      findOwned: () => Effect.die("not used in this test"),
      isLive: () => Effect.die("not used in this test"),
      reauthenticate: () => Effect.die("not used in this test"),
    });

  const sessionsWith = (verifies: Ref.Ref<number>) =>
    Effect.gen(function* () {
      return yield* Sessions.Sessions;
    }).pipe(Effect.provide(countingSessions(verifies)));

  it.effect("two concurrent resolveSession calls for one request call verify exactly once", () =>
    Effect.gen(function* () {
      const verifies = yield* Ref.make(0);
      const sessions = yield* sessionsWith(verifies);
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/x"));
      const credential = Redacted.make("some-id.some-secret");
      const call = Authentication.resolveSession(sessions, credential, "cookie").pipe(Effect.flip);
      const fiber = yield* Effect.all([call, call, call], { concurrency: "unbounded" }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.millis(20));
      yield* Fiber.join(fiber);
      assert.strictEqual(yield* Ref.get(verifies), 1);
    }),
  );

  it.effect("a re-wrapped request (request.modify) shares the original's verification", () =>
    Effect.gen(function* () {
      const verifies = yield* Ref.make(0);
      const sessions = yield* sessionsWith(verifies);
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/x"));
      const prefixed = request.modify({ url: "/y" });
      const credential = Redacted.make("some-id.some-secret");
      const resolve = (r: HttpServerRequest.HttpServerRequest) =>
        Authentication.resolveSession(sessions, credential, "cookie").pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, r),
          Effect.flip,
        );
      const first = yield* resolve(request).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      yield* Fiber.join(first);
      yield* resolve(prefixed);
      assert.strictEqual(yield* Ref.get(verifies), 1);
    }),
  );

  it.effect("an interrupted first resolver does not wedge a second caller", () =>
    Effect.gen(function* () {
      const verifies = yield* Ref.make(0);
      const sessions = yield* sessionsWith(verifies);
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/x"));
      const credential = Redacted.make("some-id.some-secret");
      const resolve = Authentication.resolveSession(sessions, credential, "cookie").pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flip,
      );
      const first = yield* resolve.pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      const second = yield* resolve.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(20));
      const failure = yield* Fiber.join(second);
      assert.strictEqual(failure._tag, "Unauthenticated");
      assert.strictEqual(yield* Ref.get(verifies), 2);
    }),
  );
});
