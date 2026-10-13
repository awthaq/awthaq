// BEH-EA-100. Wayfinder map (.scratch/resolve-ready-for-human-findings),
// ticket 01 (ALF-001/ESA-001/ESS-002/CSG-004/EP-002).
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — matching every other dual-backend suite in
// this package (`Sessions.test.ts`, `Verification.test.ts`).
import { Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Observability from "../src/Observability.ts";
import { UserId } from "../src/Users.ts";
import { allSamples, otherUserId, samples, sessionId, userId } from "./support/eventSamples.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE auth_audit_log (
        id TEXT PRIMARY KEY,
        eventTag TEXT NOT NULL,
        actorUserId TEXT,
        tenantId TEXT,
        occurredAt TEXT NOT NULL,
        correlationId TEXT,
        payload TEXT NOT NULL
      )
    `;
  }),
).pipe(Layer.provide(SqlLive));

const SqlLayer = AuditLog.layerSql.pipe(
  Layer.provideMerge(Repositories.AuditLogRepositoryLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

/** A delivered event with a hand-set envelope: `n` orders ids, `ms` is the timestamp. */
const stamped = (event: AuthEvents.AuthEvent, n: number, ms = 1_700_000_000_000 + n * 1000) => {
  const published: AuthEvents.Published = {
    ...event,
    eventId: `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    occurredAt: DateTime.makeUnsafe(ms),
    correlationId: Option.none(),
    traceId: Option.none(),
    spanId: Option.none(),
    ip: Option.none(),
    userAgent: Option.none(),
    tenantId: Option.none(),
  };
  return published;
};

