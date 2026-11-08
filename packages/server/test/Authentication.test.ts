// Hand-wired on purpose: the authentication middleware is the unit under test; what the suites repeat (resolver, CSRF config and protection, token mint) lives in `test/support/Wiring.ts` (plan 08 exemption).
// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
import {
  AuditLog,
  AuthEvents,
  Errors,
  Hooks,
  Persistence,
  SessionCookie,
  Sessions,
  Users,
} from "@awthaq/core";
import { Api, SessionLifecycle } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Authentication from "../src/Authentication.ts";
import * as Credentials from "../src/Credentials.ts";
import * as SessionDelivery from "../src/SessionDelivery.ts";
import * as SessionLifecycleLive from "../src/SessionLifecycle.ts";
import * as Wiring from "./support/Wiring.ts";
import {
  headersFor,
  layerFor,
  none,
  rows,
  seed,
  variantOf,
  who,
} from "./support/CredentialTable.ts";

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
  Layer.provide(Wiring.resolver),
  Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
);

const userId = Users.UserId("33333333-3333-3333-3333-333333333333");

// NHS-002/EEM-003/MA-004: simulates a backing-store outage — `verify` fails with
// the typed `StoreUnavailable` a real `Sessions.layerSql` reports on a database
// failure, distinct from `SessionNotFound`/`SessionExpired`.
const outage = new Errors.StoreUnavailable({ operation: "Sessions.verify" });

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
  purgeExpired: () => Effect.die("not used in this test"),
  reauthenticate: () => Effect.die("not used in this test"),
  requireFresh: () => Effect.die("not used in this test"),
});

describe("Authentication", () => {
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
          Layer.provide(Wiring.resolver),
          Layer.provide(TappedHook),
          Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
          // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });

  // PDR-003: a hook can tell a cookie-authenticated request from a bearer one.
  it.effect("PostAuthResponseHook.decorate receives the authenticating scheme", () => {
    const schemes = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
    const TappedHook = Layer.succeed(Authentication.PostAuthResponseHook, {
      decorate: (
        _principal: Api.Principal,
        response: HttpServerResponse.HttpServerResponse,
        context: { readonly scheme: "cookie" | "bearer" | "impersonation" | "apiKey" },
      ) => Ref.update(schemes, (seen) => [...seen, context.scheme]).pipe(Effect.as(response)),
    });
    return Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      yield* client.required.whoAmI({
        headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
      });
      yield* client.required.whoAmI({
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      });
      assert.deepStrictEqual(yield* Ref.get(schemes), ["cookie", "bearer"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RequiredLayer, OptionalLayer).pipe(
          Layer.provideMerge(Authentication.AuthenticationLive),
          Layer.provideMerge(Authentication.OptionalAuthenticationLive),
          Layer.provide(Wiring.resolver),
          Layer.provide(TappedHook),
          Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });

  // Spec-fidelity fix: `.scratch/jwt/spec.md`'s own "Automatic response
  // mirroring" decision consults `PostAuthResponseHook` only "immediately
  // after a successful resolution" — the anonymous principal
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
          Layer.provide(Wiring.resolver),
          Layer.provide(TappedHook),
          Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
          // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
          Layer.provideMerge(AuthEvents.layer),
          Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });
});

// PIL-005/TS-003/NHS-006/MAPS-008: real serving path. Pre-response handlers
// only run under `HttpEffect.toHandled`, so these tests drive the router the
// way a real server does and inspect the response actually written.
class Boom extends Schema.TaggedError<Boom>()("Boom", {}, { httpApiStatus: 404 }) {}

const RotationApi = HttpApi.make("rotation").add(
  HttpApiGroup.make("g")
    .add(HttpApiEndpoint.get("ok", "/ok", { success: Schema.String }))
    .add(HttpApiEndpoint.get("boom", "/boom", { success: Schema.String, error: Boom }))
    // ADR-EA-045: an endpoint that ends the caller's session, behind the same rotating verify.
    .add(HttpApiEndpoint.post("end", "/end").middleware(SessionLifecycle.Ends))
    .middleware(Api.Authentication),
);

const RotationHandlers = HttpApiBuilder.group(RotationApi, "g", (handlers) =>
  handlers
    .handle("ok", () => Effect.succeed("ok"))
    .handle("boom", () => Effect.fail(new Boom()))
    .handle("end", () => SessionDelivery.end),
);

