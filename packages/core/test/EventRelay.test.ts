// CWM-004/MAPS-010 (ADR-EA-030): `EventRelay`, the outbox relay that tails the durable audit log into an
// application-provided `EventTransport`. One suite over memory and over SQLite (audit log and cursor both in
// `CoreMigrations`' tables); time is `TestClock`'s, so the settle delay and the poll interval cost nothing.
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as EventRelay from "../src/EventRelay.ts";
import type { Published } from "../src/AuthEventSchemas.ts";
import * as Users from "../src/Users.ts";

class BrokerUnavailable extends Data.TaggedError("BrokerUnavailable") {}

/** A transport that records every batch, and can be told to fail. */
const makeTransport = Effect.gen(function* () {
  const batches = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
  const failing = yield* Ref.make(false);
  const transport: EventRelay.EventTransportShape = {
    deliver: (events: ReadonlyArray<Published>) =>
      Effect.gen(function* () {
        if (yield* Ref.get(failing)) return yield* new BrokerUnavailable();
        yield* Ref.update(batches, (all) => [...all, events.map((event) => event.eventId)]);
      }),
  };
  return {
    transport,
    batches: Ref.get(batches),
    delivered: Ref.get(batches).pipe(Effect.map((all) => all.flat())),
    setFailing: (value: boolean) => Ref.set(failing, value),
  };
});

const publishN = (events: AuthEvents.AuthEventsShape, count: number, prefix = "id") =>
  Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) => events.publish({ _tag: "auth.token.replay", identifier: `${prefix}-${i}` }),
    { discard: true },
  );

const MemoryBase = Layer.mergeAll(EventRelay.layerCursorMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
);

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const SqlBase = EventRelay.layerCursorSql.pipe(
  Layer.provide(Repositories.RelayCursorRepositoryLive),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerSql.pipe(Layer.provide(Repositories.AuditLogRepositoryLive))),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

/** Runs `body` with a fresh transport wired in. */
const withTransport = <A, E, R>(
  body: (t: Effect.Success<typeof makeTransport>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const t = yield* makeTransport;
    return yield* body(t).pipe(
      Effect.provideService(EventRelay.EventTransport, EventRelay.EventTransport.of(t.transport)),
    );
  });

const SETTLE = Duration.seconds(2);
const options = (name = "test", extra: Partial<EventRelay.EventRelayOptions> = {}) => ({
  name,
  ...extra,
});

