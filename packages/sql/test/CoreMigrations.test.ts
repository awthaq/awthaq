// SSMS-006: every core index migration is `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
// so an operator can pre-build an index out of band (on Postgres:
// `CREATE INDEX CONCURRENTLY`, which cannot run inside the migrator's
// transaction) and the recorded migration is then a no-op instead of failing.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

/** `coreMigrations` truncated to ids `<= upTo` — the state of a database one release behind. */
const upTo = (id: number): Migrator.Loader<never> =>
  Effect.map(CoreMigrations.coreMigrations, (all) =>
    all.filter(([migrationId]) => migrationId <= id),
  );

describe("CoreMigrations", () => {
  it.effect(
    "SSMS-006: an index pre-created out of band does not break the recorded migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A release that predates migration 9 (sessions_user_id).
        yield* Migrator.make({})({ loader: upTo(8) });
        // The operator builds it out of band, with the same name and definition.
        yield* sql`CREATE INDEX sessions_user_id ON sessions(userId)`;
        const applied = yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
        assert.deepStrictEqual(
          applied.map(([id]) => id),
          [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
        );
      }).pipe(Effect.provide(SqlLive)),
  );

  it.effect("every index migration uses IF NOT EXISTS", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) =>
          fs.readFile(new URL("../src/CoreMigrations.ts", import.meta.url), "utf8"),
        ),
      );
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      const statements = code.match(/CREATE (UNIQUE )?INDEX [^\n]*/g) ?? [];
      assert.isAbove(statements.length, 0);
      for (const statement of statements) {
        assert.match(statement, /CREATE (UNIQUE )?INDEX IF NOT EXISTS /);
      }
    }),
  );
});
