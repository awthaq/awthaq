// A toy plugin with one table and a matched records bundle, the fixture every `TestAuth` records test composes:
// `Pins` owns `pins_pin`, a `PinRecords` store with a memory and a SQL implementation, and two endpoints behind
// `Api.Authentication` / `Api.CsrfProtection` (so `TestAuth.layer` must derive both).
import { Api } from "@awthaq/api";
import { AuthPlugin } from "@awthaq/core";
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

export interface PinRecordsShape {
  readonly add: (label: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

/** A record store: the `/records/` key segment is what the compiler reads. */
export class PinRecords extends Context.Service<PinRecords, PinRecordsShape>()(
  "pins/records/PinRecords",
) {
  static readonly layerMemory = Layer.effect(
    PinRecords,
    Effect.gen(function* () {
      const pins = yield* Ref.make<ReadonlyArray<string>>([]);
      return PinRecords.of({
        add: (label) => Ref.update(pins, (all) => [...all, label]),
        list: Ref.get(pins),
      });
    }),
  );

  static readonly layerSql = Layer.effect(
    PinRecords,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return PinRecords.of({
        add: (label) => sql`INSERT INTO pins_pin (label) VALUES (${label})`.pipe(Effect.orDie),
        list: sql<{ readonly label: string }>`SELECT label FROM pins_pin ORDER BY label`.pipe(
          Effect.map((rows) => rows.map((row) => row.label)),
          Effect.orDie,
        ),
      });
    }),
  );
}

const PinsApi = HttpApi.make("auth").add(
  HttpApiGroup.make("pins").add(
    HttpApiEndpoint.get("list", "/pins", { success: Schema.Array(Schema.String) }).middleware(
      Api.Authentication,
    ),
    HttpApiEndpoint.post("add", "/pins", {
      payload: Schema.Struct({ label: Schema.String }),
      success: Schema.String,
    })
      .middleware(Api.Authentication)
      .middleware(Api.CsrfProtection),
  ),
);

const PinsHandlers = HttpApiBuilder.group(
  PinsApi,
  "pins",
  Effect.fnUntraced(function* (handlers) {
    const pins = yield* Pins;
    return handlers
      .handle("list", () => pins.list)
      .handle("add", ({ payload }) => pins.add(payload.label).pipe(Effect.as("added")));
  }),
);

export class Pins extends AuthPlugin.Service<Pins, PinRecordsShape>()("pins", {
  apiVersion: 1,
  contract: PinsApi,
  tables: { pins_pin: AuthPlugin.Table.global("a test fixture's table") },
  migrations: [
    {
      name: "create_pins_pin",
      up: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE pins_pin (label TEXT NOT NULL)`;
      }),
    },
  ],
  records: { memory: PinRecords.layerMemory, sql: PinRecords.layerSql },
}) {
  static readonly layer = AuthPlugin.layer(Pins, {
    handlers: PinsHandlers,
    make: Effect.map(PinRecords, (records) => ({ add: records.add, list: records.list })),
  });
}
