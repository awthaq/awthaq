// Plan 08 (BEH-EA-T1): `AuthHttp.middlewareFor` derives exactly the host middleware a composed api declares.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Persistence, Sessions, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as AuthHttp from "../src/AuthHttp.ts";
import * as Authentication from "../src/Authentication.ts";
import * as Csrf from "../src/Csrf.ts";

class PluginOwned extends HttpApiMiddleware.Service<PluginOwned>()("test/PluginOwned") {}

const endpoint = (name: string) =>
  HttpApiEndpoint.get(name, `/${name}`, { success: Schema.String });

const authn = HttpApiGroup.make("g_authn").add(endpoint("a")).middleware(Api.Authentication);
const csrfGroup = HttpApiGroup.make("g_csrf").add(endpoint("c")).middleware(Api.CsrfProtection);
const optional = HttpApiGroup.make("g_optional")
  .add(endpoint("o"))
  .middleware(Api.OptionalAuthentication);
const admin = HttpApiGroup.make("g_admin").add(endpoint("m")).middleware(Api.AdminAuthentication);
const machine = HttpApiGroup.make("g_machine")
  .add(endpoint("k"))
  .middleware(Api.MachineAuthentication);
const owned = HttpApiGroup.make("g_owned").add(endpoint("w")).middleware(PluginOwned);

const csrf = Layer.succeed(Csrf.CsrfConfig, {
  secret: Redacted.make("middleware-for-csrf-secret-0123456789abcdef"),
  allowedOrigins: [] as ReadonlyArray<string>,
});

const Foundation = Sessions.layer.pipe(
  Layer.provide(Persistence.memory),
  Layer.provideMerge(Users.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const buildFor = <Groups extends HttpApiGroup.Constraint>(api: HttpApi.HttpApi<"auth", Groups>) =>
  Layer.build(AuthHttp.middlewareFor(api, { csrf }).pipe(Layer.provide(Foundation)));

const present = (context: Context.Context<never>) => ({
  authentication: Option.isSome(Context.getOption(context, Api.Authentication)),
  optional: Option.isSome(Context.getOption(context, Api.OptionalAuthentication)),
  machine: Option.isSome(Context.getOption(context, Api.MachineAuthentication)),
  admin: Option.isSome(Context.getOption(context, Api.AdminAuthentication)),
  csrf: Option.isSome(Context.getOption(context, Api.CsrfProtection)),
});

describe("AuthHttp.middlewareFor (BEH-EA-T1)", () => {
  it.effect("builds exactly the middleware the api declares, and nothing else", () =>
    Effect.gen(function* () {
      const context = yield* buildFor(HttpApi.make("auth").add(authn).add(csrfGroup).add(owned));
      assert.deepStrictEqual(present(context), {
        authentication: true,
        optional: false,
        machine: false,
        admin: false,
        csrf: true,
      });
      // plugin-owned middleware is never derived
      assert.isTrue(Option.isNone(Context.getOption(context, PluginOwned)));
    }).pipe(Effect.scoped),
  );

  it.effect("builds nothing for an api that declares no host middleware", () =>
    Effect.gen(function* () {
      const context = yield* buildFor(HttpApi.make("auth").add(owned));
      assert.deepStrictEqual(present(context), {
        authentication: false,
        optional: false,
        machine: false,
        admin: false,
        csrf: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("an admin-only api builds, bringing its own Authentication internally", () =>
    Effect.gen(function* () {
      const context = yield* buildFor(HttpApi.make("auth").add(admin));
      assert.deepStrictEqual(present(context), {
        authentication: false,
        optional: false,
        machine: false,
        admin: true,
        csrf: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("builds the optional and machine tiers when declared", () =>
    Effect.gen(function* () {
      const context = yield* buildFor(HttpApi.make("auth").add(optional).add(machine));
      assert.deepStrictEqual(present(context), {
        authentication: false,
        optional: true,
        machine: true,
        admin: false,
        csrf: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a principal resolver given in the options replaces the default (it brings its own requirements)",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AuthHttp.middlewareFor(HttpApi.make("auth").add(authn), {
            csrf,
            principalResolver: Authentication.PrincipalResolverWithUserFactsLive,
          }).pipe(Layer.provide(Foundation)),
        );
        assert.isTrue(present(context).authentication);
      }).pipe(Effect.scoped),
  );
});
