// Hand-wired on purpose: the credential-resolver registry is the unit under test; what the suites repeat (resolver, CSRF config and protection, token mint) lives in `test/support/Wiring.ts` (plan 08 exemption).
// spec/behaviors/09-authentication-middleware.md, BEH-EA-066 (bearer), BEH-EA-072
// (declaration-order chain). MAPS-001/MAPS-004/OCM-002: plugin-contributed
// credential resolvers on the `bearer` and `apiKey` carriers (ADR-EA-012 registry).
import { AuditLog, AuthEvents, Persistence, Sessions } from "@awthaq/core";
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
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as Authentication from "../src/Authentication.ts";
import * as Credentials from "../src/Credentials.ts";
import * as Wiring from "./support/Wiring.ts";

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
      .add(
        HttpApiEndpoint.get("whoAmI", "/who", { headers: RequestHeaders, success: Schema.String }),
      )
      .middleware(Api.Authentication)
      .middleware(Api.RequestContext),
  )
  .add(
    HttpApiGroup.make("optional")
      .add(
        HttpApiEndpoint.get("whoAmI", "/who-optional", {
          headers: RequestHeaders,
          success: Schema.String,
        }),
      )
      .middleware(Api.OptionalAuthentication)
      .middleware(Api.RequestContext),
  )
  .add(
    HttpApiGroup.make("machine")
      .add(
        HttpApiEndpoint.get("whoAmI", "/who-machine", {
          headers: RequestHeaders,
          success: Schema.String,
        }),
      )
      .middleware(Api.MachineAuthentication)
      .middleware(Api.RequestContext),
  );

const whoAmI = () =>
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    return `${principal._tag}:${principal.ref.id}`;
  });

const Handlers = Layer.mergeAll(
  HttpApiBuilder.group(TestApi, "required", (handlers) => handlers.handle("whoAmI", whoAmI)),
  HttpApiBuilder.group(TestApi, "optional", (handlers) => handlers.handle("whoAmI", whoAmI)),
  HttpApiBuilder.group(TestApi, "machine", (handlers) => handlers.handle("whoAmI", whoAmI)),
);

const servicePrincipal = (id: string) =>
  new Api.ServicePrincipal({ ref: new Api.PrincipalRef({ type: "service", id }), scopes: [] });

const userPrincipal = (id: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId: "stateless",
  });

/**
 * Claims credentials starting with `prefix`; resolves to `Service:<id>` (or
 * `User:<id>` when `asUser`) unless the credential ends `-bad`.
 */
const contribution = (
  carrier: Credentials.ClaimCarrier,
  id: string,
  prefix: string,
  order?: number,
  asUser = false,
) =>
  Credentials.contribute(carrier, {
    id,
    ...(order === undefined ? {} : { order }),
    claims: (raw) => raw.startsWith(prefix),
    resolve: (credential) =>
      Redacted.value(credential).endsWith("-bad")
        ? Effect.fail(new Api.Unauthenticated())
        : Effect.succeed(asUser ? userPrincipal(id) : servicePrincipal(id)),
  });

const layerWith = (...contributions: ReadonlyArray<ReturnType<typeof contribution>>) => {
  const registry = Layer.mergeAll(Layer.empty, ...contributions).pipe(
    Layer.provideMerge(Credentials.CredentialResolversLive),
  );
  return Handlers.pipe(
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provideMerge(Authentication.OptionalAuthenticationLive),
    Layer.provideMerge(Authentication.MachineAuthenticationLive),
    Layer.provide(Wiring.resolver),
    Layer.provideMerge(Wiring.requestContextLive),
    Layer.provideMerge(registry),
    Layer.provideMerge(Sessions.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
  );
};

describe("credential resolvers (MAPS-001/MAPS-004/OCM-002)", () => {
  const groups = ["required", "optional", "machine"] as const;

  it.effect("two contributions: the first whose claims() matches resolves", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(TestApi, groups);
      const first = yield* client.machine.whoAmI({ headers: { authorization: "Bearer a.x.y" } });
      const second = yield* client.machine.whoAmI({ headers: { authorization: "Bearer b.x.y" } });
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
      const client = yield* HttpApiTest.groups(TestApi, groups);
      const result = yield* client.machine.whoAmI({
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
      const client = yield* HttpApiTest.groups(TestApi, groups);
      const exit = yield* Effect.exit(
        client.machine.whoAmI({ headers: { authorization: "Bearer shared.x-bad" } }),
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
      const client = yield* HttpApiTest.groups(TestApi, groups);
      yield* client.machine.whoAmI({ headers: { "x-api-key": "ak_1" } });
      yield* client.machine.whoAmI({ headers: { authorization: "Bearer a.x.y" } });
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
          Layer.mergeAll(
            contribution("bearer", "dup", "a."),
            contribution("bearer", "dup", "b."),
          ).pipe(Layer.provide(Credentials.CredentialResolversLive)),
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
            Layer.provide(Credentials.CredentialResolversLive),
          ),
        ),
      );
      assert.isTrue(Exit.isSuccess(exit));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a contribution after the registry was first read is refused (frozen at first read)",
    () =>
      Effect.gen(function* () {
        const registry = yield* Credentials.CredentialResolvers;
        yield* registry.resolvers("bearer");
        const exit = yield* Effect.exit(
          registry.register("bearer", {
            id: "late",
            claims: () => true,
            resolve: () => Effect.succeed(servicePrincipal("late")),
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }).pipe(Effect.provide(Credentials.CredentialResolversLive)),
  );
});
