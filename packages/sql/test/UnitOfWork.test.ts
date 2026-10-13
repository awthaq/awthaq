// ADR-EA-037: `SqlTransaction`'s unit of work. Two lanes, `onCommit` and `afterUnit`, over a
// real transaction (SQLite in memory, or Postgres under `pnpm test:pg`).
import { SqlTransaction } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestSql from "../../test/src/TestSql.ts";

const Live = TestSql.layer("sql_UnitOfWork");

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`DROP TABLE IF EXISTS uow_rows`);
  yield* sql.unsafe(`CREATE TABLE uow_rows (label TEXT NOT NULL)`);
  const log = yield* Ref.make<ReadonlyArray<string>>([]);
  const note = (label: string) => Ref.update(log, (entries) => [...entries, label]);
  const insert = (label: string) => sql`INSERT INTO uow_rows (label) VALUES (${label})`;
  const rows = Effect.map(
    sql<{ readonly label: string }>`SELECT label FROM uow_rows ORDER BY label`,
    (found) => found.map((row) => row.label),
  );
  return { sql, log, note, insert, rows, transactional: SqlTransaction.transactional(sql) };
});

describe("SqlTransaction.transactional", () => {
  it.effect("runs onCommit work after the commit, not before", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.transactional(
        Effect.gen(function* () {
          yield* SqlTransaction.onCommit(t.note("committed"));
          yield* t.note("body");
          assert.deepStrictEqual(yield* Ref.get(t.log), ["body"]);
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(t.log), ["body", "committed"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("drops onCommit work on rollback but still runs afterUnit work", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const exit = yield* Effect.exit(
        t.transactional(
          Effect.gen(function* () {
            yield* SqlTransaction.onCommit(t.note("committed"));
            yield* SqlTransaction.afterUnit(t.note("always"));
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.strictEqual(exit._tag, "Failure");
      assert.deepStrictEqual(yield* Ref.get(t.log), ["always"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("runs afterUnit work on commit too, once", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.transactional(SqlTransaction.afterUnit(t.note("always")));
      assert.deepStrictEqual(yield* Ref.get(t.log), ["always"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("a rolled-back savepoint drops its onCommit lane while the outer unit commits", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* t.transactional(
        Effect.gen(function* () {
          yield* SqlTransaction.onCommit(t.note("outer"));
          yield* Effect.ignore(
            t.transactional(
              Effect.gen(function* () {
                yield* SqlTransaction.onCommit(t.note("inner-commit"));
                yield* SqlTransaction.afterUnit(t.note("inner-always"));
                return yield* Effect.fail("inner boom");
              }),
            ),
          );
          yield* t.note("body");
        }),
      );
      assert.deepStrictEqual(yield* Ref.get(t.log), ["body", "outer", "inner-always"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "a kept savepoint hands its lanes to the parent, which runs them after the outermost ends",
    () =>
      Effect.gen(function* () {
        const t = yield* setup;
        yield* t.transactional(
          Effect.gen(function* () {
            yield* t.transactional(
              Effect.gen(function* () {
                yield* SqlTransaction.onCommit(t.note("inner-commit"));
                yield* SqlTransaction.afterUnit(t.note("inner-always"));
              }),
            );
            assert.deepStrictEqual(yield* Ref.get(t.log), []);
          }),
        );
        assert.deepStrictEqual(yield* Ref.get(t.log), ["inner-commit", "inner-always"]);
      }).pipe(Effect.provide(Live)),
  );

  it.effect("a rolled-back outer unit drops a kept savepoint's onCommit lane", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.ignore(
        t.transactional(
          Effect.gen(function* () {
            yield* t.transactional(SqlTransaction.onCommit(t.note("inner-commit")));
            return yield* Effect.fail("outer boom");
          }),
        ),
      );
      assert.deepStrictEqual(yield* Ref.get(t.log), []);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("an afterUnit write after a rollback persists, and a rolled-back write does not", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* Effect.ignore(
        t.transactional(
          Effect.gen(function* () {
            yield* t.insert("inside");
            yield* SqlTransaction.afterUnit(Effect.orDie(t.insert("forensic")).pipe(Effect.asVoid));
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.deepStrictEqual(yield* t.rows, ["forensic"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("outside any unit both lanes run immediately", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      yield* SqlTransaction.onCommit(t.note("commit"));
      yield* SqlTransaction.afterUnit(t.note("always"));
      assert.deepStrictEqual(yield* Ref.get(t.log), ["commit", "always"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect("SqlTransaction.layerSql opens a unit; layerNoop leaves both lanes immediate", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const real = yield* Effect.provide(SqlTransaction.SqlTransaction, SqlTransaction.layerSql);
      yield* Effect.ignore(
        real.withTransaction(
          Effect.gen(function* () {
            yield* SqlTransaction.onCommit(t.note("real-commit"));
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.deepStrictEqual(yield* Ref.get(t.log), []);
      const noop = yield* Effect.provide(SqlTransaction.SqlTransaction, SqlTransaction.layerNoop);
      yield* Effect.ignore(
        noop.withTransaction(
          Effect.gen(function* () {
            yield* SqlTransaction.onCommit(t.note("noop-commit"));
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.deepStrictEqual(yield* Ref.get(t.log), ["noop-commit"]);
    }).pipe(Effect.provide(Layer.mergeAll(Live))),
  );
});
