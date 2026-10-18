// Plan 16: the `FaultySql` test helper itself. A matched statement fails with the given reason, an
// unmatched one runs, and a transaction on the decorated client commits and rolls back.
import { assert, describe, it } from "@effect/vitest";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConnectionError, UnknownError } from "effect/unstable/sql/SqlError";
import * as FaultySql from "./support/FaultySql.ts";

const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));

const withTable = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
  }),
).pipe(Layer.provideMerge(Faulty));

describe("FaultySql", () => {
  it.effect("fails the next matching statements with the given reason, then recovers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: 2,
        reason: new ConnectionError({ cause: new Error("down") }),
        matching: /INSERT INTO probe/,
      });
      const first = yield* sql`INSERT INTO probe (label) VALUES ('a')`.pipe(Effect.flip);
      assert.strictEqual(first.reason._tag, "ConnectionError");
      yield* sql`INSERT INTO probe (label) VALUES ('b')`.pipe(Effect.flip);
      yield* sql`INSERT INTO probe (label) VALUES ('c')`;
      const rows = yield* sql`SELECT label FROM probe`;
      assert.deepStrictEqual(rows, [{ label: "c" }]);
      assert.strictEqual(yield* faults.attempts(/INSERT INTO probe/), 3);
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("an unmatched statement runs while a fault is pending", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: 1,
        reason: new UnknownError({ cause: new Error("x") }),
        matching: /INSERT/,
      });
      const rows = yield* sql`SELECT 1 AS one`;
      assert.deepStrictEqual(rows, [{ one: 1 }]);
      yield* faults.reset;
      yield* sql`INSERT INTO probe (label) VALUES ('ok')`;
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("a transaction on the decorated client commits, and rolls back on failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(sql`INSERT INTO probe (label) VALUES ('kept')`);
      yield* sql
        .withTransaction(
          sql`INSERT INTO probe (label) VALUES ('lost')`.pipe(Effect.andThen(Effect.fail("boom"))),
        )
        .pipe(Effect.flip);
      const rows = yield* sql`SELECT label FROM probe`;
      assert.deepStrictEqual(rows, [{ label: "kept" }]);
    }).pipe(Effect.provide(withTable)),
  );

  it.effect("beforeNext runs once, just before the next matching statement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const faults = yield* FaultySql.FaultControl;
      const ran = yield* Ref.make(0);
      yield* faults.beforeNext({ matching: /SELECT label/, run: Ref.update(ran, (n) => n + 1) });
      yield* sql`SELECT 1 AS one`;
      assert.strictEqual(yield* Ref.get(ran), 0);
      yield* sql`SELECT label FROM probe`;
      yield* sql`SELECT label FROM probe`;
      assert.strictEqual(yield* Ref.get(ran), 1);
    }).pipe(Effect.provide(withTable)),
  );
});
