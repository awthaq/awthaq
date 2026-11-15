// `TestSql.layer` on Postgres drops the layer's schema when its scope closes, so a full run does not leave
// one schema per layer build behind. Skips without `AWTHAQ_POSTGRES_URL`, like every Postgres suite.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestSql from "../src/TestSql.ts";

it.effect.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(
  "the layer's schema exists while its scope is open and is gone once it closes",
  () =>
    Effect.gen(function* () {
      // A second database client (its own schema) looks at the catalog from outside the layer under test.
      const observer = yield* SqlClient.SqlClient;
      const exists = (name: string) =>
        observer<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${name}`.pipe(
          Effect.map((rows) => rows[0]?.n === 1),
        );
      const subject = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            readonly name: string;
          }>`SELECT current_schema() AS name`;
          const name = row?.name ?? "public";
          yield* sql`CREATE TABLE probe (id TEXT PRIMARY KEY)`;
          return { name, during: yield* exists(name) };
        }).pipe(Effect.provide(TestSql.layer("test_TestSqlRelease_subject"))),
      );
      assert.isTrue(subject.during);
      assert.isFalse(yield* exists(subject.name));
    }).pipe(Effect.provide(TestSql.layer("test_TestSqlRelease_observer"))),
);
