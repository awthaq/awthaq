// Two `AuthPlugin.layer` calls for one class with different `dependsOn` (ELC-006), raised at
// registration. The loader must hand it over as a `LinkProblem` that `doctor` reports.
import { Auth, AuthPlugin } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";

class Base extends AuthPlugin.Service<Base, Record<string, never>>()("base", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Base, { make: Effect.succeed({}) });
}

class Twin extends AuthPlugin.Service<Twin, Record<string, never>>()("twin", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Twin, { make: Effect.succeed({}) });
  static readonly again = AuthPlugin.layer(Twin, { dependsOn: [Base], make: Effect.succeed({}) });
}

export default Auth.make([Base, Twin]);
