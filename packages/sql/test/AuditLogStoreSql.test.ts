// Plan 02, phase 2: what only the SQL adapter of `AuditLogStore` can show. What every adapter must
// do is `StoreContract.auditLog` (run over SQLite, a WAL file and Postgres by
// `packages/test/test/StoreContract.*.test.ts`); this is the failure mapping and the one thing the
// repository does that the store port does not name: the statement it refuses to send.
import { AuditLogStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as AuditLogStoreSql from "../src/AuditLogStoreSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as Repositories from "../src/Repositories.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const outage = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("database is down") }) });

/** A repository whose every statement fails with an outage. */
const DownRepository = Layer.effect(
  Repositories.AuditLogRepository,
  Effect.gen(function* () {
    const real = yield* Repositories.AuditLogRepository;
    return {
      ...real,
      insertIfAbsent: () => Effect.fail(outage()),
      list: () => Effect.fail(outage()),
      page: () => Effect.fail(outage()),
      listReferencing: () => Effect.fail(outage()),
      deleteOccurredBefore: () => Effect.fail(outage()),
    };
  }),
).pipe(
  Layer.provide(Repositories.AuditLogRepositoryLive),
  Layer.provide(SqlLive),
  Layer.provide(Migrated),
);

const DownStore = AuditLogStoreSql.layer.pipe(
  Layer.provide(DownRepository),
  Layer.provide(SqlLive),
);

const row: AuditLogStore.AuditRow = {
  id: "a",
  eventTag: "auth.test",
  actorUserId: Option.none(),
  occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
  correlationId: Option.none(),
  tenantId: Option.none(),
  payloadJson: "{}",
};

describe("AuditLogStoreSql failure mapping (MA-004)", () => {
  // A transient failure is retried on the real clock before it is given up on.
  it.live("a SqlError is StoreUnavailable naming the primitive that failed", () =>
    Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      const empty = {
        eventTag: Option.none<string>(),
        actorUserId: Option.none<string>(),
        from: Option.none<DateTime.Utc>(),
        to: Option.none<DateTime.Utc>(),
      };
      const failures = {
        append: yield* store.append(row).pipe(Effect.flip),
        select: yield* store.select(empty, "authoritative").pipe(Effect.flip),
        pageAfter: yield* store
          .pageAfter({ after: Option.none(), eventTag: Option.none(), limit: 5 }, "authoritative")
          .pipe(Effect.flip),
        rewriteReferencing: yield* store
          .rewriteReferencing("user-1", () => Option.none())
          .pipe(Effect.flip),
        deleteBefore: yield* store
          .deleteBefore({
            cutoff: DateTime.makeUnsafe(1_800_000_000_000),
            eventTags: Option.none(),
            exceptTags: [],
          })
          .pipe(Effect.flip),
      };
      for (const [primitive, failure] of Object.entries(failures)) {
        assert.strictEqual(failure._tag, "StoreUnavailable", primitive);
        assert.strictEqual(failure.operation, `AuditLogStore.${primitive}`);
      }
    }).pipe(Effect.provide(DownStore)),
  );
});

describe("AuditLogStoreSql (SQLite)", () => {
  const RealStore = AuditLogStoreSql.layer.pipe(
    Layer.provideMerge(Repositories.AuditLogRepositoryLive),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  it.effect("an empty retention allow-list sends no statement and deletes nothing", () =>
    Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      yield* store.append(row);
      // `eventTags` is non-empty by type, so the empty case is the repository's own guard.
      const repo = yield* Repositories.AuditLogRepository;
      const deleted = yield* repo.deleteOccurredBefore({
        cutoff: DateTime.makeUnsafe(1_800_000_000_000),
        eventTags: [],
        exceptTags: [],
        limit: 100,
      });
      assert.strictEqual(deleted, 0);
    }).pipe(Effect.provide(RealStore)),
  );
});
