// Plan 02, phase 6: what only the SQL adapter of `SessionStore` can show. What every adapter must do is
// `StoreContract.sessions` (`packages/test/test/StoreContract.*.test.ts`, also on Postgres under
// `pnpm test:pg`); this is the adapter's retry of a busy write, the rollback of a supersede whose insert
// fails, the statements it will not retry, and the failure mapping.
import { SessionStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { LockTimeoutError, SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Models from "../src/Models.ts";
import * as Repositories from "../src/Repositories.ts";
import * as SessionStoreSql from "../src/SessionStoreSql.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

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

const insertInput = (
  session: SessionStore.NewSession,
  supersedes?: string,
): Parameters<SessionStore.SessionStoreShape["insert"]>[0] => ({
  session,
  supersedes: Option.map(Option.fromNullishOr(supersedes), sessionId),
  maxLive: Option.none(),
});

/** A repository whose `insert` runs `behaviour` first (it may fail), then the real one. */
const withInsert = (behaviour: (input: unknown) => Effect.Effect<void, SqlError>) =>
  Layer.effect(
    Repositories.SessionsRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.SessionsRepository;
      return {
        ...real,
        insert: (input: Parameters<typeof real.insert>[0]) =>
          Effect.andThen(behaviour(input), real.insert(input)),
      };
    }),
  ).pipe(Layer.provide(Repositories.SessionsRepositoryLive));

const storeOver = (
  repository: Layer.Layer<Repositories.SessionsRepository, never, SqlClient.SqlClient>,
) =>
  SessionStoreSql.layer.pipe(
    Layer.provide(repository),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

const outage = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("simulated insert failure") }) });

// MA-004: an infrastructure failure is the typed `StoreUnavailable`, never a defect and never the raw `SqlError`.
describe("SessionStoreSql insert failures (MA-004, SEA-002)", () => {
  const failNext = Effect.runSync(Ref.make(false));
  const Flaky = storeOver(
    withInsert(() =>
      Ref.getAndSet(failNext, false).pipe(
        Effect.flatMap((fail) => (fail ? Effect.fail(outage()) : Effect.void)),
      ),
    ),
  );

  it.effect(
    "a SqlError from the repository surfaces as StoreUnavailable naming the primitive",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        yield* Ref.set(failNext, true);
        const failure = yield* store.insert(insertInput(newSession("s1"))).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.strictEqual(failure.operation, "SessionStore.insert");
        // The cause is logged where it happened; it is not a field a response could carry.
        assert.notProperty(failure, "cause");
      }).pipe(Effect.provide(Flaky)),
  );

  // ESR-002/RRS-004: a failing successor insert must roll the tombstone back.
  it.effect(
    "a failing insert during a supersede leaves the superseded session live and untombstoned",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        yield* store.insert(insertInput(newSession("a")));
        yield* Ref.set(failNext, true);
        const failed = yield* store
          .insert(insertInput(newSession("b", "u1", 1), "a"))
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "StoreUnavailable");
        const ancestor = Option.getOrThrow(yield* store.get(sessionId("a")));
        assert.isTrue(Option.isNone(ancestor.supersededAt));
        assert.isTrue(Option.isNone(yield* store.get(sessionId("b"))));
      }).pipe(Effect.provide(Flaky)),
  );

  // SEA-002: a `SQLITE_BUSY`-class failure (a retryable `SqlError`) is retried a bounded number of times
  // before it becomes `StoreUnavailable`; anything else is not retried at all.
  const attempts = Effect.runSync(Ref.make(0));
  const failFirst = Effect.runSync(Ref.make(0));
  const failWith = Effect.runSync(Ref.make<"busy" | "unknown">("busy"));
  const Busy = storeOver(
    withInsert(() =>
      Effect.gen(function* () {
        yield* Ref.update(attempts, (n) => n + 1);
        const remaining = yield* Ref.get(failFirst);
        if (remaining <= 0) return;
        yield* Ref.set(failFirst, remaining - 1);
        const kind = yield* Ref.get(failWith);
        return yield* Effect.fail(
          new SqlError({
            reason:
              kind === "busy"
                ? new LockTimeoutError({ cause: new Error("SQLITE_BUSY: database is locked") })
                : new UnknownError({ cause: new Error("boom") }),
          }),
        );
      }),
    ),
  );
  const reset = (failures: number, kind: "busy" | "unknown") =>
    Ref.set(attempts, 0).pipe(
      Effect.andThen(Ref.set(failFirst, failures)),
      Effect.andThen(Ref.set(failWith, kind)),
    );

  it.effect("insert retries a busy write and succeeds once the lock frees", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* reset(2, "busy");
      const fiber = yield* Effect.forkChild(store.insert(insertInput(newSession("s1"))));
      yield* TestClock.adjust(Duration.seconds(5));
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.inserted.id, "s1");
      assert.strictEqual(yield* Ref.get(attempts), 3);
    }).pipe(Effect.provide(Busy)),
  );

  it.effect("the retry is bounded: a write that stays busy becomes StoreUnavailable", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* reset(1000, "busy");
      const fiber = yield* Effect.forkChild(
        store.insert(insertInput(newSession("s1"))).pipe(Effect.flip),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      // The first try plus three retries, and no more.
      assert.strictEqual(yield* Ref.get(attempts), 4);
    }).pipe(Effect.provide(Busy)),
  );

  it.effect("a non-retryable failure is not retried", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      yield* reset(1000, "unknown");
      const failure = yield* store.insert(insertInput(newSession("s1"))).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
      assert.strictEqual(yield* Ref.get(attempts), 1);
    }).pipe(Effect.provide(Busy)),
  );
});

describe("SessionStoreSql failure mapping (MA-004)", () => {
  const DownRepository = Layer.effect(
    Repositories.SessionsRepository,
    Effect.gen(function* () {
      const real = yield* Repositories.SessionsRepository;
      return {
        ...real,
        insert: () => Effect.fail(outage()),
        findById: () => Effect.fail(outage()),
        touch: () => Effect.fail(outage()),
        markReusedOnce: () => Effect.fail(outage()),
        deleteReturning: () => Effect.fail(outage()),
        deleteAllByUser: () => Effect.fail(outage()),
        deleteAllForUserExcept: () => Effect.fail(outage()),
        listByUser: () => Effect.fail(outage()),
        reauthenticate: () => Effect.fail(outage()),
        deleteExpiredBefore: () => Effect.fail(outage()),
      };
    }),
  ).pipe(Layer.provide(Repositories.SessionsRepositoryLive));

  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
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
    }).pipe(Effect.provide(storeOver(DownRepository))),
  );
});
