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
        // Every migration after the release the database was one behind — derived, not
        // hard-coded, so a new migration does not touch this test.
        const expected = (yield* CoreMigrations.coreMigrations)
          .map(([id]) => id)
          .filter((id) => id >= 9);
        assert.deepStrictEqual(
          applied.map(([id]) => id),
          expected,
        );
        assert.isAbove(expected.length, 11);
      }).pipe(Effect.provide(SqlLive)),
  );

  it.effect(
    "FAMS-002: the email-nullable migration preserves existing rows and the lower(email) unique index (SQLite table rebuild)",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A release that predates the identity union (migrations 1-20).
        yield* Migrator.make({})({ loader: upTo(20) });
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt, metadata)
                   VALUES ('u1', 'ada@example.com', 1, 'Ada', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{"k":1}')`;
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt)
                   VALUES ('u2', 'bo@example.com', 0, 'Bo', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`;

        yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });

        const rows = yield* sql<{
          id: string;
          email: string | null;
          emailVerified: number;
          metadata: string | null;
          phone: string | null;
          phoneVerified: number;
          status: string;
          image: string | null;
        }>`SELECT id, email, emailVerified, metadata, phone, phoneVerified, status, image FROM users ORDER BY id`;
        assert.deepStrictEqual(rows, [
          {
            id: "u1",
            email: "ada@example.com",
            emailVerified: 1,
            metadata: '{"k":1}',
            phone: null,
            phoneVerified: 0,
            status: "active",
            image: null,
          },
          {
            id: "u2",
            email: "bo@example.com",
            emailVerified: 0,
            metadata: null,
            phone: null,
            phoneVerified: 0,
            status: "active",
            image: null,
          },
        ]);

        // The email index survived the rebuild: still case-insensitively unique...
        const duplicate =
          yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt)
                   VALUES ('u3', 'ADA@example.com', 0, 'Dup', 'x', 'x')`.pipe(Effect.flip);
        assert.strictEqual(duplicate.reason._tag, "UniqueViolation");
        // ...and now nullable: any number of email-less rows coexist (NULLs are distinct).
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt)
                   VALUES ('g1', NULL, 0, 'Guest 1', 'x', 'x')`;
        yield* sql`INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt)
                   VALUES ('g2', NULL, 0, 'Guest 2', 'x', 'x')`;

        // Phone numbers are unique; rows without one never collide.
        yield* sql`UPDATE users SET phone = '+15550100' WHERE id = 'g1'`;
        const phoneDuplicate =
          yield* sql`UPDATE users SET phone = '+15550100' WHERE id = 'g2'`.pipe(Effect.flip);
        assert.strictEqual(phoneDuplicate.reason._tag, "UniqueViolation");
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