const suite = (
  name: string,
  base: Layer.Layer<
    AuthEvents.AuthEvents | AuditLog.AuditLog | EventRelay.RelayCursorStore,
    unknown
  >,
) =>
  describe(name, () => {
    it.effect("delivers every audit row once, in order, advancing the position per batch", () =>
      withTransport((t) =>
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          const auditLog = yield* AuditLog.AuditLog;
          yield* publishN(events, 5);
          yield* TestClock.adjust(SETTLE);

          const first = yield* EventRelay.drainOnce(options("test", { batchSize: 3 }));
          const second = yield* EventRelay.drainOnce(options("test", { batchSize: 3 }));
          const third = yield* EventRelay.drainOnce(options("test", { batchSize: 3 }));

          assert.deepStrictEqual([first, second, third], [3, 2, 0]);
          const rows = yield* auditLog.list();
          const oldestFirst = rows.map((row) => row.id).toSorted();
          assert.deepStrictEqual(yield* t.delivered, oldestFirst);
          assert.strictEqual((yield* t.batches).length, 2);
        }).pipe(Effect.provide(base)),
      ),
    );

    it.effect("holds back an event until it has settled", () =>
      withTransport(() =>
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          yield* publishN(events, 2, "early");
          yield* TestClock.adjust(Duration.seconds(1));
          yield* publishN(events, 1, "late");

          // only the first two are older than the 2 s settle delay
          yield* TestClock.adjust(Duration.millis(1500));
          assert.strictEqual(yield* EventRelay.drainOnce(options()), 2);
          assert.strictEqual(yield* EventRelay.drainOnce(options()), 0);

          yield* TestClock.adjust(Duration.seconds(1));
          assert.strictEqual(yield* EventRelay.drainOnce(options()), 1);
        }).pipe(Effect.provide(base)),
      ),
    );

    it.effect(
      "resumes from the stored position: a new relay run redelivers nothing already accepted",
      () =>
        withTransport((t) =>
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            yield* publishN(events, 3, "before");
            yield* TestClock.adjust(SETTLE);
            assert.strictEqual(yield* EventRelay.drainOnce(options()), 3);

            // "restart": the relay has no memory of its own, only the store's position
            yield* publishN(events, 2, "after");
            yield* TestClock.adjust(SETTLE);
            assert.strictEqual(yield* EventRelay.drainOnce(options()), 2);
            const all = yield* t.delivered;
            assert.strictEqual(all.length, 5);
            assert.strictEqual(new Set(all).size, 5);
          }).pipe(Effect.provide(base)),
        ),
    );

    it.effect(
      "redelivers the same batch after a transport failure, leaving the position alone",
      () =>
        withTransport((t) =>
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            yield* publishN(events, 3);
            yield* TestClock.adjust(SETTLE);

            yield* t.setFailing(true);
            const failed = yield* Effect.exit(EventRelay.drainOnce(options()));
            assert.isTrue(Exit.isFailure(failed));
            assert.deepStrictEqual(yield* t.delivered, []);

            yield* t.setFailing(false);
            assert.strictEqual(yield* EventRelay.drainOnce(options()), 3);
            assert.strictEqual((yield* t.delivered).length, 3);
          }).pipe(Effect.provide(base)),
        ),
    );

    it.effect(
      "each relay name keeps its own position, and a tag filter limits what is relayed",
      () =>
        withTransport(() =>
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            yield* publishN(events, 2);
            yield* events.publish({
              _tag: "auth.user.emailVerified",
              userId: Users.UserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            });
            yield* TestClock.adjust(SETTLE);

            assert.strictEqual(
              yield* EventRelay.drainOnce(
                options("only-verified", { eventTag: "auth.user.emailVerified" }),
              ),
              1,
            );
            // another relay has not moved: it still sees all three
            assert.strictEqual(yield* EventRelay.drainOnce(options("everything")), 3);
            assert.strictEqual(
              yield* EventRelay.drainOnce(
                options("only-verified", { eventTag: "auth.user.emailVerified" }),
              ),
              0,
            );
          }).pipe(Effect.provide(base)),
        ),
    );

    it.effect("startAfter seeds a relay that has no stored position", () =>
      withTransport((t) =>
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          const auditLog = yield* AuditLog.AuditLog;
          yield* publishN(events, 4);
          yield* TestClock.adjust(SETTLE);
          const ids = (yield* auditLog.list()).map((row) => row.id).toSorted();
          assert.strictEqual(
            yield* EventRelay.drainOnce(options("seeded", { startAfter: ids.at(1) ?? "" })),
            2,
          );
          assert.deepStrictEqual(yield* t.delivered, ids.slice(2));
        }).pipe(Effect.provide(base)),
      ),
    );

    it.effect(
      "the layer delivers in the background, backs off while the transport is down, and catches up",
      () =>
        withTransport((t) =>
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            yield* publishN(events, 3);
            yield* t.setFailing(true);
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* Layer.build(
                  EventRelay.layer({
                    name: "bg",
                    pollInterval: "1 second",
                    settleDelay: "0 millis",
                    batchSize: 2,
                  }),
                );
                yield* Effect.yieldNow;
                yield* TestClock.adjust(Duration.seconds(10));
                assert.deepStrictEqual(yield* t.delivered, []);

                yield* t.setFailing(false);
                // the backoff has grown, but is capped: a minute is more than enough
                yield* TestClock.adjust(Duration.seconds(60));
                yield* Effect.yieldNow;
                assert.strictEqual((yield* t.delivered).length, 3);
                // a later event is picked up on the next poll
                yield* publishN(events, 1, "later");
                yield* TestClock.adjust(Duration.seconds(2));
                yield* Effect.yieldNow;
                assert.strictEqual((yield* t.delivered).length, 4);
              }),
            );
          }).pipe(Effect.provide(base)),
        ),
    );
  });

suite("EventRelay over memory", MemoryBase);
suite("EventRelay over SQLite", SqlBase);

describe("EventRelay over SQLite: the position is durable", () => {
  it.effect(
    "a second run of the same relay, over the same database, resumes after the stored id",
    () =>
      withTransport((t) =>
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          const store = yield* EventRelay.RelayCursorStore;
          yield* publishN(events, 3);
          yield* TestClock.adjust(SETTLE);
          assert.strictEqual(yield* EventRelay.drainOnce(options("durable")), 3);
          const stored = yield* store.get("durable");
          assert.isTrue(Option.isSome(stored));
          assert.deepStrictEqual(Option.getOrUndefined(stored), (yield* t.delivered).at(-1));
          assert.isTrue(Option.isNone(yield* store.get("someone-else")));
        }).pipe(Effect.provide(SqlBase)),
      ),
  );
});
