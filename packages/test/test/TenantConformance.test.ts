// Plan 05, phase 1: `runTenantIsolationTests` and `runSealedColumnTests` on a fixture plugin with one
// Partitioned and one Derived table, over a memory and a SQLite adapter, with recording frameworks
// (as `runPluginContractTests.test.ts` does) so a deliberately broken adapter can be shown to fail.
import { Encryption } from "@awthaq/ports";
import { SealedColumn, TenantScoped } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestAuth from "../src/TestAuth.ts";

class Recorder {
  readonly passed: Array<string> = [];
  readonly failed: Array<string> = [];
  readonly pending: Array<Promise<void>> = [];
  settled() {
    return Promise.all(this.pending).then(() => undefined);
  }
}

const recordingFramework = (sink: Recorder): TestAuth.TestFramework => ({
  describe: (_name, body) => body(),
  it: (name, body) => {
    sink.pending.push(
      Promise.resolve()
        .then(body)
        .then(
          () => {
            sink.passed.push(name);
          },
          (error: unknown) => {
            sink.failed.push(
              `${name} :: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
    );
  },
  fail: (message) => {
    throw new Error(message);
  },
});

// ---- a fixture records module: notes (Partitioned) and their tags (Derived) -------------------

interface NoteRecordsShape {
  readonly create: (id: string) => Effect.Effect<void>;
  readonly find: (id: string) => Effect.Effect<boolean>;
  readonly remove: (id: string) => Effect.Effect<boolean>;
  readonly findAnywhere: (grant: TenantScoped.CrossTenant, id: string) => Effect.Effect<boolean>;
}
class NoteRecords extends Context.Service<NoteRecords, NoteRecordsShape>()("test/NoteRecords") {}

interface TagRecordsShape {
  readonly add: (noteId: string) => Effect.Effect<void>;
  readonly tagsOf: (noteId: string) => Effect.Effect<number>;
}
class TagRecords extends Context.Service<TagRecords, TagRecordsShape>()("test/TagRecords") {}

const plugin = {
  id: "fx",
  tenancy: {
    fx_note: { tenancy: TenantScoped.partitioned() },
    fx_note_tag: { tenancy: TenantScoped.derived("fx_note", "noteId") },
    fx_setting: { tenancy: TenantScoped.global("deployment-wide") },
  },
};

const without = (map: ReadonlyMap<string, string | null>, id: string) => {
  const next = new Map(map);
  next.delete(id);
  return next;
};

/** `leaky: true` ignores the tenant on `find`, the very mistake the suite exists to catch. */
const memory = (leaky: boolean) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const notes = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map());
      const tags = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      const noteRecords = NoteRecords.of({
        create: (id) =>
          TenantScoped.stamp({ tenantId: null }).pipe(
            Effect.flatMap(({ tenantId }) =>
              Ref.update(notes, (map) => new Map(map).set(id, tenantId)),
            ),
          ),
        find: (id) =>
          Effect.gen(function* () {
            const seen = yield* TenantScoped.visibility();
            const map = yield* Ref.get(notes);
            return map.has(id) && (leaky || TenantScoped.matches(map.get(id) ?? null, seen));
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const seen = yield* TenantScoped.visibility();
            const map = yield* Ref.get(notes);
            if (!map.has(id) || !TenantScoped.matches(map.get(id) ?? null, seen)) return false;
            yield* Ref.update(notes, (current) => without(current, id));
            return true;
          }),
        findAnywhere: (grant, id) =>
          Effect.gen(function* () {
            const seen = yield* TenantScoped.visibility(grant);
            const map = yield* Ref.get(notes);
            return map.has(id) && TenantScoped.matches(map.get(id) ?? null, seen);
          }),
      });
      const tagRecords = TagRecords.of({
        add: (noteId) =>
          Ref.update(tags, (map) => new Map(map).set(noteId, (map.get(noteId) ?? 0) + 1)),
        tagsOf: (noteId) => Effect.map(Ref.get(tags), (map) => map.get(noteId) ?? 0),
      });
      return Context.make(NoteRecords, noteRecords).pipe(Context.add(TagRecords, tagRecords));
    }),
  );

const sqlite = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fx_note (id TEXT PRIMARY KEY, "tenantId" TEXT)`;
    yield* sql`CREATE TABLE fx_note_tag (id INTEGER PRIMARY KEY AUTOINCREMENT, "noteId" TEXT NOT NULL)`;
    const noteRecords = NoteRecords.of({
      create: (id) =>
        TenantScoped.stamp({ tenantId: null }).pipe(
          Effect.flatMap(
            ({ tenantId }) => sql`INSERT INTO fx_note (id, "tenantId") VALUES (${id}, ${tenantId})`,
          ),
          Effect.orDie,
          Effect.asVoid,
        ),
      find: (id) =>
        Effect.gen(function* () {
          const where = TenantScoped.predicate(sql, "tenantId", yield* TenantScoped.visibility());
          const rows = yield* sql`SELECT id FROM fx_note WHERE id = ${id} AND ${where}`;
          return rows.length > 0;
        }).pipe(Effect.orDie),
      remove: (id) =>
        Effect.gen(function* () {
          const where = TenantScoped.predicate(sql, "tenantId", yield* TenantScoped.visibility());
          const rows = yield* sql`DELETE FROM fx_note WHERE id = ${id} AND ${where} RETURNING id`;
          return rows.length > 0;
        }).pipe(Effect.orDie),
      findAnywhere: (grant, id) =>
        Effect.gen(function* () {
          const where = TenantScoped.predicate(
            sql,
            "tenantId",
            yield* TenantScoped.visibility(grant),
          );
          const rows = yield* sql`SELECT id FROM fx_note WHERE id = ${id} AND ${where}`;
          return rows.length > 0;
        }).pipe(Effect.orDie),
    });
    const tagRecords = TagRecords.of({
      add: (noteId) =>
        Effect.orDie(sql`INSERT INTO fx_note_tag ("noteId") VALUES (${noteId})`).pipe(
          Effect.asVoid,
        ),
      tagsOf: (noteId) =>
        Effect.map(
          sql`SELECT id FROM fx_note_tag WHERE "noteId" = ${noteId}`,
          (rows) => rows.length,
        ).pipe(Effect.orDie),
    });
    return Context.make(NoteRecords, noteRecords).pipe(Context.add(TagRecords, tagRecords));
  }),
).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));

const grant = TenantScoped.crossTenant("fixture: finds a note in any tenant");
let counter = 0;
const nextId = () => {
  counter += 1;
  return `n${counter}`;
};

const noteCase: TestAuth.TableCase<NoteRecordsShape, string, NoteRecords> = {
  table: "fx_note",
  insert: Effect.gen(function* () {
    const id = nextId();
    yield* (yield* NoteRecords).create(id);
    return id;
  }),
  methods: {
    create: { insert: true },
    find: { scoped: { run: (id) => Effect.flatMap(NoteRecords, (records) => records.find(id)) } },
    remove: {
      scoped: { run: (id) => Effect.flatMap(NoteRecords, (records) => records.remove(id)) },
    },
    findAnywhere: {
      crossTenant: {
        run: (id) => Effect.flatMap(NoteRecords, (records) => records.findAnywhere(grant, id)),
      },
    },
  },
};

const tagCase: TestAuth.TableCase<TagRecordsShape, string, NoteRecords | TagRecords> = {
  table: "fx_note_tag",
  insert: Effect.gen(function* () {
    const id = nextId();
    yield* (yield* NoteRecords).create(id);
    yield* (yield* TagRecords).add(id);
    return id;
  }),
  methods: {
    add: { insert: true },
    tagsOf: { derived: "keyed by a note id the caller resolved through a scoped find" },
  },
};

const runBoth = (
  sink: Recorder,
  adapters: ReadonlyArray<{ name: string; layer: Layer.Layer<NoteRecords | TagRecords, unknown> }>,
  options?: { readonly tagCase?: boolean },
) => {
  TestAuth.runTenantIsolationTests(recordingFramework(sink), {
    plugin,
    adapters,
    cases: [noteCase],
    covers: ["fx_note"],
  });
  TestAuth.runTenantIsolationTests(recordingFramework(sink), {
    plugin,
    adapters,
    cases: options?.tagCase === false ? [] : [tagCase],
    covers: ["fx_note_tag", "fx_setting"],
  });
};

describe("runTenantIsolationTests", () => {
  it("a correct records module passes every case over memory and SQLite", async () => {
    const sink = new Recorder();
    runBoth(sink, [
      { name: "memory", layer: memory(false) },
      { name: "sqlite", layer: sqlite },
    ]);
    await sink.settled();
    assert.deepStrictEqual(sink.failed, []);
    assert.isAbove(sink.passed.length, 10);
  });

  it("fails a records module whose scoped method ignores the tenant", async () => {
    const sink = new Recorder();
    runBoth(sink, [{ name: "memory", layer: memory(true) }]);
    await sink.settled();
    assert.isTrue(
      sink.failed.some((entry) => entry.includes("fx_note.find") && entry.includes("tenant")),
    );
  });

  it("fails a plugin whose Derived table has no case", async () => {
    const sink = new Recorder();
    runBoth(sink, [{ name: "memory", layer: memory(false) }], { tagCase: false });
    await sink.settled();
    assert.isTrue(
      sink.failed.some(
        (entry) => entry.includes('"fx_note_tag"') && entry.includes("no tenant-isolation case"),
      ),
    );
  });

  it("fails a case for a Global table", async () => {
    const sink = new Recorder();
    TestAuth.runTenantIsolationTests(recordingFramework(sink), {
      plugin,
      adapters: [{ name: "memory", layer: memory(false) }],
      cases: [{ ...tagCase, table: "fx_setting" }],
      covers: ["fx_setting"],
    });
    await sink.settled();
    assert.isTrue(
      sink.failed.some((entry) => entry.includes("declared Global and must not have a case")),
    );
  });

  it("does not compile when a records method is left unclassified", () => {
    // The `methods` map is keyed by `keyof Shape`: a method added to the interface fails here.
    const incomplete: TestAuth.TableCase<NoteRecordsShape, string, NoteRecords> = {
      table: "fx_note",
      insert: noteCase.insert,
      // @ts-expect-error `findAnywhere` is not classified
      methods: {
        create: { insert: true },
        find: noteCase.methods.find,
        remove: noteCase.methods.remove,
      },
    };
    assert.strictEqual(incomplete.table, "fx_note");
  });
});

// ---- the sealed-column wiring suite ------------------------------------------------------------

const secretColumn = SealedColumn.column({
  table: "fx_secret",
  column: "secret",
  key: "id",
  legacyAad: [(id) => `fx-secret:${id}:secret`],
});

interface SecretsShape {
  readonly write: (id: string, value: string) => Effect.Effect<void>;
  readonly read: (id: string) => Effect.Effect<SealedColumn.Sealed<string>>;
  readonly raw: (id: string) => Effect.Effect<string>;
  readonly plant: (id: string, stored: string) => Effect.Effect<void>;
}
class Secrets extends Context.Service<Secrets, SecretsShape>()("test/Secrets") {}

/** `plaintext: true` stores the value as given, the mistake the suite exists to catch. */
const secretsSql = (plaintext: boolean) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fx_secret (id TEXT PRIMARY KEY, secret TEXT)`;
      const codec = yield* SealedColumn.codec(
        secretColumn,
        yield* SealedColumn.sqlSwap(secretColumn),
      );
      const store = (id: string, stored: string) =>
        sql`INSERT INTO fx_secret (id, secret) VALUES (${id}, ${stored})
          ON CONFLICT (id) DO UPDATE SET secret = ${stored}`.pipe(Effect.orDie, Effect.asVoid);
      const raw = (id: string) =>
        Effect.map(
          sql<{ readonly secret: string }>`SELECT secret FROM fx_secret WHERE id = ${id}`,
          (rows) => rows[0]?.secret ?? "",
        ).pipe(Effect.orDie);
      return Context.make(
        Secrets,
        Secrets.of({
          write: (id, value) =>
            plaintext
              ? store(id, value)
              : Effect.flatMap(codec.seal(id, Redacted.make(value)), (stored) => store(id, stored)),
          read: (id) => Effect.map(raw(id), (stored) => codec.sealed(id, stored)),
          raw,
          plant: store,
        }),
      );
    }),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })));

const secretsMemory = Layer.effectContext(
  Effect.gen(function* () {
    const rows = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const swap: SealedColumn.Swap = (rowKey, stored, fresh) =>
      Ref.modify(rows, (map) =>
        map.get(rowKey) === stored ? [true, new Map(map).set(rowKey, fresh)] : [false, map],
      );
    const codec = yield* SealedColumn.codec(secretColumn, swap);
    const store = (id: string, stored: string) =>
      Ref.update(rows, (map) => new Map(map).set(id, stored));
    return Context.make(
      Secrets,
      Secrets.of({
        write: (id, value) =>
          Effect.flatMap(codec.seal(id, Redacted.make(value)), (stored) => store(id, stored)),
        read: (id) => Effect.map(Ref.get(rows), (map) => codec.sealed(id, map.get(id) ?? "")),
        raw: (id) => Effect.map(Ref.get(rows), (map) => map.get(id) ?? ""),
        plant: store,
      }),
    );
  }),
);

describe("runSealedColumnTests", () => {
  const run = async (
    adapters: ReadonlyArray<{
      name: string;
      layer: Layer.Layer<Secrets, unknown, Encryption.Encryption>;
    }>,
  ) => {
    const sink = new Recorder();
    TestAuth.runSealedColumnTests(recordingFramework(sink), {
      column: secretColumn,
      sample: "hunter2",
      adapters,
      write: (id, value) => Effect.flatMap(Secrets, (secrets) => secrets.write(id, value)),
      read: (id) => Effect.flatMap(Secrets, (secrets) => secrets.read(id)),
      raw: (id) => Effect.flatMap(Secrets, (secrets) => secrets.raw(id)),
      plant: (id, stored) => Effect.flatMap(Secrets, (secrets) => secrets.plant(id, stored)),
    });
    await sink.settled();
    return sink;
  };

  it("a records module that declares and uses its column passes over memory and SQLite", async () => {
    const sink = await run([
      { name: "memory", layer: secretsMemory },
      { name: "sqlite", layer: secretsSql(false) },
    ]);
    assert.deepStrictEqual(sink.failed, []);
    assert.strictEqual(sink.passed.length, 8);
  });

  it("fails a records module that stores the value unsealed", async () => {
    const sink = await run([{ name: "sqlite", layer: secretsSql(true) }]);
    assert.isTrue(sink.failed.some((entry) => entry.includes("not an Encryption envelope")));
  });
});
