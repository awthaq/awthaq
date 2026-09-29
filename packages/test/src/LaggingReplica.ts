// @awthaq/test — LaggingReplica
//
// RRC-008: a read replica whose lag the test controls. `@awthaq/sql`'s
// `ReadRouting` sends only display/history listings to a replica and holds a
// fiber that just wrote to the primary (a causal token, read-your-writes);
// proving that needs a replica that is *behind*, on demand, without a
// Postgres streaming setup. This is a second, ordinary `SqlClient` (any
// driver — pass an in-memory SQLite client) that only ever changes when the
// test calls `catchUp`, plus a `ReplicationPosition` that counts primary
// writes and replica catch-ups instead of reading Postgres LSNs.
//
//   const lag = yield* LaggingReplica.make({ replica });
//   … Layer.provide(lag.layer) below the repositories …
//   yield* write;               // primary moves ahead; the replica is stale
//   yield* lag.catchUp;         // the replica has now applied everything
//
// The replica must already have the schema (run the same migrations on it);
// `catchUp` copies each listed table's rows from the primary, replacing the
// replica's copy.

import { ReadRouting } from "@awthaq/sql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The core tables `@awthaq/sql`'s `CoreMigrations` creates. */
export const coreTables: ReadonlyArray<string> = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "verification_reservations",
  "auth_audit_log",
];

export interface LaggingReplica {
  /** The replica client itself, for direct inspection in a test. */
  readonly replica: SqlClient.SqlClient;
  /** Applies everything the primary has committed so far to the replica, and advances its replay position. */
  readonly catchUp: Effect.Effect<void, unknown>;
  /** Provides `ReadRouting.ReplicaSqlClient` and this replica's `ReplicationPosition`; put it below the repositories. */
  readonly layer: Layer.Layer<never>;
}

const causalToken = Schema.decodeUnknownSync(ReadRouting.CausalToken);

/** Needs the primary `SqlClient` in context; `replica` is a separate client (a separate database). */
export const make = (options: {
  readonly replica: SqlClient.SqlClient;
  readonly tables?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const primary = yield* SqlClient.SqlClient;
    const replica = options.replica;
    const tables = options.tables ?? coreTables;
    const written = yield* Ref.make(0);
    const replayed = yield* Ref.make(0);

    const catchUp = Effect.gen(function* () {
      // Snapshot the counter first: a write racing the copy must not be marked replayed.
      const upTo = yield* Ref.get(written);
      for (const table of tables) {
        const rows = yield* primary`SELECT * FROM ${primary(table)}`;
        yield* replica`DELETE FROM ${replica(table)}`;
        if (rows.length > 0) {
          yield* replica`INSERT INTO ${replica(table)} ${replica.insert(rows)}`;
        }
      }
      yield* Ref.set(replayed, upTo);
    });

    const position: ReadRouting.ReplicationPositionShape = {
      // Every capture is a new position: the write that just committed.
      current: () =>
        Ref.updateAndGet(written, (n) => n + 1).pipe(
          Effect.map((n) => Option.some(causalToken(String(n)))),
        ),
      hasReplayed: (_replica, token) =>
        Ref.get(replayed).pipe(Effect.map((n) => n >= Number(token))),
    };

    const lagging: LaggingReplica = {
      replica,
      catchUp,
      layer: Layer.mergeAll(
        Layer.succeed(ReadRouting.ReplicaSqlClient, Option.some(replica)),
        Layer.succeed(ReadRouting.ReplicationPosition, position),
      ),
    };
    return lagging;
  });
