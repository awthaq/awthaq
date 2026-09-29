// A composition `Auth.make` refuses while the module is evaluated: two plugins contributing the
// same (method, path). The loader hands this over as a `LinkProblem`, which `doctor` reports.
import { AuthPlugin, Auth } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

const api = (group: string) =>
  HttpApi.make("auth").add(
    HttpApiGroup.make(group).add(HttpApiEndpoint.get("ping", "/ping", { success: Schema.String })),
  );

const AlphaApi = api("alpha");
const BetaApi = api("beta");

class Alpha extends AuthPlugin.Service<Alpha, { readonly ok: true }>()("alpha", {
  apiVersion: 1,
  contract: AlphaApi,
}) {
  static readonly layer = AuthPlugin.layer(Alpha, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(AlphaApi, "alpha", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("a")),
    ),
  });
}

class Beta extends AuthPlugin.Service<Beta, { readonly ok: true }>()("beta", {
  apiVersion: 1,
  contract: BetaApi,
}) {
  static readonly layer = AuthPlugin.layer(Beta, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(BetaApi, "beta", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("b")),
    ),
  });
}

export default Auth.make([Alpha, Beta]);
