// Plan 23: what only the SQL adapter of `RelayCursorStore` can show. What every adapter must do is
// `StoreContract.relayCursor` (run over SQLite, a WAL file and Postgres by
// `packages/test/test/StoreContract.*.test.ts`); this is the failure mapping and the caller's clock.
import { RelayCursorStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as RelayCursorStoreSql from "../src/RelayCursorStoreSql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));
const Store = RelayCursorStoreSql.layer.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const at = DateTime.makeUnsafe(1_700_000_000_000);

describe("RelayCursorStoreSql (SQLite)", () => {
  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* RelayCursorStore.RelayCursorStore;
      yield* sql`ALTER TABLE auth_relay_cursor RENAME TO auth_relay_cursor_down`;
      const failures = {
        get: yield* store.get("relay").pipe(Effect.flip),
        advance: yield* store.advance({ name: "relay", lastEventId: "e-1", at }).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `RelayCursorStore.${primitive}`);
        assert.notProperty(failure, "cause");
      }
    }).pipe(Effect.provide(Store)),
  );

  it.effect("advance writes updatedAt from the caller's clock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* RelayCursorStore.RelayCursorStore;
      yield* store.advance({ name: "relay", lastEventId: "e-1", at });
      const rows = yield* sql<{
        readonly lastEventId: string;
        readonly updatedAt: string;
      }>`SELECT "lastEventId", "updatedAt" FROM auth_relay_cursor WHERE name = ${"relay"}`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.lastEventId, "e-1");
      assert.strictEqual(rows[0]?.updatedAt, DateTime.formatIso(at));
    }).pipe(Effect.provide(Store)),
  );
});
