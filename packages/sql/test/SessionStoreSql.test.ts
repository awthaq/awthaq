// Plan 02 / plan 16: what only the SQL adapter of `SessionStore` can show. What every adapter must do is
// `StoreContract.sessions` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); this is the adapter's retry of a busy write, the rollback of a supersede whose insert
// fails, the statements it will not retry, and the failure mapping, all injected at the SQL client
// (`FaultySql`), plus the query plan the device list relies on.
import { SessionStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LockTimeoutError, UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as SessionStoreSql from "../src/SessionStoreSql.ts";
import * as FaultySql from "./support/FaultySql.ts";

const migrate = Migrator.make({})({ loader: CoreMigrations.coreMigrations });

const at = (minutes: number) => DateTime.makeUnsafe(1_700_000_000_000 + minutes * 60_000);
const sessionId = Schema.decodeUnknownSync(Models.SessionId);
const userId = Schema.decodeUnknownSync(Models.UserId);

const newSession = (id: string, user = "u1", minutes = 0): SessionStore.NewSession => ({
  id: sessionId(id),
  userId: userId(user),
  secretHash: `hash-${id}`,
  at: at(minutes),
  absoluteExpiresAt: at(minutes + 1000),
  idleExpiresAt: at(minutes + 60),
  ipAddress: Option.none(),
  userAgent: Option.none(),
  actingAs: Option.none(),
  amr: [],
});

const unknown = () => new UnknownError({ cause: new Error("simulated database failure") });

const insertInput = (
  session: SessionStore.NewSession,
  supersedes?: string,
): Parameters<SessionStore.SessionStoreShape["insert"]>[0] => ({
  session,
  supersedes: Option.map(Option.fromNullishOr(supersedes), sessionId),
  maxLive: Option.none(),
});

/** The store over a client whose statements fail on demand (`FaultySql`), after the schema is applied. */
const FaultyStore = (() => {
  const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));
  return SessionStoreSql.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(migrate).pipe(Layer.provide(Faulty))),
    Layer.provideMerge(Faulty),
  );
})();

const INSERT = /insert into "?sessions/i;

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect and never the raw `SqlError`.
describe("SessionStoreSql insert failures (MA-004, SEA-002)", () => {
  it.effect("a SqlError from the database surfaces as StoreUnavailable naming the primitive", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({ count: 1, reason: unknown(), matching: INSERT });
      const failure = yield* store.insert(insertInput(newSession("s1"))).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(failure.operation, "SessionStore.insert");
      // The cause is logged where it happened; it is not a field a response could carry.
      assert.notProperty(failure, "cause");
    }).pipe(Effect.provide(FaultyStore)),
  );

  // ESR-002/RRS-004: a failing successor insert must roll the tombstone back.
  it.effect(
    "a failing insert during a supersede leaves the superseded session live and untombstoned",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const faults = yield* FaultySql.FaultControl;
        yield* store.insert(insertInput(newSession("a")));
        yield* faults.failNext({ count: 1, reason: unknown(), matching: INSERT });
        const failed = yield* store
          .insert(insertInput(newSession("b", "u1", 1), "a"))
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "StoreUnavailable");
        const ancestor = Option.getOrThrow(yield* store.get(sessionId("a")));
        assert.isTrue(Option.isNone(ancestor.supersededAt));
        assert.isTrue(Option.isNone(yield* store.get(sessionId("b"))));
      }).pipe(Effect.provide(FaultyStore)),
  );

  // SEA-002: a `SQLITE_BUSY`-class failure (a retryable `SqlError`) is retried a bounded number of times
  // before it becomes `StoreUnavailable`; anything else is not retried at all.
  const busy = () => new LockTimeoutError({ cause: new Error("SQLITE_BUSY: database is locked") });

  it.effect("insert retries a busy write and succeeds once the lock frees", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({ count: 2, reason: busy(), matching: INSERT });
      const fiber = yield* Effect.forkChild(store.insert(insertInput(newSession("s1"))));
      yield* TestClock.adjust(Duration.seconds(5));
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.inserted.id, "s1");
      assert.strictEqual(yield* faults.attempts(INSERT), 3);
    }).pipe(Effect.provide(FaultyStore)),
  );

  it.effect("the retry is bounded: a write that stays busy becomes StoreUnavailable", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({ count: Number.POSITIVE_INFINITY, reason: busy(), matching: INSERT });
      const fiber = yield* Effect.forkChild(
        store.insert(insertInput(newSession("s1"))).pipe(Effect.flip),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      // The first try plus three retries, and no more.
      assert.strictEqual(yield* faults.attempts(INSERT), 4);
    }).pipe(Effect.provide(FaultyStore)),
  );

  it.effect("a non-retryable failure is not retried", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({
        count: Number.POSITIVE_INFINITY,
        reason: unknown(),
        matching: INSERT,
      });
      const failure = yield* store.insert(insertInput(newSession("s1"))).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(yield* faults.attempts(INSERT), 1);
    }).pipe(Effect.provide(FaultyStore)),
  );
});

describe("SessionStoreSql failure mapping (MA-004)", () => {
  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({ count: Number.POSITIVE_INFINITY, reason: unknown() });
      const id = sessionId("s1");
      const failures = {
        insert: yield* store.insert(insertInput(newSession("s1"))).pipe(Effect.flip),
        get: yield* store.get(id).pipe(Effect.flip),
        rotate: yield* store
          .rotate({
            id,
            expectedSecretHash: "h",
            secretHash: "h2",
            previous: Option.none(),
            lastActiveAt: at(1),
            idleExpiresAt: at(61),
          })
          .pipe(Effect.flip),
        flagReuse: yield* store.flagReuse(id, at(1)).pipe(Effect.flip),
        remove: yield* store.remove(id, Option.none()).pipe(Effect.flip),
        removeForUser: yield* store.removeForUser(userId("u1"), Option.none()).pipe(Effect.flip),
        listLive: yield* store
          .listLive({ userId: userId("u1"), now: at(1), limit: 10, consistency: "authoritative" })
          .pipe(Effect.flip),
        reauthenticate: yield* store
          .reauthenticate({ id, owner: userId("u1"), at: at(1), addAmr: ["otp"] })
          .pipe(Effect.flip),
        purgeExpired: yield* store.purgeExpired(at(100)).pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `SessionStore.${primitive}`);
      }
    }).pipe(Effect.provide(FaultyStore)),
  );
});

// PPS-002 (moved from the repository suite): the page query must be served by the partial composite
// index, with no temp B-tree sort. This is the exact statement `listLive` pages with.
describe("SessionStoreSql query plan (PPS-002)", () => {
  it.effect("the page query is served by sessions_user_created_live, with no sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE "userId" = ?
           AND "supersededAt" IS NULL
           AND "absoluteExpiresAt" > ?
           AND "idleExpiresAt" > ?
           AND ("createdAt", id) > (?, ?)
           ORDER BY "createdAt" ASC, id ASC LIMIT ?`,
        ["u", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01", "x", 10],
      );
      const detail = plan.map((row) => row.detail).join("\n");
      assert.include(detail, "sessions_user_created_live");
      assert.notInclude(detail, "USE TEMP B-TREE FOR ORDER BY");
    }).pipe(Effect.provide(FaultyStore)),
  );
});
