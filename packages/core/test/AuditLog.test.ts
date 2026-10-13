// BEH-EA-100. Wayfinder map (.scratch/resolve-ready-for-human-findings),
// ticket 01 (ALF-001/ESA-001/ESS-002/CSG-004/EP-002).
//
// Plan 02 (ADR-EA-041): `AuditLog` is one implementation over `AuditLogStore`, so its domain suite
// runs once, over the `Ref` adapter. What a store must do on every backend (idempotent append,
// all-or-nothing rewrite, byte-order paging, the filter before the row) is `StoreContract.auditLog`,
// run on the `Ref`, SQLite and Postgres adapters; the SQL adapter's own failure mapping is
// `packages/sql/test/AuditLogStoreSql.test.ts`.
import { AuditLogStore } from "@awthaq/ports";
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
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Observability from "../src/Observability.ts";
import { StoreUnavailable } from "../src/Errors.ts";
import { UserId } from "../src/Users.ts";
import { allSamples, otherUserId, samples, sessionId, userId } from "./support/eventSamples.ts";

/** The domain service over the `Ref` adapter, with the store exposed so a case can seed a raw row. */
const MemoryLayer = AuditLog.layer.pipe(Layer.provideMerge(AuditLogStore.layerMemory));

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

const suite = (
  name: string,
  layer: Layer.Layer<AuditLog.AuditLog | AuditLogStore.AuditLogStore, unknown, never>,
): void => {
  describe(name, () => {
    // BEH-EA-101: the actor column is whatever the event declares (`Actor.field`/`prefixed`/`none`).
    // One event per rule; the declared rule is the event's own, so this is the interface-level proof.
    it.effect("records the actor each event declares, and none for actorless events", () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const cases: ReadonlyArray<readonly [AuthEvents.AuthEvent, Option.Option<string>]> = [
          // Actor.field("userId")
          [samples["auth.user.created"], Option.some(userId)],
          [samples["auth.organization.permissionDenied"], Option.some(userId)],
          // Actor.field("adminUserId"): the administrator, not the target
          [
            samples["auth.admin.userUpdated"],
            Option.some(samples["auth.admin.userUpdated"].adminUserId),
          ],
          // Actor.field("actorUserId") on an organization event (plan 04, F11): who acted, not who it was about;
          // absent when the actor names no user (a directory, the application)
          [samples["auth.organization.created"], Option.some(otherUserId)],
          [
            {
              _tag: "auth.organization.memberRemoved",
              organizationId: "org-1",
              userId,
              actorUserId: otherUserId,
            },
            Option.some(otherUserId),
          ],
          [
            { _tag: "auth.organization.memberRemoved", organizationId: "org-1", userId },
            Option.none(),
          ],
          // optional actor fields: present, then absent
          [
            { _tag: "auth.mail.failed", template: "verify", userId: otherUserId },
            Option.some(otherUserId),
          ],
          [{ _tag: "auth.mail.failed", template: "verify" }, Option.none()],
          [
            { _tag: "auth.roles.assigned", userId, roleName: "admin", actorUserId: otherUserId },
            Option.some(otherUserId),
          ],
          [{ _tag: "auth.roles.assigned", userId, roleName: "admin" }, Option.none()],
          // Actor.prefixed("subjectId", "user:"): only a user subject names an awthaq user
          [{ ...samples["auth.authz.denied"], subjectId: `user:${userId}` }, Option.some(userId)],
          [{ ...samples["auth.authz.denied"], subjectId: "apikey:k-1" }, Option.none()],
          // Actor.none: a directory, the CLI, an anonymous attempt
          [samples["auth.token.replay"], Option.none()],
          [samples["auth.scim.userProvisioned"], Option.none()],
          [samples["auth.admin.seeded"], Option.none()],
          [samples["auth.admin.seedRefused"], Option.none()],
          [samples["auth.import.completed"], Option.none()],
        ];
        for (const [index, [event]] of cases.entries()) {
          yield* auditLog.record(stamped(event, index + 1));
        }
        const recorded = yield* auditLog.list();
        for (const [index, [event, actor]] of cases.entries()) {
          const id = `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
          const row = recorded.find((r) => r.id === id);
          assert.deepStrictEqual(row?.actorUserId, actor, `${event._tag} #${index}`);
        }
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
          // The ban note is operator free text about the banned person (plan 09 phase 4).
          yield* auditLog.record(
            stamped({ ...samples["auth.admin.userBanned"], reason: "spamming the forum" }, 6),
          );

          const rewritten = yield* auditLog.pseudonymizeActor(userId);
          assert.strictEqual(rewritten, 5);
          // Idempotent: a second pass finds nothing left to rewrite.
          assert.strictEqual(yield* auditLog.pseudonymizeActor(userId), 0);

          const rows = yield* auditLog.list();
          assert.strictEqual(rows.length, 6);
          const text = JSON.stringify(rows.map((row) => row.payload));
          assert.notInclude(text, userId);
          assert.notInclude(text, "billing bug");
          assert.notInclude(text, "spamming the forum");
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
          assert.strictEqual((yield* auditLog.list({ actorUserId: otherUserId })).length, 3);
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

suite("AuditLog", MemoryLayer);

/** A raw row, as a store holds it: the envelope columns and the payload JSON text. */
const rawRow = (id: string, eventTag: string, payloadJson: string, actorUserId?: string) => ({
  id,
  eventTag,
  actorUserId: Option.fromNullishOr(actorUserId),
  occurredAt: DateTime.makeUnsafe(1_700_000_000_000),
  correlationId: Option.none<string>(),
  tenantId: Option.none<string>(),
  payloadJson,
});

describe("AuditLog: ESA-007 stored-row decoding", () => {
  it.effect(
    "a hand-inserted malformed row surfaces the typed AuditLogDecodeError, not a defect",
    () =>
      Effect.gen(function* () {
        const store = yield* AuditLogStore.AuditLogStore;
        const auditLog = yield* AuditLog.AuditLog;
        yield* store.append(
          rawRow(
            "018f0000-0000-7000-8000-000000000099",
            "auth.user.created",
            JSON.stringify({ _tag: "auth.user.created" }), // userId missing
          ),
        );
        const failure = yield* auditLog.list().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AuditLogDecodeError");
        if (failure._tag === "AuditLogDecodeError") {
          assert.strictEqual(failure.id, "018f0000-0000-7000-8000-000000000099");
        }
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect("a payload that is not JSON at all is the same typed error", () =>
    Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      const auditLog = yield* AuditLog.AuditLog;
      yield* store.append(rawRow("018f0000-0000-7000-8000-000000000096", "auth.user.created", "{"));
      const failure = yield* auditLog.list().pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AuditLogDecodeError");
    }).pipe(Effect.provide(MemoryLayer)),
  );

  // L-1: the filter runs in the store, so a row outside it is never decoded: one undecodable row
  // elsewhere in the log does not fail a listing that does not ask for it.
  it.effect("a malformed row outside the filter does not fail a filtered list", () =>
    Effect.gen(function* () {
      const store = yield* AuditLogStore.AuditLogStore;
      const auditLog = yield* AuditLog.AuditLog;
      yield* store.append(
        rawRow(
          "018f0000-0000-7000-8000-000000000095",
          "auth.user.created",
          JSON.stringify({ _tag: "auth.user.created" }),
        ),
      );
      yield* auditLog.record(stamped(samples["auth.token.replay"], 1));
      const recorded = yield* auditLog.list({ eventTag: "auth.token.replay" });
      assert.strictEqual(recorded.length, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect(
    "a payload written before versioning existed (no `version`, no `meta`) still decodes",
    () =>
      Effect.gen(function* () {
        const store = yield* AuditLogStore.AuditLogStore;
        const auditLog = yield* AuditLog.AuditLog;
        yield* store.append(
          rawRow(
            "018f0000-0000-7000-8000-000000000098",
            "auth.user.created",
            JSON.stringify({ _tag: "auth.user.created", userId }),
          ),
        );
        const [row] = yield* auditLog.list();
        assert.deepStrictEqual(row?.payload, { _tag: "auth.user.created", userId });
      }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect(
    "an auth.user.deleted row written before the initiator fields existed still decodes",
    () =>
      Effect.gen(function* () {
        const store = yield* AuditLogStore.AuditLogStore;
        const auditLog = yield* AuditLog.AuditLog;
        yield* store.append(
          rawRow(
            "018f0000-0000-7000-8000-000000000097",
            "auth.user.deleted",
            JSON.stringify({ _tag: "auth.user.deleted", userId, deletedBy: "self" }),
            userId,
          ),
        );
        const [row] = yield* auditLog.list({ eventTag: "auth.user.deleted" });
        assert.deepStrictEqual(row?.payload, {
          _tag: "auth.user.deleted",
          userId,
          deletedBy: "self",
        });
      }).pipe(Effect.provide(MemoryLayer)),
  );
});

describe("AuditLog: what the store makes true", () => {
  // L-2: an event id is the row id, so recording the same event twice is not an outage.
  it.effect("recording the same eventId twice stores one row and succeeds", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      const event = stamped(samples["auth.user.created"], 1);
      yield* auditLog.record(event);
      yield* auditLog.record(event);
      assert.strictEqual((yield* auditLog.list()).length, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );

  // L-4: an empty allow-list names no tag, so it deletes nothing (it is not "every tag").
  it.effect("purge with an empty eventTags allow-list deletes nothing", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      yield* auditLog.record(stamped(samples["auth.user.created"], 1));
      const gone = yield* auditLog.purge({
        before: DateTime.makeUnsafe(1_800_000_000_000),
        eventTags: [],
      });
      assert.strictEqual(gone, 0);
      assert.strictEqual((yield* auditLog.list()).length, 1);
      const all = yield* auditLog.purge({ before: DateTime.makeUnsafe(1_800_000_000_000) });
      assert.strictEqual(all, 1);
    }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect("purge honours eventTags and exceptTags", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      yield* auditLog.record(stamped(samples["auth.user.created"], 1));
      yield* auditLog.record(stamped(samples["auth.token.replay"], 2));
      const before = DateTime.makeUnsafe(1_800_000_000_000);
      assert.strictEqual(
        yield* auditLog.purge({
          before,
          eventTags: ["auth.token.replay", "auth.user.created"],
          exceptTags: ["auth.user.created"],
        }),
        1,
      );
      assert.deepStrictEqual(
        (yield* auditLog.list()).map((row) => row.eventTag),
        ["auth.user.created"],
      );
    }).pipe(Effect.provide(MemoryLayer)),
  );

  // L-5: a page size that is not a positive integer would drop, skip or fail a page.
  it.effect("replay refuses a batchSize that is not a positive integer", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      for (const batchSize of [0, -1, 1.5]) {
        const exit = yield* Effect.exit(auditLog.replay({ batchSize }).pipe(Stream.runCollect));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(exit.cause.reasons.some((reason) => reason._tag === "Die"));
        }
      }
    }).pipe(Effect.provide(MemoryLayer)),
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
// and `AuthEvents.publish` applies an explicit policy to a failed audit write. The store double
// names its own primitive (as an adapter does); the service relabels it to the operation the caller
// ran, so the wire label does not change.
const down = (primitive: string) => Effect.fail(new StoreUnavailable({ operation: primitive }));

const DownStore = Layer.mock(AuditLogStore.AuditLogStore, {
  append: () => down("AuditLogStore.append"),
  select: () => down("AuditLogStore.select"),
  pageAfter: () => down("AuditLogStore.pageAfter"),
  rewriteReferencing: () => down("AuditLogStore.rewriteReferencing"),
  deleteBefore: () => down("AuditLogStore.deleteBefore"),
});

const DownAuditLog = AuditLog.layer.pipe(Layer.provideMerge(DownStore));

describe("AuditLog infrastructure failures (MA-004)", () => {
  it.effect(
    "every method surfaces a store outage as StoreUnavailable named for the service operation",
    () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const record = yield* auditLog
          .record(stamped(samples["auth.user.created"], 1))
          .pipe(Effect.flip);
        assert.strictEqual(record._tag, "StoreUnavailable");
        assert.strictEqual(record.operation, "AuditLog.record");
        const list = yield* auditLog.list().pipe(Effect.flip);
        assert.strictEqual(list._tag, "StoreUnavailable");
        assert.strictEqual(list._tag === "StoreUnavailable" ? list.operation : "", "AuditLog.list");
        const replay = yield* auditLog.replay().pipe(Stream.runCollect, Effect.flip);
        assert.strictEqual(replay._tag, "StoreUnavailable");
        assert.strictEqual(
          replay._tag === "StoreUnavailable" ? replay.operation : "",
          "AuditLog.replay",
        );
        const pseudonymize = yield* auditLog.pseudonymizeActor(userId).pipe(Effect.flip);
        assert.strictEqual(pseudonymize._tag, "StoreUnavailable");
        assert.strictEqual(pseudonymize.operation, "AuditLog.pseudonymizeActor");
        const purge = yield* auditLog
          .purge({ before: DateTime.makeUnsafe(1_800_000_000_000) })
          .pipe(Effect.flip);
        assert.strictEqual(purge._tag, "StoreUnavailable");
        assert.strictEqual(purge.operation, "AuditLog.purge");
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
