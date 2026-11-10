// A sealed column whose table is not a plain SQL identifier, raised where the column is declared.
// The loader must hand it over as a `LinkProblem` that `doctor` reports.
import { Auth, AuthPlugin } from "@awthaq/core";
import { SealedColumn } from "@awthaq/sql";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";

const secret = SealedColumn.column({ table: "not an identifier", column: "x", key: "id" });

class Sealed extends AuthPlugin.Service<Sealed, Record<string, never>>()("sealed", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  sealedColumns: [secret],
}) {
  static readonly layer = AuthPlugin.layer(Sealed, { make: Effect.succeed({}) });
}

export default Auth.make([Sealed]);
