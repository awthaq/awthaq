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
import * as CoreSealedColumns from "../src/CoreSealedColumns.ts";
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

// The expected side is inline text on purpose: a view compared with another view pins nothing.
const six: ReadonlyArray<string> = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
];
const flat = (columns: ReadonlyArray<{ readonly table: string; readonly column: string }>) =>
  columns.map((c) => `${c.table}.${c.column}`).sort();

describe("CoreTables", () => {
  const entry = (name: string) => CoreTables.tables.find((table) => table.name === name);

  it("the views hold the creation order", () => {
    const names: ReadonlyArray<string> = CoreTables.names;
    assert.deepStrictEqual(names, [...six, "auth_relay_cursor", "rate_limit_buckets"]);
    const partitioned: ReadonlyArray<string> = CoreTables.partitionedTables;
    assert.deepStrictEqual(partitioned, [
      "sessions",
      "verification_tokens",
      "verification_reservations",
      "auth_audit_log",
    ]);
    const directory: ReadonlyArray<string> = CoreTables.directoryTables;
    assert.deepStrictEqual(directory, ["users", "accounts"]);
    const stamped: ReadonlyArray<string> = CoreTables.stamped;
    assert.deepStrictEqual(stamped, six);
    const replicated: ReadonlyArray<string> = CoreTables.replicated;
    assert.deepStrictEqual(replicated, six);
  });

  it("isStamped is true for the six stamped tables only", () => {
    for (const name of six) assert.isTrue(CoreTables.isStamped(name), name);
    for (const name of ["auth_relay_cursor", "rate_limit_buckets", "stranger_a"]) {
      assert.isFalse(CoreTables.isStamped(name), name);
    }
  });

  it("the two non-tenant tables are classified none, not replicated, with a reason", () => {
    for (const name of ["auth_relay_cursor", "rate_limit_buckets"]) {
      const table = entry(name);
      assert.strictEqual(table?.tenancy, "none", name);
      assert.strictEqual(table?.replicated, false, name);
      assert.strictEqual(table?.owner, "core", name);
      assert.isAbove(table?.reason?.length ?? 0, 0, `${name} reason`);
    }
    for (const table of CoreTables.tables) {
      assert.strictEqual(table.owner, "core", table.name);
      if (table.tenancy === "none" || !table.replicated) {
        assert.isAbove(table.reason?.length ?? 0, 0, `${table.name} reason`);
      }
    }
  });

  it("an entry carries no column types or DDL (ADR-EA-004)", () => {
    const allowed = ["name", "owner", "tenancy", "replicated", "sealed", "reason"];
    for (const table of CoreTables.tables) {
      for (const key of Object.keys(table)) assert.include(allowed, key, `${table.name}.${key}`);
    }
  });

  it("the sealed view is the CoreSealedColumns declarations, not a copy", () => {
    const sealed = (name: string) => entry(name)?.sealed.map((c) => c.column);
    assert.deepStrictEqual(sealed("users"), ["metadata"]);
    assert.deepStrictEqual(sealed("accounts"), ["accessToken", "refreshToken", "idToken"]);
    assert.deepStrictEqual(sealed("sessions"), ["ipAddress", "userAgent"]);
    for (const name of ["verification_tokens", "verification_reservations", "auth_audit_log"]) {
      assert.deepStrictEqual(sealed(name), [], name);
    }
    for (const name of ["auth_relay_cursor", "rate_limit_buckets"]) {
      assert.deepStrictEqual(sealed(name), [], name);
    }
    const flattened = CoreTables.tables.flatMap((table) => table.sealed);
    const declared = CoreSealedColumns.deployed({ encryptPii: true });
    assert.strictEqual(flattened.length, 6);
    assert.deepStrictEqual(flat(flattened), flat(declared));
    assert.strictEqual(entry("users")?.sealed[0], CoreSealedColumns.usersMetadata);
  });
});
