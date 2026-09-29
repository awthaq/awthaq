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
import { AuditChain, Migrations, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Admin from "../src/Admin.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const ChainLive = AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer));

const MemoryLayer = ImpersonationRecords.layerMemory.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(ChainLive),
);

const SqlLive = TestSql.layer("admin_ImpersonationRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Admin.Admin.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = ImpersonationRecords.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(ChainLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const adminId = Users.UserId("admin-1");
const targetId = Users.UserId("target-1");

/** IDS-004: every row records its hard expiry; a generous default keeps unrelated tests unaffected. */
const farFuture = Effect.map(DateTime.now, (now) => DateTime.addDuration(now, Duration.days(1)));

const seed = (
  records: ImpersonationRecords.ImpersonationRecordsShape,
  sessionId: string,
  reason = "test",
) =>
  Effect.flatMap(farFuture, (expiresAt) =>
    records.create({ adminUserId: adminId, targetUserId: targetId, sessionId, reason, expiresAt }),
  );

const suite = (
  name: string,
  layer: Layer.Layer<ImpersonationRecords.ImpersonationRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("create then findBySessionId round-trips every field", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const expiresAt = DateTime.addDuration(yield* DateTime.now, Duration.hours(1));
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "session-1",
          reason: "reproducing a bug report",
          expiresAt,
        });
        const found = yield* records.findBySessionId("session-1");
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.strictEqual(found.value.adminUserId, adminId);
          assert.strictEqual(found.value.targetUserId, targetId);
          assert.strictEqual(found.value.reason, "reproducing a bug report");
          assert.isTrue(Option.isNone(found.value.endedAt));
          assert.isTrue(Option.isNone(found.value.endedBy));
          assert.deepStrictEqual(found.value.expiresAt, Option.some(expiresAt));
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
        yield* seed(records, "session-end");
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
        yield* seed(records, "session-older", "first");
        yield* TestClock.adjust(Duration.millis(1));
        yield* seed(records, "session-newer", "second");
        yield* records.endEpisode("session-older", "forcedByAdmin");

        const all = (yield* records.list()).items;
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all[0]?.sessionId, "session-newer");
        assert.strictEqual(all[1]?.sessionId, "session-older");

        const active = (yield* records.list({ active: true })).items;
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0]?.sessionId, "session-newer");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("ESS-006: list pages newest-first with a stable cursor across equal startedAt", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        // Five rows at the same (test-clock) instant: only the id tiebreak orders them.
        for (const n of [1, 2, 3, 4, 5]) yield* seed(records, `session-${n}`);

        const seen: Array<string> = [];
        let cursor: ImpersonationRecords.ImpersonationCursor | undefined = undefined;
        let pages = 0;
        for (;;) {
          const page: ImpersonationRecords.ImpersonationPage = yield* records.list({
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
          });
          pages++;
          assert.isAtMost(page.items.length, 2);
          seen.push(...page.items.map((row) => row.sessionId));
          if (Option.isNone(page.nextCursor)) break;
          cursor = page.nextCursor.value;
        }
        assert.strictEqual(pages, 3);
        assert.strictEqual(new Set(seen).size, 5);
        assert.deepStrictEqual(
          [...seen].sort(),
          [1, 2, 3, 4, 5].map((n) => `session-${n}`),
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "ESS-006: the last page carries no cursor and an exact-limit page does not invent one",
      () =>
        Effect.gen(function* () {
          const records = yield* ImpersonationRecords.ImpersonationRecords;
          yield* seed(records, "session-a");
          yield* seed(records, "session-b");
          const page = yield* records.list({ limit: 2 });
          assert.strictEqual(page.items.length, 2);
          assert.isTrue(Option.isNone(page.nextCursor));
        }).pipe(Effect.provide(layer)),
    );

    it.effect("IDS-004: closeExpired closes only past-expiry open episodes, once, as expired", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        const start = yield* DateTime.now;
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "short",
          reason: "short",
          expiresAt: DateTime.addDuration(start, Duration.minutes(10)),
        });
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "long",
          reason: "long",
          expiresAt: DateTime.addDuration(start, Duration.hours(5)),
        });
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "already-ended",
          reason: "ended",
          expiresAt: DateTime.addDuration(start, Duration.minutes(5)),
        });
        yield* records.endEpisode("already-ended", "self");

        yield* TestClock.adjust(Duration.hours(1));
        const closed = yield* records.closeExpired(yield* DateTime.now);
        assert.deepStrictEqual(
          closed.map((row) => row.sessionId),
          ["short"],
        );
        assert.deepStrictEqual(closed[0]?.endedBy, Option.some("expired"));
        assert.deepStrictEqual(
          closed[0]?.endedAt,
          Option.some(DateTime.addDuration(start, Duration.minutes(10))),
        );

        const again = yield* records.closeExpired(yield* DateTime.now);
        assert.strictEqual(again.length, 0);

        const short = yield* records.findBySessionId("short");
        assert.isTrue(Option.isSome(short) && Option.isSome(short.value.endedAt));
        const long = yield* records.findBySessionId("long");
        assert.isTrue(Option.isSome(long) && Option.isNone(long.value.endedAt));
        // An episode ended by another path keeps its original outcome.
        const ended = yield* records.findBySessionId("already-ended");
        assert.isTrue(Option.isSome(ended));
        if (Option.isSome(ended)) assert.deepStrictEqual(ended.value.endedBy, Option.some("self"));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("ALF-005: verifyChain is clean across create, end, close-expired and list", () =>
      Effect.gen(function* () {
        const records = yield* ImpersonationRecords.ImpersonationRecords;
        assert.isTrue(Option.isNone(yield* records.verifyChain));
        const start = yield* DateTime.now;
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "s-self",
          reason: "one",
          expiresAt: DateTime.addDuration(start, Duration.hours(5)),
        });
        yield* records.create({
          adminUserId: adminId,
          targetUserId: targetId,
          sessionId: "s-expiring",
          reason: "two",
          expiresAt: DateTime.addDuration(start, Duration.minutes(1)),
        });
        yield* records.endEpisode("s-self", "self");
        yield* TestClock.adjust(Duration.minutes(2));
        yield* records.closeExpired(yield* DateTime.now);
        assert.isTrue(Option.isNone(yield* records.verifyChain));
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("ImpersonationRecords (layerMemory)", MemoryLayer);
suite("ImpersonationRecords (layerSql)", SqlLayer);

/**
 * ALF-005: the database itself refuses the casual rewrite, and the hash chain makes a
 * forger who bypasses the triggers (a DBA, `DROP TRIGGER`) detectable. Runs on SQLite and, with
 * `AWTHAQ_POSTGRES_URL` (`pnpm run test:pg`), on Postgres, whose plpgsql triggers ship in the same
 * migration.
 */
describe("ALF-005 tamper evidence (layerSql)", () => {
  /** A `SqlError` wraps the driver's own error; the trigger's message lives a few `cause`s down. */
  const rejection = (error: unknown): string => {
    const messages: Array<string> = [];
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(" | ");
  };

  /** What a DBA bypassing the triggers does. Postgres has one guard trigger per table, SQLite one per rule. */
  const dropTrigger = (sqlite: string, pg: { readonly name: string; readonly table: string }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql.unsafe(`DROP TRIGGER IF EXISTS ${pg.name} ON ${pg.table}`),
        orElse: () => sql.unsafe(`DROP TRIGGER ${sqlite}`),
      });
    });

  const seedTwo = Effect.gen(function* () {
    const records = yield* ImpersonationRecords.ImpersonationRecords;
    const first = yield* seed(records, "session-a", "first");
    yield* TestClock.adjust(Duration.millis(1));
    const second = yield* seed(records, "session-b", "second");
    yield* records.endEpisode("session-a", "self");
    return { records, first, second };
  });

  it.effect("a raw UPDATE of an immutable column is rejected by the trigger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { first } = yield* seedTwo;
      const failure =
        yield* sql`UPDATE admin_impersonation SET reason = 'forged' WHERE id = ${first.id}`.pipe(
          Effect.flip,
        );
      assert.include(rejection(failure), "append-only");
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("a raw DELETE is rejected by the trigger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { first } = yield* seedTwo;
      const failure = yield* sql`DELETE FROM admin_impersonation WHERE id = ${first.id}`.pipe(
        Effect.flip,
      );
      assert.include(rejection(failure), "append-only");
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("an ended episode's endedAt/endedBy can no longer be rewritten", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { first } = yield* seedTwo;
      const failure =
        yield* sql`UPDATE admin_impersonation SET "endedBy" = 'expired' WHERE id = ${first.id}`.pipe(
          Effect.flip,
        );
      assert.include(rejection(failure), "append-only");
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("the chain ledger itself rejects UPDATE and DELETE", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedTwo;
      const update = yield* sql`UPDATE admin_impersonation_chain SET payload = 'x'`.pipe(
        Effect.flip,
      );
      assert.include(rejection(update), "append-only");
      const remove = yield* sql`DELETE FROM admin_impersonation_chain`.pipe(Effect.flip);
      assert.include(rejection(remove), "append-only");
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect(
    "verifyChain detects a row rewritten with the triggers disabled, naming the episode",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { records, second } = yield* seedTwo;
        assert.isTrue(Option.isNone(yield* records.verifyChain));

        yield* dropTrigger("admin_impersonation_immutable", {
          name: "admin_impersonation_guard",
          table: "admin_impersonation",
        });
        yield* sql`UPDATE admin_impersonation SET reason = 'forged' WHERE id = ${second.id}`;

        const broken = yield* records.verifyChain;
        assert.isTrue(Option.isSome(broken));
        if (Option.isSome(broken)) {
          assert.strictEqual(broken.value.episodeId, second.id);
          assert.strictEqual(broken.value.reason, "row-mismatch");
          // `second` was the second link written (`first`'s start, `second`'s start, `first`'s end).
          assert.deepStrictEqual(broken.value.seq, Option.some(2));
        }
      }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("verifyChain detects a deleted episode row and a rewritten ledger entry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { records, first, second } = yield* seedTwo;

      yield* dropTrigger("admin_impersonation_no_delete", {
        name: "admin_impersonation_guard",
        table: "admin_impersonation",
      });
      yield* sql`DELETE FROM admin_impersonation WHERE id = ${second.id}`;
      const missing = yield* records.verifyChain;
      assert.isTrue(Option.isSome(missing));
      if (Option.isSome(missing)) {
        assert.strictEqual(missing.value.episodeId, second.id);
        assert.strictEqual(missing.value.reason, "row-missing");
      }

      yield* dropTrigger("admin_impersonation_chain_no_update", {
        name: "admin_impersonation_chain_guard",
        table: "admin_impersonation_chain",
      });
      yield* sql`UPDATE admin_impersonation_chain SET payload = 'forged' WHERE "episodeId" = ${first.id} AND kind = 'started'`;
      const ledger = yield* records.verifyChain;
      assert.isTrue(Option.isSome(ledger));
      if (Option.isSome(ledger)) {
        assert.strictEqual(ledger.value.reason, "chain-broken");
        assert.deepStrictEqual(ledger.value.seq, Option.some(1));
        assert.strictEqual(ledger.value.episodeId, first.id);
      }
    }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect("a row inserted straight into the table with no ledger link is reported", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { records } = yield* seedTwo;
      yield* sql`INSERT INTO admin_impersonation (id, "adminUserId", "targetUserId", "sessionId", reason, "startedAt", "expiresAt", "endedAt", "endedBy")
        VALUES ('smuggled', 'a', 'b', 'session-x', 'r', '1970-01-01T00:00:00.000Z', NULL, NULL, NULL)`;
      const broken = yield* records.verifyChain;
      assert.isTrue(Option.isSome(broken));
      if (Option.isSome(broken)) {
        assert.strictEqual(broken.value.episodeId, "smuggled");
        assert.strictEqual(broken.value.reason, "row-unledgered");
        assert.isTrue(Option.isNone(broken.value.seq));
      }
    }).pipe(Effect.provide(SqlLayer)),
  );
});
