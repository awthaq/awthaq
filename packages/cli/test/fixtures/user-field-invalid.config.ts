// A user field whose name is not <letters/digits> (BEH-EA-040), raised where the plugin is defined.
// The loader must hand it over as a `LinkProblem` that `doctor` reports.
import { Auth, AuthPlugin, UserFields } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";

class Fielded extends AuthPlugin.Service<Fielded, Record<string, never>>()("fielded", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  userFields: { "bad-name": UserFields.field(Schema.String) },
}) {
  static readonly layer = AuthPlugin.layer(Fielded, { make: Effect.succeed({}) });
}

export default Auth.make([Fielded]);
