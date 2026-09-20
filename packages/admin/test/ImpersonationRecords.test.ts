// spec/behaviors/27-admin-impersonation.md, BEH-EA-215/219.
//
// The same contract suite runs against `layerMemory` and `layerSql` — the
// same pattern `packages/passkey/test/PasskeyCredentials.test.ts` uses for
// its own two `Layer`s. `layerSql` here is migrated via `Admin.Admin`'s own
// real `migrations` (`Migrations.run`, `@awthaq/core`) rather than a
// hand-rolled inline `CREATE TABLE` — the same BAM-002 (.issues/high)
// verification `packages/jwt/test/RevocationStore.test.ts` establishes:
// genuine end-to-end proof that this plugin's own declared migrations
// produce a working schema.
import { Migrations, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const MemoryLayer = ImpersonationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(Migrations.run(Admin.Admin.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ImpersonationRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const adminId = Users.UserId("admin-1");
const targetId = Users.UserId("target-1");

const suite = (
  name: string,
  layer: Layer.Layer<ImpersonationRecords.ImpersonationRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findBySessionId round-trips every field", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "session-1",
          reason: "reproducing a bug report",
        });
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.adminUserId, adminId);
          assert.strictEqual(found.value.targetUserId, targetId);
          assert.strictEqual(found.value.reason, "reproducing a bug report");
          assert.isTrue(Option.isNone(found.value.endedAt));
          assert.isTrue(Option.isNone(found.value.endedBy));
        }
      }).pipe(Effect.provide(layer)),
    );

    it.effect("findBySessionId returns None for an unknown session id", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const found = yield* records.findBySessionId("does-not-exist");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("endEpisode sets endedAt/endedBy exactly once", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "session-end",
          reason: "test",
        });
        const ended = yield* records.endEpisode("session-end", "self");
        assert.isTrue(Option.isSome(ended.endedAt));
        assert.deepStrictEqual(ended.endedBy, Option.some("self"));

        const second = yield* records.endEpisode("session-end", "forcedByAdmin").pipe(Effect.flip);
        assert.strictEqual(second._tag, "ImpersonationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("endEpisode fails for an unknown session id", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const failure = yield* records.endEpisode("does-not-exist", "self").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ImpersonationRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list returns full history newest-first, and active-only excludes ended rows", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "session-older",
          reason: "first",
        });
        yield* TestClock.adjust(Duration.millis(1));
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "session-newer",
          reason: "second",
        });
        yield* records.endEpisode("session-older", "expired");

        const all = yield* records.list();
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all[0]?.sessionId, "session-newer");
        assert.strictEqual(all[1]?.sessionId, "session-older");

        const active = yield* records.list({ active: true });
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0]?.sessionId, "session-newer");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ImpersonationRecords (layerMemory)", MemoryLayer);
suite("ImpersonationRecords (layerSql)", SqlLayer);
