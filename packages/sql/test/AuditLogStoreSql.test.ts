// Plan 02 / plan 16: what only the SQL adapter of `AuditLogStore` can show. What every adapter must
// do is `StoreContract.auditLog` (run over SQLite, a WAL file, libSQL and Postgres by
// `packages/test/test/StoreContract.*.test.ts`); this is the failure mapping, injected at the SQL
// client (`FaultySql`).
import { AuditLogStore } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Migrator from "effect/unstable/sql/Migrator";
import { UnknownError } from "effect/unstable/sql/SqlError";
import * as AuditLogStoreSql from "../src/AuditLogStoreSql.ts";
import * as CoreMigrations from "../src/CoreMigrations.ts";
import * as FaultySql from "./support/FaultySql.ts";

const Faulty = FaultySql.layer(SqliteClient.layer({ filename: ":memory:" }));
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(Faulty));

/** The store over a client whose statements fail on demand (`FaultySql`), after the schema is applied. */
const Store = AuditLogStoreSql.layer.pipe(Layer.provideMerge(Migrated), Layer.provideMerge(Faulty));

const outage = () => new UnknownError({ cause: new Error("database is down") });

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
      const faults = yield* FaultySql.FaultControl;
      yield* faults.failNext({ count: Number.POSITIVE_INFINITY, reason: outage() });
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
    }).pipe(Effect.provide(Store)),
  );
});
