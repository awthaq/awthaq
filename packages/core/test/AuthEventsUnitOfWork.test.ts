// ADR-EA-037 / BEH-EA-327: a live subscriber never observes a state-change event whose unit of work
// rolled back; an attempt event is recorded and delivered whether or not its unit commits.
import * as TestEncryption from "../../test/src/TestEncryption.ts";
import { SqlTransaction } from "@awthaq/ports";
import { CoreMigrations, TenantScope } from "@awthaq/sql";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Persistence from "../src/Persistence.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Users from "../src/Users.ts";
import * as TestSql from "../../test/src/TestSql.ts";

/** Every SQL store over the ambient `SqlClient` (plan 02): provide it where the composition is built. */
const SqlStores = Persistence.sql().pipe(Layer.provide(TestEncryption.layer));

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const SqlLive = TestSql.layer("core_AuthEventsUnitOfWork");
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const Live = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(SqlStores))),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

/** Subscribes, runs `body`, and returns the tags the subscriber was handed. */
const observe = <E, R>(body: Effect.Effect<unknown, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const stream = yield* events.subscribe;
      yield* Effect.exit(body);
      yield* events.publish({ _tag: "auth.token.replay", identifier: "sentinel" });
      const seen = yield* stream.pipe(
        Stream.takeUntil(
          (event) => event._tag === "auth.token.replay" && event.identifier === "sentinel",
        ),
        Stream.runCollect,
      );
      return seen.map((event) => event._tag).filter((tag) => tag !== "auth.token.replay");
    }),
  );

const stateChange = (events: AuthEvents.AuthEventsShape) =>
  events.publish({ _tag: "auth.user.created", userId });
const attempt = (events: AuthEvents.AuthEventsShape) =>
  events.publish({
    _tag: "auth.user.signInFailed",
    strategy: "password",
    reason: "invalidCredentials",
  });

const auditTags = Effect.map(
  Effect.flatMap(AuditLog.AuditLog, (log) => log.list({})),
  (rows) => rows.map((row) => row.eventTag).filter((tag) => tag !== "auth.token.replay"),
);

describe("AuthEvents inside a unit of work (ADR-EA-037)", () => {
  it.effect("a rolled-back unit: the subscriber and the audit log see only the attempt event", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const sql = yield* SqlClient.SqlClient;
      const seen = yield* observe(
        SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            yield* stateChange(events);
            yield* attempt(events);
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.deepStrictEqual(seen, ["auth.user.signInFailed"]);
      assert.deepStrictEqual(yield* auditTags, ["auth.user.signInFailed"]);
    }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "a committed unit: both events reach the subscriber and the audit log exactly once",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const sql = yield* SqlClient.SqlClient;
        const seen = yield* observe(
          SqlTransaction.transactional(sql)(
            Effect.gen(function* () {
              yield* stateChange(events);
              yield* attempt(events);
            }),
          ),
        );
        assert.deepStrictEqual(seen.toSorted(), ["auth.user.created", "auth.user.signInFailed"]);
        assert.deepStrictEqual((yield* auditTags).toSorted(), [
          "auth.user.created",
          "auth.user.signInFailed",
        ]);
      }).pipe(Effect.provide(Live)),
  );

  it.effect("a state-change event is not on the bus while its unit is still open", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* events.subscribe;
          yield* SqlTransaction.transactional(sql)(
            Effect.gen(function* () {
              yield* stateChange(events);
              // The audit row is already part of the transaction; the bus copy is not yet released.
              assert.deepStrictEqual(yield* auditTags, ["auth.user.created"]);
              assert.strictEqual(yield* events.droppedCount, 0);
            }),
          );
          const [first] = yield* stream.pipe(Stream.take(1), Stream.runCollect);
          assert.strictEqual(first?._tag, "auth.user.created");
        }),
      );
    }).pipe(Effect.provide(Live)),
  );

  it.effect("outside any unit, publish behaves as before: delivered at once", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* observe(stateChange(events));
      assert.deepStrictEqual(seen, ["auth.user.created"]);
    }).pipe(Effect.provide(Live)),
  );

  // ADR-EA-028 "bestEffort" must hold inside a transaction too: on Postgres a failed statement aborts
  // the whole transaction unless it ran in a savepoint, so the audit insert is wrapped in one.
  it.effect(
    "a failing audit insert inside a transaction degrades the trail, not the transaction",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE TABLE uow_marker (label TEXT NOT NULL)`);
        yield* TestSql.injectFailure({
          name: "fail_audit_insert",
          table: "auth_audit_log",
          event: "INSERT",
        });
        yield* SqlTransaction.transactional(sql)(
          Effect.gen(function* () {
            yield* sql`INSERT INTO uow_marker (label) VALUES ('before')`;
            yield* stateChange(events);
            yield* sql`INSERT INTO uow_marker (label) VALUES ('after')`;
          }),
        );
        const rows = yield* sql<{
          readonly label: string;
        }>`SELECT label FROM uow_marker ORDER BY label`;
        assert.deepStrictEqual(
          rows.map((row) => row.label),
          ["after", "before"],
        );
      }).pipe(Effect.provide(Live)),
  );

  // The per-request Postgres tenant transaction wraps whole handlers (`TenantMiddleware`'s
  // `layerWithRls`): a request that fails after publishing must not have told anyone. On SQLite
  // `withTenant` opens no transaction, so this is Postgres-only (`pnpm test:pg`).
  it.effect.skipIf(process.env["AWTHAQ_POSTGRES_URL"] === undefined)(
    "a failed tenanted request delivers no state-change event, only the attempt",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const seen = yield* observe(
          Effect.gen(function* () {
            yield* stateChange(events);
            yield* attempt(events);
            return yield* Effect.fail("handler failed");
          }).pipe(TenantScope.withTenant("tenant-a")),
        );
        assert.deepStrictEqual(seen, ["auth.user.signInFailed"]);
      }).pipe(Effect.provide(Live)),
  );
});