const suite = (name: string, layer: Layer.Layer<AuditLog.AuditLog, unknown, never>): void => {
  describe(name, () => {
    it.effect("records every published AuthEvent, actorless events included", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
        const recorded = yield* auditLog.list();
        assert.strictEqual(recorded.length, 2);
        const created = recorded.find((r) => r.eventTag === "auth.user.created");
        const replay = recorded.find((r) => r.eventTag === "auth.token.replay");
        assert.isDefined(created);
        assert.isDefined(replay);
        assert.deepStrictEqual(created?.actorUserId, Option.some(userId));
        assert.deepStrictEqual(replay?.actorUserId, Option.none());
      }).pipe(Effect.provide(layer)),
    );

    // ESA-007: a stored payload decodes back into the typed union — no `unknown`.
    it.effect("round-trips every AuthEvent variant through the schema codec", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        for (const [index, event] of allSamples.entries()) {
          yield* auditLog.record(stamped(event, index + 1));
        }
        const recorded = yield* auditLog.list();
        assert.strictEqual(recorded.length, allSamples.length);
        const byId = new Map(recorded.map((record) => [record.id, record.payload]));
        for (const [index, event] of allSamples.entries()) {
          const id = `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
          assert.deepStrictEqual(byId.get(id), event, event._tag);
        }
      }).pipe(Effect.provide(layer)),
    );

    // BEH-EA-231/BEH-EA-308: the tenant stamp is part of the record and of the delivered-event view, so a
    // tenant-aware consumer (per-tenant webhook endpoints) can route on it.
    it.effect(
      "carries the tenant the row was stamped with into the record and the delivered event",
      () =>
        Effect.gen(function* () {
          const auditLog = yield* AuditLog.AuditLog;
          yield* auditLog.record({
            ...stamped(samples["auth.user.created"], 1),
            tenantId: Option.some("org-1"),
          });
          yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
          const recorded = yield* auditLog.list();
          const created = recorded.find((r) => r.eventTag === "auth.user.created");
          const replay = recorded.find((r) => r.eventTag === "auth.token.replay");
          assert.deepStrictEqual(created?.tenantId, Option.some("org-1"));
          assert.deepStrictEqual(replay?.tenantId, Option.none());
          if (created === undefined) return assert.fail("no record");
          assert.deepStrictEqual(AuditLog.toPublished(created).tenantId, Option.some("org-1"));
        }).pipe(Effect.provide(layer)),
    );

    // PERS-005: an organization PermissionEngine denial is durably recorded with who/what/why.
    it.effect("records an organization permission denial with its actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.organization.permissionDenied"], 1));
        const recorded = yield* auditLog.list({ eventTag: "auth.organization.permissionDenied" });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    // ECS-006/ECS-002: a CLI run has no session — the seeded target is in the payload, not the actor.
    it.effect("records the CLI's admin-seed and import events with no actor", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.admin.seeded"], 1));
        yield* auditLog.record(stamped(samples["auth.admin.seedRefused"], 2));
        yield* auditLog.record(stamped(samples["auth.import.completed"], 3));
        const seeded = yield* auditLog.list({ eventTag: "auth.admin.seeded" });
        assert.strictEqual(seeded.length, 1);
        assert.deepStrictEqual(seeded[0]?.actorUserId, Option.none());
        assert.strictEqual(
          (yield* auditLog.list({ eventTag: "auth.admin.seedRefused" })).length,
          1,
        );
        assert.strictEqual((yield* auditLog.list({ eventTag: "auth.import.completed" })).length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list narrows by eventTag", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
        const recorded = yield* auditLog.list({ eventTag: "auth.token.replay" });
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0]?.eventTag, "auth.token.replay");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("list narrows by actorUserId", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        yield* auditLog.record(stamped(samples["auth.user.created"], 1));
        yield* auditLog.record(stamped({ _tag: "auth.user.created", userId: otherUserId }, 2));
        const recorded = yield* auditLog.list({ actorUserId: userId });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(userId));
      }).pipe(Effect.provide(layer)),
    );

    // ESA-002: `id` breaks a same-millisecond tie, so the order is total (newest first).
    it.effect("two events in the same millisecond list newest-first, deterministically by id", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const ms = 1_700_000_000_000;
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "first" }, 1, ms));
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "second" }, 2, ms));
        yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: "third" }, 3, ms));
        const recorded = yield* auditLog.list();
        assert.deepStrictEqual(
          recorded.map((r) => (r.payload._tag === "auth.token.replay" ? r.payload.identifier : "")),
          ["third", "second", "first"],
        );
      }).pipe(Effect.provide(layer)),
    );

    // ESA-003: the recovery path for the at-most-once bus.
    it.effect(
      "replay({ after }) yields every event after the checkpoint in publish order, across pages",
      () =>
        Effect.gen(function* () {
          const auditLog = yield* AuditLog.AuditLog;
          for (let n = 1; n <= 7; n++) {
            yield* auditLog.record(stamped({ _tag: "auth.token.replay", identifier: `e${n}` }, n));
          }
          const identifiers = (records: Iterable<AuditLog.AuditLogRecord>) =>
            Array.from(records, (r) =>
              r.payload._tag === "auth.token.replay" ? r.payload.identifier : "",
            );
          const all = yield* auditLog.replay({ batchSize: 3 }).pipe(Stream.runCollect);
          assert.deepStrictEqual(identifiers(all), ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
          const checkpoint = Array.from(all)[2]?.id;
          const rest = yield* auditLog
            .replay(checkpoint === undefined ? {} : { after: checkpoint, batchSize: 2 })
            .pipe(Stream.runCollect);
          assert.deepStrictEqual(identifiers(rest), ["e4", "e5", "e6", "e7"]);
          const onlyTag = yield* auditLog
            .replay({ eventTag: "auth.user.created" })
            .pipe(Stream.runCollect);
          assert.strictEqual(onlyTag.length, 0);
        }).pipe(Effect.provide(layer)),
    );

    // ESA-005: erasure keeps the forensic timeline and drops the person.
    it.effect(
      "pseudonymizeActor removes the user id and free-text reason from every row but keeps tag, time and id",
      () =>
        Effect.gen(function* () {
          const auditLog = yield* AuditLog.AuditLog;
          yield* auditLog.record(stamped(samples["auth.user.created"], 1));
          yield* auditLog.record(stamped(samples["auth.admin.impersonationStarted"], 2));
          yield* auditLog.record(stamped(samples["auth.authz.denied"], 3));
          yield* auditLog.record(
            stamped({ _tag: "auth.token.replay", identifier: `verify-email:${userId}` }, 4),
          );
          yield* auditLog.record(stamped({ _tag: "auth.user.created", userId: otherUserId }, 5));

          const rewritten = yield* auditLog.pseudonymizeActor(userId);
          assert.strictEqual(rewritten, 4);
          // Idempotent: a second pass finds nothing left to rewrite.
          assert.strictEqual(yield* auditLog.pseudonymizeActor(userId), 0);

          const rows = yield* auditLog.list();
          assert.strictEqual(rows.length, 5);
          const text = JSON.stringify(rows.map((row) => row.payload));
          assert.notInclude(text, userId);
          assert.notInclude(text, "billing bug");
          // Tag, id and timestamp survive; the alias stands in consistently...
          const created = rows.find((row) => row.id.endsWith("000000000001"));
          assert.strictEqual(created?.eventTag, "auth.user.created");
          assert.strictEqual(created?.occurredAt.epochMilliseconds, 1_700_000_001_000);
          const alias = Option.getOrUndefined(created?.actorUserId ?? Option.none());
          assert.isDefined(alias);
          assert.notStrictEqual(alias, userId);
          const impersonation = rows.find(
            (row) => row.eventTag === "auth.admin.impersonationStarted",
          );
          assert.strictEqual(
            impersonation?.payload._tag === "auth.admin.impersonationStarted"
              ? impersonation.payload.targetUserId
              : "",
            alias,
          );
          // ...another user's rows are untouched, and nothing lists the erased id any more.
          assert.strictEqual((yield* auditLog.list({ actorUserId: userId })).length, 0);
          assert.strictEqual((yield* auditLog.list({ actorUserId: otherUserId })).length, 2);
        }).pipe(Effect.provide(layer)),
    );

    // ESA-005 (plan 09, F2): erasing one person must not touch a row that does not name them.
    it.effect("erasing one user leaves another user's impersonation justification intact", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const unrelated = UserId("44444444-4444-4444-4444-444444444444");
        yield* auditLog.record(
          stamped(
            {
              _tag: "auth.admin.impersonationStarted",
              adminUserId: userId,
              targetUserId: otherUserId,
              reason: "billing bug",
              sessionId,
            },
            1,
          ),
        );
        const rewritten = yield* auditLog.pseudonymizeActor(unrelated);
        assert.strictEqual(rewritten, 0);
        const rows = yield* auditLog.list();
        assert.include(JSON.stringify(rows.map((row) => row.payload)), "billing bug");
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("AuditLog (layerMemory)", AuditLog.layerMemory);
suite("AuditLog (layerSql)", SqlLayer);

describe("AuditLog (layerSql) — ESA-007 stored-row decoding", () => {
  it.effect(
    "a hand-inserted malformed row surfaces the typed AuditLogDecodeError, not a defect",
    () =>
      Effect.gen(function* () {
        const repo = yield* Repositories.AuditLogRepository;
        const auditLog = yield* AuditLog.AuditLog;
        yield* repo.insert({
          id: "018f0000-0000-7000-8000-000000000099",
          eventTag: "auth.user.created",
          actorUserId: null,
          occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
          correlationId: null,
          payload: { _tag: "auth.user.created" }, // userId missing
        });
        const failure = yield* auditLog.list().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AuditLogDecodeError");
        if (failure._tag === "AuditLogDecodeError") {
          assert.strictEqual(failure.id, "018f0000-0000-7000-8000-000000000099");
        }
      }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect(
    "a payload written before versioning existed (no `version`, no `meta`) still decodes",
    () =>
      Effect.gen(function* () {
        const repo = yield* Repositories.AuditLogRepository;
        const auditLog = yield* AuditLog.AuditLog;
        yield* repo.insert({
          id: "018f0000-0000-7000-8000-000000000098",
          eventTag: "auth.user.created",
          actorUserId: null,
          occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
          correlationId: null,
          payload: { _tag: "auth.user.created", userId },
        });
        const [row] = yield* auditLog.list();
        assert.deepStrictEqual(row?.payload, { _tag: "auth.user.created", userId });
      }).pipe(Effect.provide(SqlLayer)),
  );

  it.effect(
    "an auth.user.deleted row written before the initiator fields existed still decodes",
    () =>
      Effect.gen(function* () {
        const repo = yield* Repositories.AuditLogRepository;
        const auditLog = yield* AuditLog.AuditLog;
        yield* repo.insert({
          id: "018f0000-0000-7000-8000-000000000097",
          eventTag: "auth.user.deleted",
          actorUserId: userId,
          occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
          correlationId: null,
          payload: { _tag: "auth.user.deleted", userId, deletedBy: "self" },
        });
        const [row] = yield* auditLog.list({ eventTag: "auth.user.deleted" });
        assert.deepStrictEqual(row?.payload, {
          _tag: "auth.user.deleted",
          userId,
          deletedBy: "self",
        });
      }).pipe(Effect.provide(SqlLayer)),
  );
});

// AuthEvents integration: BEH-EA-100's own point is that `publish` itself
// writes durably, never depending on a subscriber existing at all.
it.effect("AuthEvents.publish writes through AuditLog with zero subscribers", () =>
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    const auditLog = yield* AuditLog.AuditLog;
    yield* events.publish({ _tag: "auth.token.replay", identifier: "reset-password:u1" });
    const recorded = yield* auditLog.list();
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0]?.eventTag, "auth.token.replay");
  }).pipe(Effect.provide(AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory)))),
);

// MA-004/ADR-EA-028: a store outage is the typed `StoreUnavailable` on every method, not a defect,
// and `AuthEvents.publish` applies an explicit policy to a failed audit write.
const outage = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("database is down") }) });

const DownRepository = Layer.effect(
  Repositories.AuditLogRepository,
  Effect.gen(function* () {
    const real = yield* Repositories.AuditLogRepository;
    return {
      ...real,
      insert: () => Effect.fail(outage()),
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

const DownAuditLog = AuditLog.layerSql.pipe(Layer.provideMerge(DownRepository));

describe("AuditLog infrastructure failures (MA-004)", () => {
  it.effect("layerSql: every method surfaces a SqlError as StoreUnavailable, not a defect", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      const record = yield* auditLog
        .record(stamped(samples["auth.user.created"], 1))
        .pipe(Effect.flip);
      assert.strictEqual(record._tag, "StoreUnavailable");
      assert.strictEqual(record.operation, "AuditLog.record");
      const list = yield* auditLog.list().pipe(Effect.flip);
      assert.strictEqual(list._tag, "StoreUnavailable");
      const replay = yield* auditLog.replay().pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(replay._tag, "StoreUnavailable");
      const pseudonymize = yield* auditLog.pseudonymizeActor(userId).pipe(Effect.flip);
      assert.strictEqual(pseudonymize._tag, "StoreUnavailable");
      const purge = yield* auditLog
        .purge({ before: DateTime.makeUnsafe(1_800_000_000_000) })
        .pipe(Effect.flip);
      assert.strictEqual(purge._tag, "StoreUnavailable");
    }).pipe(Effect.provide(DownAuditLog)),
  );

  it.effect(
    "the default policy (bestEffort): publish still succeeds, the bus still delivers, the failure is counted",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const subscription = yield* events.subscribe;
        const failures = Metric.withAttributes(Observability.auditWriteFailures, {
          tag: "auth.user.created",
        });
        const before = (yield* Metric.value(failures)).count;
        yield* events.publish({ _tag: "auth.user.created", userId });
        const delivered = yield* Stream.runHead(subscription);
        assert.strictEqual(Option.getOrUndefined(delivered)?._tag, "auth.user.created");
        assert.strictEqual((yield* Metric.value(failures)).count - before, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(AuthEvents.layer.pipe(Layer.provideMerge(DownAuditLog))),
      ),
  );

  it.effect(
    'the "required" policy: publish dies with the StoreUnavailable and delivers nothing',
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const exit = yield* Effect.exit(events.publish({ _tag: "auth.user.created", userId }));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Predicate.isTagged(Cause.squash(exit.cause), "StoreUnavailable"));
        }
      }).pipe(
        Effect.provide(
          AuthEvents.layer.pipe(
            Layer.provideMerge(DownAuditLog),
            Layer.provide(AuthEvents.auditWritePolicy("required")),
          ),
        ),
      ),
  );
});
