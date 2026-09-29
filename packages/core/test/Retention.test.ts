// CSG-003/ALF-010 (wayfinder ticket 30, ADR-EA-033): the retention sweep.
//
// One suite, run over memory and over SQLite (migrated by `@awthaq/sql`'s own
// `CoreMigrations`). Time is `TestClock`'s: rows are created at the epoch and the clock is
// moved forward, so "older than the grace" is exact and no test waits.
import { SqlTransaction } from "@awthaq/ports";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Retention from "../src/Retention.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";
import * as Verification from "../src/Verification.ts";

const alice = Users.UserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

const MemoryLayer = Layer.mergeAll(Sessions.layerMemory, Verification.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = Layer.mergeAll(
  Sessions.layerSql.pipe(Layer.provide(Repositories.SessionsRepositoryLive)),
  Verification.layerSql.pipe(
    Layer.provide(
      Layer.mergeAll(
        Repositories.VerificationRepositoryLive,
        Repositories.VerificationReservationsRepositoryLive,
      ),
    ),
  ),
  SqlTransaction.layerSql,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerSql.pipe(Layer.provide(Repositories.AuditLogRepositoryLive))),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const days = (n: number) => Duration.days(n);

const suite = (
  name: string,
  layer: Layer.Layer<
    Sessions.Sessions | Verification.Verification | AuditLog.AuditLog | AuthEvents.AuthEvents,
    unknown
  >,
) =>
  describe(name, () => {
    it.effect(
      "deletes sessions past absoluteExpiresAt + sessionGrace and keeps live and recent ones",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const gone = yield* sessions.issue({
            userId: alice,
            absoluteDuration: Duration.hours(1),
          });

          // Expired 2 days ago, well inside the 7-day grace: kept.
          yield* TestClock.adjust(Duration.hours(1).pipe(Duration.sum(days(2))));
          assert.deepStrictEqual(yield* Retention.sweep, {
            sessionsDeleted: 0,
            verificationRowsDeleted: 0,
            auditRowsDeleted: 0,
          });

          // Now expired 8 days ago: gone; the live one is untouched.
          yield* TestClock.adjust(days(6));
          const longLived = yield* sessions.issue({ userId: alice });
          const report = yield* Retention.sweep;
          assert.strictEqual(report.sessionsDeleted, 1);
          assert.strictEqual((yield* Retention.sweep).sessionsDeleted, 0);
          assert.isTrue(Option.isNone(yield* sessions.findOwned(alice, gone.session.id)));
          assert.isTrue(Option.isSome(yield* sessions.findOwned(alice, longLived.session.id)));
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "deletes expired verification tokens and reservations past the forensic window, keeps live and recent ones",
      () =>
        Effect.gen(function* () {
          const verification = yield* Verification.Verification;
          yield* verification.issue({ identifier: "old-token", ttl: Duration.hours(1) });
          yield* verification.reserve({ identifier: "old-reservation", ttl: Duration.hours(1) });

          // 30 days: expired, but inside the 90-day forensic window.
          yield* TestClock.adjust(days(30));
          assert.strictEqual((yield* Retention.sweep).verificationRowsDeleted, 0);

          // 91 days on: the old rows are past it; a token issued now is live.
          yield* TestClock.adjust(days(61));
          const fresh = yield* verification.issue({ identifier: "fresh", ttl: Duration.hours(1) });
          const report = yield* Retention.sweep;
          assert.strictEqual(report.verificationRowsDeleted, 2);
          assert.strictEqual((yield* Retention.sweep).verificationRowsDeleted, 0);
          yield* verification.consume("fresh", fresh.value);
        }).pipe(Effect.provide(layer)),
    );

    it.effect("audit rows are kept for ever unless a window is configured", () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        yield* events.publish({ _tag: "auth.token.replay", identifier: "a" });
        yield* TestClock.adjust(days(3650));
        assert.strictEqual((yield* Retention.sweep).auditRowsDeleted, 0);
        assert.strictEqual((yield* auditLog.list()).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "a per-tag window purges only that tag; a default window covers every other tag",
      () =>
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          const auditLog = yield* AuditLog.AuditLog;
          const publishBoth = Effect.all([
            events.publish({ _tag: "auth.token.replay", identifier: "a" }),
            events.publish({ _tag: "auth.user.emailVerified", userId: alice }),
          ]);
          const tags = Effect.map(auditLog.list(), (rows) =>
            rows.map((row) => row.eventTag).sort(),
          );

          yield* publishBoth;
          yield* TestClock.adjust(days(100));

          // Only `auth.token.replay` has a 90-day window; no default: the other tag stays.
          const perTag = yield* Retention.sweep.pipe(
            Effect.provide(
              Retention.config({
                auditLog: {
                  default: Option.none(),
                  rules: [{ tags: ["auth.token.replay"], keepFor: days(90) }],
                },
              }),
            ),
          );
          assert.strictEqual(perTag.auditRowsDeleted, 1);
          assert.deepStrictEqual(yield* tags, ["auth.user.emailVerified"]);

          // A one-year default with a longer window for the tag left over: still kept at day 100...
          const withDefault = Retention.config({
            auditLog: {
              default: Option.some(days(365)),
              rules: [{ tags: ["auth.user.emailVerified"], keepFor: days(30) }],
            },
          });
          // ...but the tag's own 30-day rule wins over the default and purges it.
          assert.strictEqual(
            (yield* Retention.sweep.pipe(Effect.provide(withDefault))).auditRowsDeleted,
            1,
          );
          assert.deepStrictEqual(yield* tags, []);

          // And the default alone reaches every tag no rule names, without touching a named one.
          yield* publishBoth;
          yield* TestClock.adjust(days(400));
          const onlyDefault = yield* Retention.sweep.pipe(
            Effect.provide(
              Retention.config({
                auditLog: {
                  default: Option.some(days(365)),
                  rules: [{ tags: ["auth.user.emailVerified"], keepFor: days(10_000) }],
                },
              }),
            ),
          );
          assert.strictEqual(onlyDefault.auditRowsDeleted, 1);
          assert.deepStrictEqual(yield* tags, ["auth.user.emailVerified"]);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "layerScheduled sweeps at start-up and on every interval, and is inert unless provided",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const verification = yield* Verification.Verification;
          yield* sessions.issue({ userId: alice, absoluteDuration: Duration.hours(1) });
          yield* verification.issue({ identifier: "t", ttl: Duration.hours(1) });

          // Not provided yet: even a long time later, nothing has been swept.
          yield* TestClock.adjust(days(200));
          const graceCutoff = (window: Duration.Duration) =>
            Effect.map(DateTime.now, (now) => DateTime.subtractDuration(now, window));
          assert.strictEqual(
            yield* Effect.flatMap(graceCutoff(days(7)), (before) =>
              sessions.purgeExpired(before),
            ).pipe(Effect.map((n) => n > 0)),
            true,
          );
          yield* sessions.issue({ userId: alice, absoluteDuration: Duration.hours(1) });

          // Provided: the first sweep happens at start, later ones each `sweepInterval`.
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Layer.build(Retention.layerScheduled);
              yield* Effect.yieldNow;
              yield* TestClock.adjust(days(8));
              yield* Effect.yieldNow;
              yield* TestClock.adjust(days(1));
              yield* Effect.yieldNow;
            }).pipe(Effect.provide(Retention.config({ sweepInterval: days(1) }))),
          );
          const cutoff = yield* graceCutoff(days(7));
          assert.strictEqual(yield* sessions.purgeExpired(cutoff), 0);
        }).pipe(Effect.provide(layer)),
    );
  });