const RotationLayer = HttpApiBuilder.layer(RotationApi).pipe(
  Layer.provide(RotationHandlers),
  Layer.provide(SessionLifecycleLive.EndsLive),
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provide(Wiring.resolver),
  Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

// MA-004: the same route served over a session store that is down.
const OutageLayer = HttpApiBuilder.layer(RotationApi).pipe(
  Layer.provide(RotationHandlers),
  Layer.provide(SessionLifecycleLive.EndsLive),
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provide(Wiring.resolver),
  Layer.provideMerge(UnreliableSessions),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const serve = (path: string, headers: Record<string, string>, method = "GET") =>
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
        HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, { method, headers })),
      ),
    );
    if (written === undefined) return yield* Effect.die("no response was written");
    return written;
  });

const cookieOf = (response: HttpServerResponse.HttpServerResponse) =>
  Cookies.getValue(response.cookies, Sessions.SESSION_COOKIE_NAME);

// IC-007/BO-005/AGA-004: the rotated cookie is rendered through the shared
// `SessionCookie` config — recomputed Max-Age, mode attributes, configured name.
const rotationLayerWith = (cookieConfig: Layer.Layer<never>) =>
  HttpApiBuilder.layer(RotationApi).pipe(
    Layer.provide(RotationHandlers),
    Layer.provide(SessionLifecycleLive.EndsLive),
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provide(Wiring.resolver),
    Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(cookieConfig),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

describe("MA-004: a session-store outage answers 503", () => {
  it.effect(
    "an authenticated route with a cookie answers 503 StoreUnavailable, not 401 or 500",
    () =>
      Effect.gen(function* () {
        const response = yield* serve("/ok", {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=some-id.some-secret`,
        });
        assert.strictEqual(response.status, 503);
      }).pipe(Effect.provide(OutageLayer)),
  );
});

describe("Session cookie policy on rotation (IC-007, BO-005, AGA-004)", () => {
  it.effect(
    "BO-005: a rotated cookie's Max-Age is recomputed from the remaining absolute lifetime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.hours(2));
          const response = yield* serve("/ok", {
            cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
          });
          const cookie = Cookies.get(response.cookies, Sessions.SESSION_COOKIE_NAME);
          assert.isTrue(Option.isSome(cookie));
          if (Option.isNone(cookie)) return;
          assert.deepStrictEqual(
            cookie.value.options?.maxAge,
            Duration.subtract(Duration.days(30), Duration.hours(2)),
          );
          assert.strictEqual(cookie.value.options?.sameSite, "strict");
        }),
      ).pipe(Effect.provide(RotationLayer)),
  );

  it.effect("AGA-004: HostEmbedded rotates __Host-session with SameSite=None; Partitioned", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        yield* TestClock.adjust(Duration.hours(2));
        const response = yield* serve("/ok", {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
        });
        const cookie = Cookies.get(response.cookies, "__Host-session");
        assert.isTrue(Option.isSome(cookie));
        if (Option.isNone(cookie)) return;
        assert.strictEqual(cookie.value.options?.sameSite, "none");
        assert.isTrue(cookie.value.options?.partitioned);
        assert.isTrue(cookie.value.options?.secure);
      }),
    ).pipe(
      Effect.provide(rotationLayerWith(SessionCookie.config({ mode: SessionCookie.HostEmbedded }))),
    ),
  );

  it.effect("IC-007: SecureDomain reads and rotates __Secure-session with the Domain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        // Presented under the configured name, the session resolves...
        const ok = yield* serve("/ok", { cookie: `__Secure-session=${Redacted.value(token)}` });
        assert.strictEqual(ok.status, 200);
        // ...and the default name is no longer read.
        const wrongName = yield* serve("/ok", {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
        });
        assert.strictEqual(wrongName.status, 401);
        yield* TestClock.adjust(Duration.hours(2));
        const rotated = yield* serve("/ok", {
          cookie: `__Secure-session=${Redacted.value(token)}`,
        });
        const cookie = Cookies.get(rotated.cookies, "__Secure-session");
        assert.isTrue(Option.isSome(cookie));
        if (Option.isNone(cookie)) return;
        assert.strictEqual(cookie.value.options?.domain, "example.com");
        assert.strictEqual(cookie.value.options?.sameSite, "lax");
      }),
    ).pipe(
      Effect.provide(
        rotationLayerWith(
          SessionCookie.config({
            mode: SessionCookie.SecureDomain({ domain: "example.com", sameSite: "lax" }),
          }),
        ),
      ),
    ),
  );
});

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

  // ADR-EA-045: a request whose verify rotated and which then ends the session must not hand the client the
  // secret of the session it just revoked; it says the session ended instead.
  it.effect(
    "a bearer sign-out after a verify-time rotation drops set-auth-token and says the session ended",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const { token } = yield* sessions.issue({ userId });
          yield* TestClock.adjust(Duration.hours(2));
          const response = yield* serve(
            "/end",
            {
              authorization: `Bearer ${Redacted.value(token)}`,
            },
            "POST",
          );
          assert.strictEqual(response.status, 204);
          assert.isUndefined(response.headers[Api.ROTATED_TOKEN_HEADER]);
          assert.strictEqual(response.headers[Api.SESSION_ENDED_HEADER], "1");
          assert.strictEqual(response.headers["cache-control"], "no-store");
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

// EHA-006/NHS-010: the contract and the wire.
describe("Authentication contract (EHA-006, NHS-010)", () => {
  it("EHA-006: the OpenAPI document lists a 401 for Authentication endpoints but none for OptionalAuthentication", () => {
    const spec = OpenApi.fromApi(TestApi);
    const required = spec.paths["/who-am-i"]?.get?.responses ?? {};
    const optional = spec.paths["/who-am-i-optional"]?.get?.responses ?? {};
    assert.property(required, "401");
    assert.notProperty(optional, "401");
  });
});

describe("Authentication challenges (JR-007)", () => {
  const challengeOf = (path: string, headers: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* serve(path, headers);
        return { status: response.status, challenge: response.headers["www-authenticate"] };
      }),
    ).pipe(Effect.provide(RotationLayer));

  it.effect("no credential: 401 with the realm challenge", () =>
    Effect.gen(function* () {
      const result = yield* challengeOf("/ok", {});
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.challenge, 'Bearer realm="awthaq"');
    }),
  );

  it.effect("an invalid bearer: 401 with error=invalid_token", () =>
    Effect.gen(function* () {
      const result = yield* challengeOf("/ok", { authorization: "Bearer not-a-real-token" });
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.challenge, 'Bearer realm="awthaq", error="invalid_token"');
    }),
  );

  it.effect("an invalid cookie only: 401 with the realm challenge", () =>
    Effect.gen(function* () {
      const result = yield* challengeOf("/ok", {
        cookie: `${Sessions.SESSION_COOKIE_NAME}=garbage`,
      });
      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.challenge, 'Bearer realm="awthaq"');
    }),
  );

  it.effect("a handler's own typed error carries no challenge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* serve("/boom", {
          authorization: `Bearer ${Redacted.value(token)}`,
        });
        assert.strictEqual(response.status, 404);
        assert.isUndefined(response.headers["www-authenticate"]);
      }),
    ).pipe(Effect.provide(RotationLayer)),
  );
});

// APS-007/THS-003: the principal carries how the session was authenticated;
// the opt-in resolver adds emailVerified.
describe("PrincipalResolver amr and user facts (APS-007, THS-003)", () => {
  const factsLayer = Layer.mergeAll(
    Wiring.resolver,
    Sessions.layer.pipe(Layer.provide(Persistence.memory)),
    Users.layer.pipe(Layer.provide(Persistence.memory)),
  ).pipe(
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect(
    "the default resolver copies amr from the session and leaves emailVerified absent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const resolver = yield* Credentials.PrincipalResolver;
        const { session } = yield* sessions.issue({ userId, amr: ["pwd", "otp"] });
        const principal = yield* resolver.resolve(session);
        assert.strictEqual(principal._tag, "User");
        if (principal._tag !== "User") return;
        assert.deepStrictEqual(principal.amr, ["pwd", "otp"]);
        assert.isUndefined(principal.emailVerified);
      }).pipe(Effect.provide(factsLayer)),
  );

  it.effect("layerWithUserFacts sets emailVerified=false for a fresh, unverified user", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const resolver = yield* Credentials.PrincipalResolver;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "facts@example.com" },
        name: "Facts",
      });
      const { session } = yield* sessions.issue({ userId: user.id, amr: ["pwd"] });
      const principal = yield* resolver.resolve(session);
      assert.strictEqual(principal._tag === "User" ? principal.emailVerified : undefined, false);
    }).pipe(
      Effect.provide(
        Credentials.PrincipalResolverWithUserFactsLive.pipe(Layer.provideMerge(factsLayer)),
      ),
    ),
  );

  it.effect(
    "layerWithUserFacts resolves a session whose user vanished as unverified, never a defect",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const resolver = yield* Credentials.PrincipalResolver;
        const { session } = yield* sessions.issue({
          userId: Users.UserId("99999999-9999-9999-9999-999999999999"),
        });
        const principal = yield* resolver.resolve(session);
        assert.strictEqual(principal._tag === "User" ? principal.emailVerified : undefined, false);
      }).pipe(
        Effect.provide(
          Credentials.PrincipalResolverWithUserFactsLive.pipe(Layer.provideMerge(factsLayer)),
        ),
      ),
  );
});

// EOTS-003/MAPS-007 (ticket 27): a rejected credential is observable without leaking
// it, and an authenticated request's trace identifies the principal and session.
describe("Authentication observability", () => {
  const capture = () => {
    const records: Array<{ readonly level: string; readonly text: string }> = [];
    const layer = Layer.mergeAll(
      Logger.layer([
        Logger.make((options) => {
          records.push({
            level: options.logLevel,
            text: JSON.stringify([
              options.message,
              options.fiber.getRef(References.CurrentLogAnnotations),
            ]),
          });
        }),
      ]),
      Layer.succeed(References.MinimumLogLevel, "Debug"),
    );
    return { records, layer };
  };

  const tracing = () => {
    const spans: Array<Tracer.Span> = [];
    const base = Tracer.Tracer.defaultValue();
    const layer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (options) => {
          const span = base.span(options);
          spans.push(span);
          return span;
        },
      }),
    );
    return { spans, layer };
  };

  it.effect(
    "an unknown session cookie logs session.verify.failed with the reason and no credential material",
    () => {
      const logs = capture();
      const secret = "totally-made-up-secret-value";
      return Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        const failure = yield* client.required
          .whoAmI({ headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=sess-unknown.${secret}` } })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Unauthenticated");
        const failed = logs.records.filter((r) => r.text.includes("session.verify.failed"));
        assert.strictEqual(failed.length, 1);
        assert.include(failed[0]?.text ?? "", "Sessions/NotFound");
        assert.include(failed[0]?.text ?? "", '"auth.scheme":"cookie"');
        const everything = logs.records.map((r) => r.text).join("\n");
        assert.notInclude(everything, secret);
        assert.notInclude(everything, "sess-unknown");
      }).pipe(Effect.provide(Layer.merge(TestLayer, logs.layer)));
    },
  );

  it.effect("a request with no credential at all logs nothing about a failed verification", () => {
    const logs = capture();
    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      yield* client.required.whoAmI({ headers: {} }).pipe(Effect.flip);
      assert.isFalse(logs.records.some((r) => r.text.includes("session.verify.failed")));
    }).pipe(Effect.provide(Layer.merge(TestLayer, logs.layer)));
  });

  it.effect(
    "an authenticated request has an awthaq.principal.resolve span naming the principal and session, and no credential",
    () => {
      const trace = tracing();
      return Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
        yield* client.required.whoAmI({
          headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
        });
        const resolves = trace.spans.filter((span) => span.name === "awthaq.principal.resolve");
        assert.isAbove(resolves.length, 0);
        // The principal and session are annotated on whichever span was current when the
        // principal was resolved (the request's span, or this resolution's).
        const annotated = trace.spans.filter(
          (span) => span.attributes.get("auth.principal.ref") === userId,
        );
        assert.isAbove(annotated.length, 0);
        assert.strictEqual(annotated[0]?.attributes.get("auth.session.id"), session.id);
        assert.strictEqual(annotated[0]?.attributes.get("auth.principal.type"), "user");
        const secret = Redacted.value(token).slice(session.id.length + 1);
        const allValues = trace.spans.flatMap((span) =>
          [...span.attributes.values()].map((value) => String(value)),
        );
        assert.isFalse(allValues.some((value) => value.includes(secret)));
      }).pipe(Effect.provide(TestLayer.pipe(Layer.provideMerge(trace.layer))));
    },
  );
});

