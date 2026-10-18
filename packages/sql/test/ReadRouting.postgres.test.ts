// RRC-001 (plan 16, moved from the repository Postgres suite): the default `ReplicationPosition`
// speaks Postgres LSNs. The "replica" here is the primary itself (there is no streaming replica in
// this environment), which is never in recovery, so `pg_last_wal_replay_lsn()` is NULL and it can
// never prove it caught up — exactly the safe direction.
//
// Skips (not fails) without `AWTHAQ_POSTGRES_URL`.
import { SessionStore } from "@awthaq/ports";
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as ReadRouting from "../src/ReadRouting.ts";
import * as SessionStoreSql from "../src/SessionStoreSql.ts";

const postgresUrl = process.env["AWTHAQ_POSTGRES_URL"];

const skip = postgresUrl === undefined;

// Its own schema: parallel files must not share `public`.
const schema = "t_sql_read_routing_postgres";
const SqlLive = PgClient.layer({
  url: Redacted.make(postgresUrl ?? ""),
  startupParameters: { search_path: schema },
});

const SessionsLive = SessionStoreSql.layer.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        yield* sql.unsafe(`CREATE SCHEMA ${schema}`);
        yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
      }),
    ).pipe(Layer.provide(SqlLive)),
  ),
);

describe.skipIf(skip)("ReadRouting (real Postgres)", () => {
  it.effect(
    "captureToken reads a real LSN after a session write; an eventual read then pins the primary",
    () =>
      Effect.gen(function* () {
        const replicaLive = ReadRouting.replica(SqlLive);
        const sessions = yield* SessionStore.SessionStore;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { hours: 1 });
        const inFiber = Effect.gen(function* () {
          const router = yield* ReadRouting.makeRouter;
          assert.strictEqual(yield* router.target("eventual"), "replica"); // no token yet
          // `SessionStore.insert` captures the causal token itself (ADR-EA-024).
          yield* sessions.insert({
            session: {
              id: Schema.decodeUnknownSync(Models.SessionId)("lsn-session"),
              userId: Schema.decodeUnknownSync(Models.UserId)("lsn-user"),
              secretHash: "h",
              at: now,
              absoluteExpiresAt: later,
              idleExpiresAt: later,
              ipAddress: Option.none(),
              userAgent: Option.none(),
              actingAs: Option.none(),
              amr: [],
            },
            supersedes: Option.none(),
            maxLive: Option.none(),
          });
          const token = yield* ReadRouting.CurrentCausalToken;
          assert.isTrue(Option.isSome(token));
          assert.match(Option.getOrThrow(token), /^[0-9A-F]+\/[0-9A-F]+$/);
          assert.strictEqual(yield* router.target("eventual"), "primary");
          assert.strictEqual(yield* router.target("authoritative"), "primary");
        });
        yield* inFiber.pipe(
          Effect.provideService(ReadRouting.CurrentCausalToken, Option.none()),
          Effect.provide(replicaLive),
        );
      }).pipe(Effect.provide(SessionsLive)),
  );
});
