// The real, `@effect/sql-pg`-backed counterpart to `RateLimiterStoreSql.test.ts`
// (RBS-004): same store, same migration, a real Postgres database. Skips (not
// fails) without `AWTHAQ_POSTGRES_URL` set, like `Repositories.postgres.test.ts`.
import { RateLimiter } from "@awthaq/ports";
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as RateLimiterStoreSql from "../src/RateLimiterStoreSql.ts";

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

describe.skipIf(postgresUrl === undefined)("RateLimiterStoreSql (real Postgres)", () => {
  const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });

  // The migrator is forward-only; start each run from a schema this test recreates.
  const Migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS rate_limit_buckets`;
      yield* sql`DROP TABLE IF EXISTS ${sql(RateLimiterStoreSql.migrationsTable)}`;
      yield* RateLimiterStoreSql.migrate;
    }),
  ).pipe(Layer.provide(SqlLive));

  const StoreLive = RateLimiterStoreSql.layerStoreSql.pipe(
    Layer.provideMerge(Migrated),
    Layer.provideMerge(SqlLive),
  );

  it.effect("20 concurrent increments of one key return counts 1..20", () =>
    Effect.gen(function* () {
      const store = yield* RateLimiter.RateLimiterStore;
      const buckets = yield* Effect.all(
        Array.from({ length: 20 }, () => store.increment("signin:alice", Duration.seconds(10))),
        { concurrency: "unbounded" },
      );
      const counts = buckets.map((bucket) => bucket.count).sort((a, b) => a - b);
      assert.deepStrictEqual(
        counts,
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    }).pipe(Effect.provide(StoreLive)),
  );
});
