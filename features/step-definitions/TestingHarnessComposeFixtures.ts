// BEH-EA-331..333 and 336 (25-testing-harness.feature): small plugins that exercise `TestAuth.layer`'s derived
// middleware, its SQL mode and `TestAuth.app`, written the way a third-party plugin author writes one.
import { Api } from "@awthaq/api";
import { Auth, AuthPlugin } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ---- an admin-tier group behind AdminAuthentication (BEH-EA-331) ---------------------------

const OperatorApi = HttpApi.make("auth").add(
  HttpApiGroup.make("operator.admin").add(
    HttpApiEndpoint.get("whoami", "/operator/whoami", { success: Schema.String }).middleware(
      Api.AdminAuthentication,
    ),
  ),
);

const OperatorHandlers = HttpApiBuilder.group(OperatorApi, "operator.admin", (handlers) =>
  handlers.handle("whoami", () =>
    Effect.map(Api.CurrentPrincipal, (principal) => `${principal._tag}:${principal.ref.id}`),
  ),
);

export class OperatorPlugin extends AuthPlugin.Service<OperatorPlugin, {}>()("operator", {
  apiVersion: 1,
  contract: OperatorApi,
}) {
  static readonly layer = AuthPlugin.layer(OperatorPlugin, {
    make: Effect.succeed({}),
    handlers: OperatorHandlers,
  });
}

export const operatorBuilt = Auth.make([OperatorPlugin]);

/** A host-supplied admin scheme (a stand-in for mTLS): a fixed operator, whatever the request carries. */
export const fixedOperator = (() => {
  const operator = Api.UserPrincipal.make({
    ref: Api.PrincipalRef.make({ type: "user", id: "operator-1" }),
    sessionId: "mtls",
  });
  const asOperator = (httpEffect: Parameters<Api.AdminAuthentication["Service"]["cookie"]>[0]) =>
    Effect.provideService(httpEffect, Api.CurrentPrincipal, operator);
  return Layer.succeed(Api.AdminAuthentication, {
    impersonation: asOperator,
    cookie: asOperator,
    bearer: asOperator,
  });
})();

// ---- a plugin with a records bundle (BEH-EA-332, BEH-EA-333) -------------------------------

export interface LedgerRecordsShape {
  readonly add: (entry: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class LedgerRecords extends Context.Service<LedgerRecords, LedgerRecordsShape>()(
  "ledger/records/LedgerRecords",
) {}

const ledgerMemory = Layer.effect(
  LedgerRecords,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<string>>([]);
    return LedgerRecords.of({
      add: (entry) => Ref.update(entries, (all) => [...all, entry]),
      list: Ref.get(entries),
    });
  }),
);

const ledgerSql = Layer.effect(
  LedgerRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return LedgerRecords.of({
      add: (entry) => sql`INSERT INTO ledger_entry (entry) VALUES (${entry})`.pipe(Effect.orDie),
      list: sql<{ readonly entry: string }>`SELECT entry FROM ledger_entry ORDER BY entry`.pipe(
        Effect.map((rows) => rows.map((row) => row.entry)),
        Effect.orDie,
      ),
    });
  }),
);

const LedgerApi = HttpApi.make("auth").add(
  HttpApiGroup.make("ledger").add(
    HttpApiEndpoint.get("list", "/ledger", { success: Schema.Array(Schema.String) }).middleware(
      Api.Authentication,
    ),
    HttpApiEndpoint.post("add", "/ledger", {
      payload: Schema.Struct({ entry: Schema.String }),
      success: Schema.String,
    })
      .middleware(Api.Authentication)
      .middleware(Api.CsrfProtection),
  ),
);

const LedgerHandlers = HttpApiBuilder.group(
  LedgerApi,
  "ledger",
  Effect.fnUntraced(function* (handlers) {
    const ledger = yield* LedgerPlugin;
    return handlers
      .handle("list", () => ledger.list)
      .handle("add", ({ payload }) => ledger.add(payload.entry).pipe(Effect.as("added")));
  }),
);

export class LedgerPlugin extends AuthPlugin.Service<LedgerPlugin, LedgerRecordsShape>()("ledger", {
  apiVersion: 1,
  contract: LedgerApi,
  tables: { ledger_entry: AuthPlugin.Table.global("a fixture's table") },
  migrations: [
    {
      name: "create_ledger_entry",
      up: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE ledger_entry (entry TEXT NOT NULL)`;
      }),
    },
  ],
  records: { memory: ledgerMemory, sql: ledgerSql },
}) {
  static readonly layer = AuthPlugin.layer(LedgerPlugin, {
    handlers: LedgerHandlers,
    make: Effect.map(LedgerRecords, (records) => ({ add: records.add, list: records.list })),
  });
}

export const ledgerBuilt = Auth.make([LedgerPlugin]);
