// TIR-001/TRBS-001/MAPS-002 —
// .scratch/resolve-ready-for-human-findings/issues/11-token-lifecycle-store.md.
// The same contract suite runs against `layerMemory` and `layerSql`,
// mirroring `KeyRing.test.ts`. `layerSql` here is migrated via `Jwt.Jwt`'s
// own real `migrations` (`Migrations.run`, `@awthaq/core`) rather than a
// hand-rolled inline `CREATE TABLE` — genuine end-to-end proof that this
// plugin's first-ever declared migrations actually produce a working
// schema for both `jwt_signing_key` and `jwt_token_revocation`.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Jwt from "../src/Jwt.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("jwt_RevocationStore");

const Migrated = Layer.effectDiscard(Migrations.run(Jwt.Jwt.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlStore = RevocationStore.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (
  name: string,
  StoreLayer: Layer.Layer<RevocationStore.RevocationStore, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("isRevoked is false for a jti never revoked", () =>
      Effect.gen(function* () {
        const store = yield* RevocationStore.RevocationStore;
        assert.isFalse(yield* store.isRevoked("never-revoked"));
      }).pipe(Effect.provide(StoreLayer)),
    );

    it.effect("isRevoked is true immediately after revoke, for the exact jti only", () =>
      Effect.gen(function* () {
        const store = yield* RevocationStore.RevocationStore;
        const now = yield* DateTime.now;
        yield* store.revoke("jti-a", DateTime.addDuration(now, Duration.hours(1)));

        assert.isTrue(yield* store.isRevoked("jti-a"));
        assert.isFalse(yield* store.isRevoked("jti-b"));
      }).pipe(Effect.provide(StoreLayer)),
    );

    it.effect(
      "a revocation entry self-prunes on read once past its own expiresAt (lazy expiry)",
      () =>
        Effect.gen(function* () {
          const store = yield* RevocationStore.RevocationStore;
          const now = yield* DateTime.now;
          yield* store.revoke("jti-c", DateTime.addDuration(now, Duration.minutes(5)));
          assert.isTrue(yield* store.isRevoked("jti-c"));

          yield* TestClock.adjust(Duration.minutes(6));
          assert.isFalse(yield* store.isRevoked("jti-c"));
        }).pipe(Effect.provide(StoreLayer)),
    );

    it.effect("revoke is idempotent — revoking the same jti twice keeps it revoked", () =>
      Effect.gen(function* () {
        const store = yield* RevocationStore.RevocationStore;
        const now = yield* DateTime.now;
        yield* store.revoke("jti-d", DateTime.addDuration(now, Duration.hours(1)));
        yield* store.revoke("jti-d", DateTime.addDuration(now, Duration.hours(2)));
        assert.isTrue(yield* store.isRevoked("jti-d"));
      }).pipe(Effect.provide(StoreLayer)),
    );
  });
};

suite("layerMemory", RevocationStore.layerMemory);
suite("layerSql (migrated via Jwt.Jwt.migrations)", SqlStore);

// TIR-001/TRBS-001/MAPS-002 — no production migration existed anywhere for
// `jwt_signing_key` before this ticket (only `KeyRing.test.ts`'s own inline
// ad hoc `CREATE TABLE`); confirms `Jwt.Jwt.migrations` alone, run fresh,
// stands up both of this plugin's tables from nothing.
describe("Jwt.Jwt.migrations", () => {
  it.effect("creates both jwt_signing_key and jwt_token_revocation from a fresh database", () =>
    Effect.gen(function* () {
      const applied = yield* Migrations.run(Jwt.Jwt.migrations);
      assert.strictEqual(applied.length, 4);
      const sql = yield* SqlClient.SqlClient;
      // A working `SELECT` against each table is the real proof — a
      // missing table fails the query itself, not merely the migration
      // runner's own bookkeeping.
      yield* sql`SELECT * FROM jwt_signing_key`;
      yield* sql`SELECT * FROM jwt_token_revocation`;
    }).pipe(Effect.provide(SqlLive)),
  );

  // SSMS-001: `findCurrent`'s `WHERE rotatedAt IS NULL` scan needs a real
  // index behind it, not just a migration that runs without error —
  // querying sqlite's own catalog is what proves the index exists (a
  // typo in the `CREATE INDEX` DDL would still let the migration "pass").
  it.effect("creates a partial index on jwt_signing_key for the active-key lookup", () =>
    Effect.gen(function* () {
      yield* Migrations.run(Jwt.Jwt.migrations);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.onDialectOrElse({
        pg: () => sql<{ readonly name: string }>`
          SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname = 'jwt_signing_key_active_idx'`,
        orElse: () => sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jwt_signing_key_active_idx'`,
      });
      assert.strictEqual(rows.length, 1);
    }).pipe(Effect.provide(SqlLive)),
  );
});