suite("Retention over memory", MemoryLayer);
suite("Retention over SQLite", SqlLayer);

describe("Retention over SQLite: rows are physically gone", () => {
  it.effect("sweep leaves no expired session, token, reservation or audit row in the tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      yield* sessions.issue({ userId: alice, absoluteDuration: Duration.hours(1) });
      const consumed = yield* verification.issue({ identifier: "used", ttl: Duration.hours(1) });
      yield* verification.consume("used", consumed.value);
      yield* verification.issue({ identifier: "lapsed", ttl: Duration.hours(1) });
      yield* verification.reserve({ identifier: "r", ttl: Duration.hours(1) });
      yield* events.publish({ _tag: "auth.token.replay", identifier: "x" });

      const count = (table: string) =>
        Effect.map(
          sql.unsafe<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`),
          (rows) => rows[0]?.n ?? -1,
        );
      assert.deepStrictEqual(
        [
          yield* count("sessions"),
          yield* count("verification_tokens"),
          yield* count("verification_reservations"),
        ],
        [1, 2, 1],
      );

      yield* TestClock.adjust(days(100));
      // The consumed row (consumedAt at the epoch), the lapsed token and the reservation all count.
      const report = yield* Retention.sweep;
      assert.strictEqual(report.sessionsDeleted, 1);
      assert.strictEqual(report.verificationRowsDeleted, 3);
      assert.deepStrictEqual(
        [
          yield* count("sessions"),
          yield* count("verification_tokens"),
          yield* count("verification_reservations"),
        ],
        [0, 0, 0],
      );
    }).pipe(Effect.provide(SqlLayer)),
  );
});
