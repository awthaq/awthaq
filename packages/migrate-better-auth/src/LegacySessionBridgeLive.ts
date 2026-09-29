// @awthaq/migrate-better-auth — LegacySessionBridgeLive
//
// BAM-003 (.issues/high): the SQL-backed implementation of
// `@awthaq/ports`'s `LegacySessionBridge` — queries a **retained,
// read-only** better-auth database (never the live production database
// being cut over) for a still-live session matching the raw token
// `Sessions.verify` was handed. Requires only `SqlClient` — the deploying
// application supplies the concrete driver (`@effect/sql-sqlite-node`,
// `@effect/sql-pg`, ...) pointed at wherever the retained database lives,
// the same "capability over implementation" posture every other port in
// this codebase follows.
//
// better-auth's own `session` table (stable across the versions this
// schema targets — confirm against the actual deployment's migration
// history before installing this in a real cutover, per this package's
// own README): `id`, `token` (the plaintext value used directly as the
// session cookie — BAM-003's own evidence names this "a single opaque
// token"), `userId`, `ipAddress`, `userAgent`, `expiresAt`, `createdAt`,
// `updatedAt`. Every column is read by its literal, unquoted better-auth
// name — this table is never written by awthaq's own migrations, so there
// is no "keep migration and query consistent" concern the way
// `@awthaq/jwt`'s own `jwtMigrations` comment describes for a table
// awthaq itself creates.

import { LegacySessionBridge } from "@awthaq/ports";
import { Models as SqlModels } from "@awthaq/sql";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const makeBetterAuthSessionRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    userId: Schema.String,
    ipAddress: Schema.NullOr(Schema.String),
    userAgent: Schema.NullOr(Schema.String),
    expiresAt: wire.dateTime,
  });

export const layer: Layer.Layer<never, never, SqlClient.SqlClient> = Layer.effect(
  LegacySessionBridge.LegacySessionBridge,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const BetterAuthSessionRow = makeBetterAuthSessionRow(wire);

    const findByToken = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: BetterAuthSessionRow,
      execute: (token) =>
        sql`SELECT userId, ipAddress, userAgent, expiresAt FROM session WHERE token = ${token}`,
    });

    const resolve: LegacySessionBridge.LegacySessionBridgeShape["resolve"] = (rawToken) =>
      findByToken(rawToken).pipe(
        Effect.flatMap((row) =>
          Effect.gen(function* () {
            if (Option.isNone(row)) return Option.none();
            const now = yield* DateTime.now;
            // Still-live only — an already-expired better-auth session is
            // not a credential to honor, the same posture `Sessions.verify`
            // itself takes toward its own expired rows.
            if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.value.expiresAt)) {
              return Option.none();
            }
            return Option.some({
              userId: row.value.userId,
              ipAddress: Option.fromNullishOr(row.value.ipAddress),
              userAgent: Option.fromNullishOr(row.value.userAgent),
            });
          }),
        ),
        Effect.orElseSucceed(() => Option.none()),
      );

    const consume: LegacySessionBridge.LegacySessionBridgeShape["consume"] = (rawToken) =>
      sql`DELETE FROM session WHERE token = ${rawToken}`.pipe(
        Effect.orElseSucceed(() => undefined),
      );

    return LegacySessionBridge.LegacySessionBridge.of({ resolve, consume });
  }),
);
