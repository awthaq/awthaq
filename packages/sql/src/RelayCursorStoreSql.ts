// @awthaq/sql — RelayCursorStoreSql
//
// Plan 23 (ADR-EA-041, ADR-EA-030 decision 4): the SQL adapter of `RelayCursorStore` over
// `auth_relay_cursor` (core migration 27). It owns its statements; there is no repository.
// - `get`: one read of the primary (a relay must never resume from a replica's stale position).
// - `advance`: one conditional upsert. `DO UPDATE ... WHERE` the stored id sorts before the new one
//   (`COLLATE "C"` on Postgres, SQLite's default BINARY), so concurrent relays of one name only
//   move it forward. Idempotent, so it is retried on a transient failure at the top level.

import { RelayCursorStore } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { dialectFields, resolveDialect } from "./Models.ts";
import * as SqlStore from "./SqlStore.ts";

/** The SQL adapter. Requires the one `SqlClient` (core migration 27 applied). */
export const layer = Layer.effect(
  RelayCursorStore.RelayCursorStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dialect = yield* resolveDialect(sql);
    const wire = dialectFields(dialect);
    const { write, read } = SqlStore.make(sql);

    const getQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ lastEventId: Schema.String }),
      execute: (name) => sql`SELECT "lastEventId" FROM auth_relay_cursor WHERE name = ${name}`,
    });

    const advanceQuery = SqlSchema.void({
      Request: Schema.Struct({
        name: Schema.String,
        lastEventId: Schema.String,
        updatedAt: wire.dateTime,
      }),
      execute: (r) =>
        dialect === "pg"
          ? sql`INSERT INTO auth_relay_cursor (name, "lastEventId", "updatedAt")
                VALUES (${r.name}, ${r.lastEventId}, ${r.updatedAt})
                ON CONFLICT (name) DO UPDATE
                  SET "lastEventId" = excluded."lastEventId", "updatedAt" = excluded."updatedAt"
                  WHERE auth_relay_cursor."lastEventId" COLLATE "C" < excluded."lastEventId" COLLATE "C"`
          : sql`INSERT INTO auth_relay_cursor (name, "lastEventId", "updatedAt")
                VALUES (${r.name}, ${r.lastEventId}, ${r.updatedAt})
                ON CONFLICT (name) DO UPDATE
                  SET "lastEventId" = excluded."lastEventId", "updatedAt" = excluded."updatedAt"
                  WHERE auth_relay_cursor."lastEventId" < excluded."lastEventId"`,
    });

    return RelayCursorStore.RelayCursorStore.of({
      get: (name) =>
        getQuery(name).pipe(
          Effect.map(Option.map((row) => row.lastEventId)),
          Effect.withSpan("RelayCursor.get", {}, { captureStackTrace: false }),
          read("RelayCursorStore.get"),
        ),
      advance: ({ name, lastEventId, at }) =>
        advanceQuery({ name, lastEventId, updatedAt: at }).pipe(
          Effect.withSpan("RelayCursor.advance", {}, { captureStackTrace: false }),
          write("RelayCursorStore.advance"),
        ),
    });
  }),
);
