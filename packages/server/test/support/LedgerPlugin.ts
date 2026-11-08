// A toy plugin for `AuthHost`'s own suites (plan 15), mirroring `packages/test/test/support/Pins.ts`, which this package
// cannot import (`@awthaq/server` sits below `@awthaq/test`). `Ledger` owns one table (`ledger_entry`, one migration),
// a record store with a memory and a SQL implementation, a declared hook point, a user field, a configuration
// reference and two groups: `ledger` (behind `Api.Authentication`, and `Api.CsrfProtection` on the write) and the
// admin-tier `ledger.admin` (behind `Api.AdminAuthentication`). Every composition-owned element `AuthHost` derives
// has something here that needs it.
import { Api } from "@awthaq/api";
import { AuthPlugin, HookPoint, UserFields } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as SqlClient from "effect/sql/SqlClient";

export interface LedgerRecordsShape {
  readonly add: (label: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

/** A record store: the `/records/` key segment is what the compiler reads. */
export class LedgerRecords extends Context.Service<LedgerRecords, LedgerRecordsShape>()(
  "ledger/records/LedgerRecords",
) {
  static readonly layerMemory = Layer.effect(
    LedgerRecords,
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<string>>([]);
      return LedgerRecords.of({
        add: (label) => Ref.update(entries, (all) => [...all, label]),
        list: Ref.get(entries),
      });
    }),
  );

  static readonly layerSql = Layer.effect(
    LedgerRecords,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return LedgerRecords.of({
        add: (label) => sql`INSERT INTO ledger_entry (label) VALUES (${label})`.pipe(Effect.orDie),
        list: sql<{
          readonly label: string;
        }>`SELECT label FROM ledger_entry ORDER BY label`.pipe(
          Effect.map((rows) => rows.map((row) => row.label)),
          Effect.orDie,
        ),
      });
    }),
  );
}

/** Observed after an entry is written; a host tap on it receives the instance the plugin runs. */
export class AfterLedgerEntry extends HookPoint.observe<AfterLedgerEntry>()(
  "ledger.entry.after",
  Schema.Struct({ label: Schema.String }),
) {}

/** The plugin's configuration: a host provides it through `services`. */
export const LedgerConfig = Context.Reference("ledger/LedgerConfig", {
  defaultValue: () => ({ prefix: "" }),
});

const LedgerApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("ledger")
      .add(
        HttpApiEndpoint.get("list", "/ledger", { success: Schema.Array(Schema.String) }).middleware(
          Api.Authentication,
        ),
        HttpApiEndpoint.post("add", "/ledger", {
          payload: Schema.Struct({ label: Schema.String }),
          success: Schema.String,
        })
          .middleware(Api.Authentication)
          .middleware(Api.CsrfProtection),
      )
      .middleware(Api.RequestContext),
  )
  .add(
    HttpApiGroup.make("ledger.admin")
      .add(
        HttpApiEndpoint.get("count", "/ledger/admin/count", { success: Schema.Number }).middleware(
          Api.AdminAuthentication,
        ),
      )
      .middleware(Api.RequestContext),
  );

const LedgerHandlers = HttpApiBuilder.group(
  LedgerApi,
  "ledger",
  Effect.fnUntraced(function* (handlers) {
    const ledger = yield* Ledger;
    return handlers
      .handle("list", () => ledger.list)
      .handle("add", ({ payload }) => ledger.add(payload.label));
  }),
);

const LedgerAdminHandlers = HttpApiBuilder.group(
  LedgerApi,
  "ledger.admin",
  Effect.fnUntraced(function* (handlers) {
    const ledger = yield* Ledger;
    return handlers.handle("count", () => Effect.map(ledger.list, (all) => all.length));
  }),
);

export interface LedgerShape {
  readonly add: (label: string) => Effect.Effect<string>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class Ledger extends AuthPlugin.Service<Ledger, LedgerShape>()("ledger", {
  apiVersion: 1,
  contract: LedgerApi,
  tables: { ledger_entry: AuthPlugin.Table.global("a test fixture's table") },
  migrations: [
    {
      name: "create_ledger_entry",
      up: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE ledger_entry (label TEXT NOT NULL)`;
      }),
    },
  ],
  records: { memory: LedgerRecords.layerMemory, sql: LedgerRecords.layerSql },
  hookPoints: AfterLedgerEntry.layer,
  userFields: { tier: UserFields.field(Schema.String) },
}) {
  static readonly layer = AuthPlugin.layer(Ledger, {
    handlers: Layer.merge(LedgerHandlers, LedgerAdminHandlers),
    make: Effect.gen(function* () {
      const records = yield* LedgerRecords;
      const after = yield* AfterLedgerEntry;
      const config = yield* LedgerConfig;
      return {
        add: (label: string) =>
          Effect.gen(function* () {
            const entry = `${config.prefix}${label}`;
            yield* records.add(entry);
            yield* after.run({ label: entry });
            return entry;
          }),
        list: records.list,
      };
    }),
  });
}

/** The two persistence modes every case runs over (declared, not `as const`). */
export const recordModes: readonly ["memory", "sql"] = ["memory", "sql"];
