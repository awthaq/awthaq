// @awthaq/sql — RateLimiterStoreSql
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-105/109 (RBS-004/CSD-007): the
// shared, multi-replica `RateLimiterStore` — every replica counts against the
// same `rate_limit_buckets` rows, so a limit is not multiplied by the replica
// count the way `RateLimiter.layerStoreMemory`'s per-process `Ref` multiplies
// it. It runs over whichever database the application already migrated (the
// same Postgres/SQLite `SqlClient` the SQL session and verification layers use).
//
// BEH-EA-105's atomic-primitive requirement is one `INSERT ... ON CONFLICT DO
// UPDATE ... RETURNING`: the window check (is the bucket still live?) and the
// increment are a single statement, so concurrent replicas can never both
// observe a stale pre-increment count. Reset times are stored as epoch
// milliseconds in a numeric column rather than a dialect-specific timestamp
// type, so the same statement and the same decoded shape hold on Postgres and
// SQLite (the timestamp-decoding split between the two is what TS-001 is about).
//
// Any SQL/decoding failure becomes `RateLimiterStoreUnavailable`, which
// `RateLimiter.layer` turns into fail-open (default) or reject — the store
// never fails a request itself.

import { RateLimiter } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * The store's migration, kept out of `CoreMigrations.coreMigrations`: an
 * application that keeps rate limits in memory should not get a table it never
 * uses. Run it with its own tracking table (see `migrationsTable`): the
 * default `effect_sql_migrations` table is keyed by numeric id alone, so a
 * second id-1 set sharing it would be silently skipped.
 */
export const migrations: Migrator.Loader<never> = Effect.succeed([
  [
    1,
    "create_rate_limit_buckets",
    Effect.succeed(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.onDialectOrElse({
          pg: () => sql`
            CREATE TABLE IF NOT EXISTS rate_limit_buckets (
              bucket_key TEXT PRIMARY KEY,
              hit_count INTEGER NOT NULL,
              reset_at_ms DOUBLE PRECISION NOT NULL
            )`,
          sqlite: () => sql`
            CREATE TABLE IF NOT EXISTS rate_limit_buckets (
              bucket_key TEXT PRIMARY KEY,
              hit_count INTEGER NOT NULL,
              reset_at_ms INTEGER NOT NULL
            )`,
          orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
        });
      }),
    ),
  ],
]);

/** The tracking table `migrations` must run under, so it never collides with `coreMigrations`' ids. */
export const migrationsTable = "awthaq_rate_limiter_migrations";

/** `Migrator.make({})({ loader: migrations, table: migrationsTable })`, ready to run at startup. */
export const migrate = Migrator.make({})({ loader: migrations, table: migrationsTable });

const BucketRow = Schema.Struct({
  hit_count: Schema.Number,
  reset_at_ms: Schema.Number,
});

export interface StoreSqlOptions {
  /** How often expired rows are deleted. Rows are otherwise reclaimed only when their key is hit again. */
  readonly sweepInterval: Duration.Input;
}

export const layerStoreSqlWith = (options: StoreSqlOptions) =>
  Layer.effect(
    RateLimiter.RateLimiterStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const upsert = SqlSchema.findOne({
        Request: Schema.Struct({
          key: Schema.String,
          nowMs: Schema.Number,
          resetAtMs: Schema.Number,
        }),
        Result: BucketRow,
        execute: (request) => sql`
          INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at_ms)
          VALUES (${request.key}, 1, ${request.resetAtMs})
          ON CONFLICT (bucket_key) DO UPDATE SET
            hit_count = CASE
              WHEN rate_limit_buckets.reset_at_ms > ${request.nowMs}
              THEN rate_limit_buckets.hit_count + 1
              ELSE 1
            END,
            reset_at_ms = CASE
              WHEN rate_limit_buckets.reset_at_ms > ${request.nowMs}
              THEN rate_limit_buckets.reset_at_ms
              ELSE excluded.reset_at_ms
            END
          RETURNING hit_count, reset_at_ms
        `,
      });

      const increment: RateLimiter.RateLimiterStoreShape["increment"] = (key, window) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const row = yield* upsert({
            key,
            nowMs,
            resetAtMs: nowMs + Duration.toMillis(window),
          });
          return {
            count: row.hit_count,
            resetAt: DateTime.makeUnsafe(row.reset_at_ms),
          };
        }).pipe(Effect.mapError((cause) => new RateLimiter.RateLimiterStoreUnavailable({ cause })));

      const selectLive = SqlSchema.findOneOption({
        Request: Schema.Struct({ key: Schema.String, nowMs: Schema.Number }),
        Result: BucketRow,
        execute: (request) => sql`
          SELECT hit_count, reset_at_ms FROM rate_limit_buckets
          WHERE bucket_key = ${request.key} AND reset_at_ms > ${request.nowMs}
        `,
      });

      // RBS-009: a read-only look at a bucket, for escalation's block check.
      const peek: RateLimiter.RateLimiterStoreShape["peek"] = (key) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const row = yield* selectLive({ key, nowMs: DateTime.toEpochMillis(now) });
          return Option.map(row, (found) => ({
            count: found.hit_count,
            resetAt: DateTime.makeUnsafe(found.reset_at_ms),
          }));
        }).pipe(Effect.mapError((cause) => new RateLimiter.RateLimiterStoreUnavailable({ cause })));

      const sweep = Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* sql`DELETE FROM rate_limit_buckets WHERE reset_at_ms <= ${DateTime.toEpochMillis(now)}`;
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("awthaq: rate-limit bucket sweep failed", cause)),
      );
      yield* Effect.sleep(options.sweepInterval).pipe(
        Effect.andThen(sweep),
        Effect.forever,
        Effect.forkScoped,
      );

      return RateLimiter.RateLimiterStore.of({ increment, peek });
    }),
  );

/** BEH-EA-109: the shipped multi-replica store. Sweeps expired rows every minute. */
export const layerStoreSql = layerStoreSqlWith({ sweepInterval: "1 minute" });