// ADR-EA-042, group A: the same credential table `Credentials.test.ts` runs through `Credentials.resolve`, served here
// through Path A's real middleware over `HttpApiTest` (one handler per declared scheme, Effect's security loop as the
// chain). That the two agree row by row is the proof that the loop plus `step` equals `resolve`.
describe("Path A parity with the credential table (group A)", () => {
  const AllHeaders = {
    cookie: Schema.optional(Schema.String),
    authorization: Schema.optional(Schema.String),
    "x-api-key": Schema.optional(Schema.String),
  };
  const endpointAt = (path: `/${string}`) =>
    HttpApiEndpoint.get("who", path, { headers: AllHeaders, success: Schema.String });
  const ParityApi = HttpApi.make("parity")
    .add(HttpApiGroup.make("user").add(endpointAt("/who-user")).middleware(Api.Authentication))
    .add(
      HttpApiGroup.make("optional")
        .add(endpointAt("/who-optional"))
        .middleware(Api.OptionalAuthentication),
    )
    .add(
      HttpApiGroup.make("machine")
        .add(endpointAt("/who-machine"))
        .middleware(Api.MachineAuthentication),
    );

  const whoHandler = () =>
    Effect.gen(function* () {
      const principal = yield* Api.CurrentPrincipal;
      if (principal._tag === "Anonymous") return "anonymous";
      const acting =
        principal._tag === "User" && principal.actingAs !== undefined
          ? `~${who(principal.actingAs.id)}`
          : "";
      return `${who(principal.ref.id)}${acting}`;
    });

  const Handlers = Layer.mergeAll(
    HttpApiBuilder.group(ParityApi, "user", (handlers) => handlers.handle("who", whoHandler)),
    HttpApiBuilder.group(ParityApi, "optional", (handlers) => handlers.handle("who", whoHandler)),
    HttpApiBuilder.group(ParityApi, "machine", (handlers) => handlers.handle("who", whoHandler)),
  );

  const tiersServed = ["user", "machine", "optional"] as const;

  const MachineChallengeLayer = HttpApiBuilder.layer(ParityApi).pipe(
    Layer.provide(Handlers),
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provideMerge(Authentication.OptionalAuthenticationLive),
    Layer.provideMerge(Authentication.MachineAuthenticationLive),
    Layer.provide(Wiring.resolver),
    Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

  for (const row of rows) {
    for (const tier of tiersServed) {
      const expected = row[tier];
      it.effect(`${row.id} ${tier} over Path A: ${expected}`, () => {
        const carriers = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
        const Hook = Layer.succeed(Authentication.PostAuthResponseHook, {
          decorate: (_principal, response, context) =>
            Ref.update(carriers, (seen) => [...seen, context.scheme]).pipe(Effect.as(response)),
        });
        return Effect.gen(function* () {
          const tokens = yield* seed;
          const client = yield* HttpApiTest.groups(ParityApi, ["user", "optional", "machine"]);
          const outcome = yield* client[tier].who({ headers: headersFor(row, tokens) }).pipe(
            Effect.map((principal) => principal),
            Effect.catchTag("Unauthenticated", () => Effect.succeed(none)),
          );
          const scheme = (yield* Ref.get(carriers))[0];
          const served =
            outcome === none || outcome === "anonymous" ? none : `${outcome}@${scheme}`;
          assert.strictEqual(served, expected);
        }).pipe(
          Effect.provide(
            Handlers.pipe(
              Layer.provideMerge(Authentication.AuthenticationLive),
              Layer.provideMerge(Authentication.OptionalAuthenticationLive),
              Layer.provideMerge(Authentication.MachineAuthenticationLive),
              Layer.provide(Hook),
              Layer.provideMerge(layerFor(variantOf(row))),
              Layer.provideMerge(TestServices),
            ),
          ),
        );
      });
    }
  }

  // The machine tier's last scheme is `bearer` too: its 401 carries the same JR-007 challenge.
  it.effect("JR-007: the machine tier's 401 carries the same WWW-Authenticate challenge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const challengeOf = (headers: Record<string, string>) =>
          serve("/who-machine", headers).pipe(
            Effect.map((response) => ({
              status: response.status,
              challenge: response.headers["www-authenticate"],
            })),
          );
        const bare = yield* challengeOf({});
        assert.strictEqual(bare.status, 401);
        assert.strictEqual(bare.challenge, 'Bearer realm="awthaq"');
        const invalid = yield* challengeOf({ authorization: "Bearer not-a-real-token" });
        assert.strictEqual(invalid.status, 401);
        assert.strictEqual(invalid.challenge, 'Bearer realm="awthaq", error="invalid_token"');
        const keyOnly = yield* challengeOf({ "x-api-key": "nope" });
        assert.strictEqual(keyOnly.status, 401);
        assert.strictEqual(keyOnly.challenge, 'Bearer realm="awthaq"');
      }),
    ).pipe(Effect.provide(MachineChallengeLayer)),
  );
});
