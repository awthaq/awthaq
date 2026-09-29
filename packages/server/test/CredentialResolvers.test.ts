// spec/behaviors/09-authentication-middleware.md, BEH-EA-066 (bearer), BEH-EA-072
// (declaration-order chain). MAPS-001/MAPS-004/OCM-002: plugin-contributed
// credential resolvers on the `bearer` and `apiKey` carriers (ADR-EA-012 registry).
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";
import * as Authentication from "../src/Authentication.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const RequestHeaders = {
  cookie: Schema.optional(Schema.String),
  authorization: Schema.optional(Schema.String),
  "x-api-key": Schema.optional(Schema.String),
};

const TestApi = HttpApi.make("test")
  .add(
    HttpApiGroup.make("required")
      .add(HttpApiEndpoint.get("whoAmI", "/who", { headers: RequestHeaders, success: Schema.String }))
      .middleware(Api.Authentication),
  )
  .add(
    HttpApiGroup.make("optional")
      .add(
        HttpApiEndpoint.get("whoAmI", "/who-optional", {
          headers: RequestHeaders,
          success: Schema.String,
        }),
      )
      .middleware(Api.OptionalAuthentication),
  );

const whoAmI = () =>
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    return `${principal._tag}:${principal.ref.id}`;
  });

const Handlers = Layer.mergeAll(
  HttpApiBuilder.group(TestApi, "required", (handlers) => handlers.handle("whoAmI", whoAmI)),
  HttpApiBuilder.group(TestApi, "optional", (handlers) => handlers.handle("whoAmI", whoAmI)),
);

const servicePrincipal = (id: string) =>
  new Api.ServicePrincipal({ ref: new Api.PrincipalRef({ type: "service", id }), scopes: [] });

/** Claims credentials starting with `prefix`; resolves to `Service:<id>` unless the credential ends `-bad`. */
const contribution = (
  carrier: Authentication.CredentialCarrier,
  id: string,
  prefix: string,
  order?: number,
) =>
  Authentication.contribute(carrier, {
    id,
    ...(order === undefined ? {} : { order }),
    claims: (raw) => raw.startsWith(prefix),
    resolve: (credential) =>
      Redacted.value(credential).endsWith("-bad")
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.succeed(servicePrincipal(id)),
  });

