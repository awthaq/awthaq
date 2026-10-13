// Plan 08 (BEH-EA-T1): `AuthHttp.middlewareFor`'s `ROut` is exactly the host middleware the composed api
// declares, and a plugin-owned middleware is never among them. Compile-time checks
// (`tsc -p tsconfig.test.json` is the assertion) with a token runtime test so the file is a suite.
import { Api } from "@awthaq/api";
import { it } from "@effect/vitest";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as AuthHttp from "../src/AuthHttp.ts";

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

class PluginOwned extends HttpApiMiddleware.Service<PluginOwned>()("test/PluginOwned") {}

const Ping = HttpApiEndpoint.get("ping", "/ping", { success: Schema.String });

const UserGroup = HttpApiGroup.make("user")
  .add(Ping)
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);
const ScimGroup = HttpApiGroup.make("owned")
  .add(HttpApiEndpoint.get("owned", "/owned"))
  .middleware(PluginOwned);
const EndpointOnly = HttpApiGroup.make("endpoint").add(
  HttpApiEndpoint.get("e", "/e", { success: Schema.String }).middleware(Api.OptionalAuthentication),
);

const api = HttpApi.make("auth").add(UserGroup).add(ScimGroup).add(EndpointOnly);
type Groups = typeof api extends HttpApi.HttpApi<"auth", infer G> ? G : never;

export const declaredIsExactlyTheHostMiddleware: Equals<
  AuthHttp.DeclaredMiddleware<Groups>,
  Api.Authentication | Api.CsrfProtection | Api.OptionalAuthentication
> = true;

export const layerSuccessIsTheDeclaredMiddleware: Equals<
  Layer.Success<ReturnType<typeof AuthHttp.middlewareFor<Groups>>>,
  AuthHttp.DeclaredMiddleware<Groups>
> = true;

it("the guarantees above are checked by the compiler", () => {});
