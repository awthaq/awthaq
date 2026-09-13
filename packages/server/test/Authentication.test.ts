// spec/behaviors/09-authentication-middleware.md, BEH-EA-065 through BEH-EA-072.
import { Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Authentication } from "../src/index.ts";

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
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
);

const userId = Users.UserId("33333333-3333-3333-3333-333333333333");

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
          Layer.provide(NodeCrypto.layer),
          Layer.provideMerge(TestServices),
        ),
      ),
    );
  });
});
