// CAT-01..03 (phase 5): the core-table catalogue against the real migrations. Runs on SQLite, and on
// Postgres under `AWTHAQ_POSTGRES_URL` (the same file, `TestSql.layer` picks the database). The guard
// runs both migrators that create core tables, the core one and the rate limiter's own, so
// `rate_limit_buckets` is covered through its creation path, not by a hard-coded exception. A future
// opt-in store with its own migrator is not covered by construction and must be added to this guard
// (the one documented exception).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as CoreTables from "../src/CoreTables.ts";
import * as RateLimiterStoreSql from "../src/RateLimiterStoreSql.ts";
import * as TestSql from "../../test/src/TestSql.ts";

const SqlLive = TestSql.layer("sql_CoreTables");

const tablesNow = Effect.map(TestSql.schemaOf, (shape) =>
  Object.keys(shape.tables)
    .filter((name) => name !== RateLimiterStoreSql.migrationsTable)
    .sort(),
);

describe("CoreTables drift guard", () => {
  it.effect("every created table is classified, and every classified table is created", () =>
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      const afterCore = yield* tablesNow;
      const classified: ReadonlyArray<string> = [...CoreTables.names].sort();
      for (const name of afterCore) assert.include(classified, name);

      yield* RateLimiterStoreSql.migrate;
      const afterBoth = yield* tablesNow;
      assert.deepStrictEqual(afterBoth, classified);

      // replicated tables are mirrored by `LaggingReplica`, which copies them from a core-migrated primary
      for (const name of CoreTables.replicated) assert.include(afterCore, name);
    }).pipe(Effect.provide(SqlLive)),
  );

  it.effect("sealed columns exist, and tenancy matches the tenantId column", () =>
    Effect.gen(function* () {
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      yield* RateLimiterStoreSql.migrate;
      const shape = yield* TestSql.schemaOf;
      for (const entry of CoreTables.tables) {
        const columns = (shape.tables[entry.name] ?? []).map((column) => column.name);
        for (const sealed of entry.sealed) {
          assert.include(columns, sealed.column, `${entry.name}.${sealed.column} is sealed`);
        }
        assert.strictEqual(
          columns.includes("tenantId"),
          entry.tenancy !== "none",
          `${entry.name}: tenancy ${entry.tenancy} against the tenantId column`,
        );
      }
    }).pipe(Effect.provide(SqlLive)),
  );
});
