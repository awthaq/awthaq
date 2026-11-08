// Plan 25: the `RecordsContract` fixture. `Counters` owns two record stores over two tables:
// `CounterRecords` (`increment(max)` is a read-modify-write the domain relies on, so it is `atomic`;
// `get` is a `read`) and `TagRecords` (`add` is a `write`, `list` a `read`). `BrokenCounters` carries a
// memory adapter that reads, yields and writes in two `Ref` calls, which a `race` case must catch;
// `SurplusCounters` provides a third store no suite names.
import { AuthPlugin } from "@awthaq/core";
import { SqlStore } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpApi from "effect/http-api/HttpApi";
import * as SqlClient from "effect/sql/SqlClient";
import * as RecordsContract from "../../src/RecordsContract.ts";

export interface CounterRecordsShape {
  /** Atomic: adds one unless the counter already holds `max`; answers whether it did. */
  readonly increment: (max: number) => Effect.Effect<boolean>;
  readonly get: Effect.Effect<number>;
}

export class CounterRecords extends Context.Service<CounterRecords, CounterRecordsShape>()(
  "counters/records/CounterRecords",
) {
  static readonly layerMemory = Layer.effect(
    CounterRecords,
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      return CounterRecords.of({
        increment: (max) => Ref.modify(count, (n) => (n >= max ? [false, n] : [true, n + 1])),
        get: Ref.get(count),
      });
    }),
  );

  /** Reads, yields, then writes: two `Ref` calls, so racing callers overshoot `max`. */
  static readonly layerMemoryBroken = Layer.effect(
    CounterRecords,
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      return CounterRecords.of({
        increment: (max) =>
          Effect.gen(function* () {
            const n = yield* Ref.get(count);
            yield* Effect.yieldNow;
            if (n >= max) return false;
            yield* Ref.set(count, n + 1);
            return true;
          }),
        get: Ref.get(count),
      });
    }),
  );

  static readonly layerSql = Layer.effect(
    CounterRecords,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = Effect.map(
        sql<{ readonly n: number }>`SELECT n FROM counters_counter WHERE k = 'one'`,
        (rows) => Number(rows[0]?.n ?? 0),
      );
      return CounterRecords.of({
        increment: (max) =>
          SqlStore.atomically(
            sql,
            "counters_counter:one",
          )(
            Effect.gen(function* () {
              const n = yield* read;
              if (n >= max) return false;
              yield* sql`INSERT INTO counters_counter (k, n) VALUES ('one', ${n + 1})
                ON CONFLICT (k) DO UPDATE SET n = ${n + 1}`;
              return true;
            }),
          ).pipe(Effect.orDie),
        get: Effect.orDie(read),
      });
    }),
  );
}

export interface TagRecordsShape {
  readonly add: (tag: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<string>>;
}

export class TagRecords extends Context.Service<TagRecords, TagRecordsShape>()(
  "counters/records/TagRecords",
) {
  static readonly layerMemory = Layer.effect(
    TagRecords,
    Effect.gen(function* () {
      const tags = yield* Ref.make<ReadonlyArray<string>>([]);
      return TagRecords.of({
        add: (tag) => Ref.update(tags, (all) => [...all, tag]),
        list: Effect.map(Ref.get(tags), (all) => [...all].sort()),
      });
    }),
  );

  static readonly layerSql = Layer.effect(
    TagRecords,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return TagRecords.of({
        add: (tag) => sql`INSERT INTO counters_tag (tag) VALUES (${tag})`.pipe(Effect.orDie),
        list: sql<{ readonly tag: string }>`SELECT tag FROM counters_tag ORDER BY tag`.pipe(
          Effect.map((rows) => rows.map((row) => row.tag)),
          Effect.orDie,
        ),
      });
    }),
  );
}

