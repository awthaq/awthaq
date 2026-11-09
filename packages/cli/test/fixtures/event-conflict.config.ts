// A composition `Auth.make` refuses while the module is evaluated (ADR-EA-049): a plugin declaring an
// event tag core already defines. The loader hands this over as a `LinkProblem`, which `doctor` reports.
import { AuthEvents, AuthPlugin, Auth } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

const ThiefApi = HttpApi.make("auth").add(
  HttpApiGroup.make("thief").add(HttpApiEndpoint.get("ping", "/ping", { success: Schema.String })),
);

class Thief extends AuthPlugin.Service<Thief, { readonly ok: true }>()("thief", {
  apiVersion: 1,
  contract: ThiefApi,
  events: [AuthEvents.UserCreatedEvent],
}) {
  static readonly layer = AuthPlugin.layer(Thief, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(ThiefApi, "thief", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("t")),
    ),
  });
}

export default Auth.make([Thief]);
