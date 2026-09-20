// BAM-003 (.issues/high): proves `LegacySessionBridgeLive` genuinely reads
// a better-auth-shaped `session` table over a real SQLite database (a
// stand-in for the retained, read-only better-auth database a real
// cutover points this at) — a still-live row resolves, an expired row
// does not, and `consume` makes a resolved token single-use.
import { LegacySessionBridge } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as LegacySessionBridgeLive from "../src/LegacySessionBridgeLive.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// `it.effect`'s ambient `TestClock` starts at the Unix epoch (1970-01-01),
// not real wall-clock time — `expiresAt` values below are chosen relative
// to that, not to today's date.
const Seeded = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // better-auth's own `session` table shape — this package never
    // migrates it, only reads it, so column names match better-auth's
    // literal convention rather than this codebase's own.
    yield* sql`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        ipAddress TEXT,
        userAgent TEXT,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `;
    yield* sql`
      INSERT INTO session (id, token, userId, ipAddress, userAgent, expiresAt, createdAt, updatedAt)
      VALUES ('sess-1', 'still-live-token', 'user-42', '198.51.100.7', 'ba-client/1.0', '2999-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO session (id, token, userId, ipAddress, userAgent, expiresAt, createdAt, updatedAt)
      VALUES ('sess-2', 'expired-token', 'user-99', NULL, NULL, '1960-01-01T00:00:00.000Z', '1959-01-01T00:00:00.000Z', '1959-01-01T00:00:00.000Z')
    `;
  }),
).pipe(Layer.provide(SqlLive));

const BridgeLayer = LegacySessionBridgeLive.layer.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Seeded),
);

describe("LegacySessionBridgeLive", () => {
  it.effect("resolves a still-live session by its exact token", () =>
    Effect.gen(function* () {
      const bridge = yield* LegacySessionBridge.LegacySessionBridge;
      const resolved = yield* bridge.resolve("still-live-token");
      assert.isTrue(Option.isSome(resolved));
      if (Option.isSome(resolved)) {
        assert.strictEqual(resolved.value.userId, "user-42");
        assert.deepStrictEqual(resolved.value.ipAddress, Option.some("198.51.100.7"));
        assert.deepStrictEqual(resolved.value.userAgent, Option.some("ba-client/1.0"));
      }
    }).pipe(Effect.provide(BridgeLayer)),
  );

  it.effect("does not resolve an already-expired session", () =>
    Effect.gen(function* () {
      const bridge = yield* LegacySessionBridge.LegacySessionBridge;
      const resolved = yield* bridge.resolve("expired-token");
      assert.isTrue(Option.isNone(resolved));
    }).pipe(Effect.provide(BridgeLayer)),
  );

  it.effect("does not resolve an unrecognized token", () =>
    Effect.gen(function* () {
      const bridge = yield* LegacySessionBridge.LegacySessionBridge;
      const resolved = yield* bridge.resolve("never-issued-token");
      assert.isTrue(Option.isNone(resolved));
    }).pipe(Effect.provide(BridgeLayer)),
  );

  it.effect("consume deletes the row, making the token single-use", () =>
    Effect.gen(function* () {
      const bridge = yield* LegacySessionBridge.LegacySessionBridge;
      yield* bridge.consume("still-live-token");
      const resolvedAfter = yield* bridge.resolve("still-live-token");
      assert.isTrue(Option.isNone(resolvedAfter));
    }).pipe(Effect.provide(BridgeLayer)),
  );
});