/** A third store, provided only by `SurplusCounters`. */
class NoteRecords extends Context.Service<NoteRecords, { readonly count: Effect.Effect<number> }>()(
  "counters/records/NoteRecords",
) {
  static readonly layer = Layer.succeed(NoteRecords, NoteRecords.of({ count: Effect.succeed(0) }));
}

const migrations = [
  {
    name: "create_counters_tables",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE counters_counter (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`;
      yield* sql`CREATE TABLE counters_tag (tag TEXT NOT NULL)`;
    }),
  },
];

const tables = {
  counters_counter: AuthPlugin.Table.global("a test fixture's table"),
  counters_tag: AuthPlugin.Table.global("a test fixture's table"),
};

export class Counters extends AuthPlugin.Service<Counters, {}>()("counters", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables,
  migrations,
  records: {
    memory: Layer.merge(CounterRecords.layerMemory, TagRecords.layerMemory),
    sql: Layer.merge(CounterRecords.layerSql, TagRecords.layerSql),
  },
}) {
  static readonly layer = AuthPlugin.layer(Counters, { make: Effect.succeed({}) });
}

export class BrokenCounters extends AuthPlugin.Service<BrokenCounters, {}>()("counters", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables,
  migrations,
  records: {
    memory: Layer.merge(CounterRecords.layerMemoryBroken, TagRecords.layerMemory),
    sql: Layer.merge(CounterRecords.layerSql, TagRecords.layerSql),
  },
}) {
  static readonly layer = AuthPlugin.layer(BrokenCounters, { make: Effect.succeed({}) });
}

export class SurplusCounters extends AuthPlugin.Service<SurplusCounters, {}>()("counters", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables,
  migrations,
  records: {
    memory: Layer.mergeAll(CounterRecords.layerMemory, TagRecords.layerMemory, NoteRecords.layer),
    sql: Layer.mergeAll(CounterRecords.layerSql, TagRecords.layerSql, NoteRecords.layer),
  },
}) {
  static readonly layer = AuthPlugin.layer(SurplusCounters, { make: Effect.succeed({}) });
}

const MAX = 3;

export const counterRecords = RecordsContract.suite(CounterRecords, {
  operations: {
    increment: {
      atomic: [
        {
          name: "adds one until max, then refuses",
          run: Effect.gen(function* () {
            const counters = yield* CounterRecords;
            for (let n = 0; n < MAX; n++) {
              if (!(yield* counters.increment(MAX))) throw new Error(`refused at ${n}`);
            }
            if (yield* counters.increment(MAX)) throw new Error("went past max");
            if ((yield* counters.get) !== MAX) throw new Error("wrong count");
          }),
        },
      ],
      race: [
        {
          name: "8 increments racing at max - 1 store exactly one",
          run: Effect.gen(function* () {
            const counters = yield* CounterRecords;
            for (let n = 0; n < MAX - 1; n++) yield* counters.increment(MAX);
            const outcomes = yield* RecordsContract.race(counters.increment(MAX));
            const won = outcomes.filter(Boolean).length;
            const count = yield* counters.get;
            if (won !== 1 || count !== MAX) {
              throw new Error(`${won} won, counter at ${count} (max ${MAX})`);
            }
          }),
        },
      ],
    },
    get: {
      read: [
        {
          name: "a fresh counter is zero",
          run: Effect.gen(function* () {
            if ((yield* (yield* CounterRecords).get) !== 0) throw new Error("not zero");
          }),
        },
      ],
    },
  },
});

export const tagRecords = RecordsContract.suite(TagRecords, {
  operations: {
    add: {
      write: [
        {
          name: "a tag added is listed",
          run: Effect.gen(function* () {
            const tags = yield* TagRecords;
            yield* tags.add("b");
            yield* tags.add("a");
            const listed = yield* tags.list;
            if (listed.join(",") !== "a,b") throw new Error(listed.join(","));
          }),
        },
      ],
    },
    list: { exempt: "covered by add's case" },
  },
});