const layerWith = (...contributions: ReadonlyArray<ReturnType<typeof contribution>>) => {
  const registry = Layer.mergeAll(Layer.empty, ...contributions).pipe(
    Layer.provideMerge(Authentication.CredentialResolversLive),
  );
  return Handlers.pipe(
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provideMerge(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(registry),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
  );
};

const userId = Users.UserId("44444444-4444-4444-4444-444444444444");
const jwtShaped = (label: string) => `${label}.payload.signature`;

describe("credential resolvers (MAPS-001/MAPS-004/OCM-002)", () => {
  it.effect("with no contribution a JWT-shaped bearer is a session lookup miss: 401", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const exit = yield* Effect.exit(
        client.required.whoAmI({ headers: { authorization: `Bearer ${jwtShaped("a")}` } }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(layerWith())),
  );

  it.effect("a claimed bearer credential's principal becomes CurrentPrincipal", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoAmI({
        headers: { authorization: `Bearer ${jwtShaped("a")}` },
      });
      assert.strictEqual(result, "Service:jwt");
    }).pipe(Effect.provide(layerWith(contribution("bearer", "jwt", "a.")))),
  );

  it.effect("two contributions: the first whose claims() matches resolves", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const first = yield* client.required.whoAmI({
        headers: { authorization: "Bearer a.x.y" },
      });
      const second = yield* client.required.whoAmI({
        headers: { authorization: "Bearer b.x.y" },
      });
      assert.strictEqual(first, "Service:one");
      assert.strictEqual(second, "Service:two");
    }).pipe(
      Effect.provide(
        layerWith(contribution("bearer", "two", "b."), contribution("bearer", "one", "a.")),
      ),
    ),
  );

  it.effect("contributions claiming the same shape run in (order, id) order", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoAmI({
        headers: { authorization: "Bearer shared.x.y" },
      });
      // `zeta` has the lower `order`, so it wins over the alphabetically-earlier `alpha`.
      assert.strictEqual(result, "Service:zeta");
    }).pipe(
      Effect.provide(
        layerWith(
          contribution("bearer", "alpha", "shared", 5),
          contribution("bearer", "zeta", "shared", 1),
        ),
      ),
    ),
  );

  it.effect("a claiming contribution that fails is Unauthenticated: later ones are not tried", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const exit = yield* Effect.exit(
        client.required.whoAmI({ headers: { authorization: "Bearer shared.x-bad" } }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(
      Effect.provide(
        layerWith(
          contribution("bearer", "first", "shared", 1),
          contribution("bearer", "second", "shared", 2),
        ),
      ),
    ),
  );

  it.effect("no contribution claims an opaque bearer: it still resolves through Sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const result = yield* client.required.whoAmI({
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      });
      assert.strictEqual(result, `User:${userId}`);
    }).pipe(Effect.provide(layerWith(contribution("bearer", "jwt", "a.")))),
  );

  it.effect("the apiKey carrier reads x-api-key; cookie still wins when both are present", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const { token } = yield* sessions.issue({ userId });
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const viaKey = yield* client.required.whoAmI({ headers: { "x-api-key": "ak_1.secret" } });
      assert.strictEqual(viaKey, "Service:keys");
      const both = yield* client.required.whoAmI({
        headers: {
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
          "x-api-key": "ak_1.secret",
        },
      });
      assert.strictEqual(both, `User:${userId}`);
    }).pipe(Effect.provide(layerWith(contribution("apiKey", "keys", "ak_")))),
  );

  it.effect("an unclaimed x-api-key is Unauthenticated (never treated as a session token)", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const exit = yield* Effect.exit(
        client.required.whoAmI({ headers: { "x-api-key": "not-a-key" } }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(layerWith(contribution("apiKey", "keys", "ak_")))),
  );

  it.effect("OptionalAuthentication: a claimed credential resolves, a failed one is anonymous", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      const ok = yield* client.optional.whoAmI({ headers: { "x-api-key": "ak_1" } });
      assert.strictEqual(ok, "Service:keys");
      const bad = yield* client.optional.whoAmI({ headers: { "x-api-key": "ak_1-bad" } });
      assert.strictEqual(bad, "Anonymous:anonymous");
      const bearer = yield* client.optional.whoAmI({ headers: { authorization: "Bearer a.x.y" } });
      assert.strictEqual(bearer, "Service:jwt");
    }).pipe(
      Effect.provide(
        layerWith(contribution("apiKey", "keys", "ak_"), contribution("bearer", "jwt", "a.")),
      ),
    ),
  );

  it.effect("the post-auth hook is told the credential came in as apiKey", () => {
    const schemes = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
    const TappedHook = Layer.succeed(Authentication.PostAuthResponseHook, {
      decorate: (
        _principal: Api.Principal,
        response: HttpServerResponse.HttpServerResponse,
        context: { readonly scheme: "cookie" | "bearer" | "impersonation" | "apiKey" },
      ) => Ref.update(schemes, (seen) => [...seen, context.scheme]).pipe(Effect.as(response)),
    });
    return Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, ["required", "optional"]);
      yield* client.required.whoAmI({ headers: { "x-api-key": "ak_1" } });
      yield* client.required.whoAmI({ headers: { authorization: "Bearer a.x.y" } });
      assert.deepStrictEqual(yield* Ref.get(schemes), ["apiKey", "bearer"]);
    }).pipe(
      Effect.provide(
        layerWith(contribution("apiKey", "keys", "ak_"), contribution("bearer", "jwt", "a.")).pipe(
          Layer.provideMerge(TappedHook),
        ),
      ),
    );
  });

  it.effect("two contributions with one id on one carrier fail at layer build", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Layer.build(
          Layer.mergeAll(contribution("bearer", "dup", "a."), contribution("bearer", "dup", "b.")).pipe(
            Layer.provide(Authentication.CredentialResolversLive),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("the same id on different carriers is fine", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Layer.build(
          Layer.mergeAll(contribution("bearer", "x", "a."), contribution("apiKey", "x", "b.")).pipe(
            Layer.provide(Authentication.CredentialResolversLive),
          ),
        ),
      );
      assert.isTrue(Exit.isSuccess(exit));
    }).pipe(Effect.scoped),
  );

  it.effect("a contribution after the registry was first read is refused (frozen at first read)", () =>
    Effect.gen(function* () {
      const registry = yield* Authentication.CredentialResolvers;
      yield* registry.resolvers("bearer");
      const exit = yield* Effect.exit(
        registry.register("bearer", {
          id: "late",
          claims: () => true,
          resolve: () => Effect.succeed(servicePrincipal("late")),
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(Authentication.CredentialResolversLive)),
  );
});
