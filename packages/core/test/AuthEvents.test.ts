// spec/behaviors/13-events.md, BEH-EA-097 through BEH-EA-104.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as AuthRequestContext from "../src/AuthRequestContext.ts";
import * as Observability from "../src/Observability.ts";
import * as Users from "../src/Users.ts";

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const AuthEventsLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));

describe("AuthEvents", () => {
  it.effect("BEH-EA-098/102: publish returns immediately; stream sees every published event", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      // `startImmediately` runs the forked fiber synchronously up to its own
      // first suspension point (inside the PubSub subscribe, waiting for a
      // published item) before this call returns — the raw `stream` is lazy,
      // so without it the fork is merely scheduled and publishing below could
      // race a subscription that hasn't registered yet. (`subscribe`, below,
      // has no such window.)
      const collected = yield* Effect.forkChild(
        events.stream.pipe(Stream.take(2), Stream.runCollect),
        { startImmediately: true },
      );
      yield* events.publish({ _tag: "auth.user.created", userId });
      yield* events.publish({ _tag: "auth.token.replay", identifier: "verify-email:u1" });
      const result = yield* Fiber.join(collected);
      assert.deepStrictEqual(
        result.map((e) => e._tag),
        ["auth.user.created", "auth.token.replay"],
      );
    }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ALF-002/ESS-001/TMS-002/TRBS-003: publish never suspends against a stuck subscriber; overflow is dropped and counted, not blocked on",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        // A subscription that registers, takes exactly one event, then
        // hangs mid-handler forever — its queue stays open (still an
        // active subscriber) but is never drained again, the
        // "lagging/stuck consumer" these findings describe (an
        // audit/SIEM sink writing to SQL is exactly this shape).
        // `startImmediately` ensures the subscription is registered
        // before any publish below races it.
        yield* Effect.forkChild(events.stream.pipe(Stream.runForEach(() => Effect.never)), {
          startImmediately: true,
        });
        // With the old `PubSub.bounded`, the (CAPACITY + 1)th publish
        // below would suspend the fiber forever (the stuck subscriber
        // never frees space), hanging this test rather than merely
        // failing an assertion.
        const overflow = 6;
        for (let i = 0; i < AuthEvents.CAPACITY + overflow; i++) {
          yield* events.publish({ _tag: "auth.token.replay", identifier: `stress:${i}` });
        }
        // The stuck subscriber's `runForEach` does take (and free the slot
        // for) exactly its first event before stalling on `Effect.never`
        // — so `CAPACITY + 1` of the published events are absorbed (one
        // delivered, `CAPACITY` buffered) and only the remaining
        // `overflow - 1` are dropped.
        assert.strictEqual(yield* events.droppedCount, overflow - 1);
        // MA-009: dropped from the bus, never from the durable log (BEH-EA-100).
        const auditLog = yield* AuditLog.AuditLog;
        assert.strictEqual((yield* auditLog.list()).length, AuthEvents.CAPACITY + overflow);
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "BEH-EA-099/104: a failing subscriber doesn't affect another subscriber or the publisher",
    () =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const events = yield* AuthEvents.AuthEvents;

        const failing = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((e) => e._tag === "auth.token.replay"),
            Stream.runForEach(() => Effect.die(new Error("boom"))),
          ),
          { startImmediately: true },
        );
        const healthy = yield* Effect.forkChild(
          events.stream.pipe(
            Stream.filter((e) => e._tag === "auth.token.replay"),
            Stream.take(1),
            Stream.runForEach((e) =>
              e._tag === "auth.token.replay"
                ? Ref.update(seen, (s) => [...s, e.identifier])
                : Effect.void,
            ),
          ),
          { startImmediately: true },
        );

        yield* events.publish({ _tag: "auth.token.replay", identifier: "reset-password:u2" });

        // The publisher itself never observed the failing subscriber's death.
        yield* Fiber.join(healthy);
        assert.deepStrictEqual(yield* Ref.get(seen), ["reset-password:u2"]);
        yield* Fiber.interrupt(failing);
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ALF-007/ETVS-001: on(tag, handler) delivers an event published right after the Layer is built, and only for its own tag",
    () =>
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<string>();
        const events = yield* AuthEvents.AuthEvents;
        // No sleep, no yield: the subscription was registered while the Layer built.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              AuthEvents.on("auth.token.replay", (event) => Queue.offer(seen, event.identifier)),
            );
            yield* events.publish({ _tag: "auth.user.signedIn", userId, strategy: "password" });
            yield* events.publish({ _tag: "auth.token.replay", identifier: "reset-password:u1" });
            assert.strictEqual(yield* Queue.take(seen), "reset-password:u1");
            // The signedIn event was filtered out: nothing else is queued.
            yield* Effect.yieldNow;
            assert.strictEqual(yield* Queue.size(seen), 0);
          }),
        );
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ESS-007: on([a, b], h) delivers both tags through one subscription and nothing else",
    () =>
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<string>();
        const events = yield* AuthEvents.AuthEvents;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              AuthEvents.on(["auth.user.created", "auth.token.replay"], (event) =>
                Queue.offer(seen, event._tag),
              ),
            );
            yield* events.publish({ _tag: "auth.user.created", userId });
            yield* events.publish({ _tag: "auth.user.signedIn", userId, strategy: "password" });
            yield* events.publish({ _tag: "auth.token.replay", identifier: "x" });
            assert.strictEqual(yield* Queue.take(seen), "auth.user.created");
            assert.strictEqual(yield* Queue.take(seen), "auth.token.replay");
            yield* Effect.yieldNow;
            assert.strictEqual(yield* Queue.size(seen), 0);
          }),
        );
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect("ESS-004: onBatch groups up to `size` events, or flushes after `within`", () =>
    Effect.gen(function* () {
      const batches = yield* Queue.unbounded<ReadonlyArray<string>>();
      const events = yield* AuthEvents.AuthEvents;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            AuthEvents.onBatch("auth.token.replay", { size: 3, within: "5 seconds" }, (batch) =>
              Queue.offer(
                batches,
                batch.map((event) => event.identifier),
              ),
            ),
          );
          for (const id of ["a", "b", "c", "d"]) {
            yield* events.publish({ _tag: "auth.token.replay", identifier: id });
          }
          // A full batch flushes without waiting for the window...
          assert.deepStrictEqual(yield* Queue.take(batches), ["a", "b", "c"]);
          // ...and the remainder flushes when the window elapses.
          yield* TestClock.adjust("5 seconds");
          assert.deepStrictEqual(yield* Queue.take(batches), ["d"]);
        }),
      );
    }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ECF-010: a drain that dies outside the handler is logged and resubscribed, and keeps delivering",
    () =>
      Effect.gen(function* () {
        const delivered = yield* Deferred.make<string>();
        const logged = yield* Ref.make<ReadonlyArray<string>>([]);
        const subscriptions = yield* Ref.make(0);
        const good = {
          ...eventFixture("auth.token.replay", "after-restart"),
        };
        // A fake bus: the first subscription's stream dies (a defect the handler's own
        // isolation cannot see), the second delivers one event.
        const FakeEvents = Layer.succeed(
          AuthEvents.AuthEvents,
          AuthEvents.AuthEvents.of({
            publish: () => Effect.void,
            stream: Stream.empty,
            subscribe: Ref.updateAndGet(subscriptions, (n) => n + 1).pipe(
              Effect.map((n) =>
                n === 1 ? Stream.die(new Error("drain defect")) : Stream.make(good),
              ),
            ),
            droppedCount: Effect.succeed(0),
          }),
        );
        const Capture = Logger.layer([
          Logger.make((options) => {
            if (String(options.message).includes("auth.event.subscription.died")) {
              Effect.runSync(Ref.update(logged, (l) => [...l, "died"]));
            }
          }),
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              AuthEvents.on("auth.token.replay", (event) =>
                Deferred.succeed(delivered, event.identifier),
              ).pipe(Layer.provide(FakeEvents), Layer.provide(Capture)),
            );
            yield* TestClock.adjust("1 second");
            assert.strictEqual(yield* Deferred.await(delivered), "after-restart");
            assert.deepStrictEqual(yield* Ref.get(logged), ["died"]);
          }),
        );
      }),
  );

  it.effect(
    "EOTS-005: a failing subscriber's error-level log names the error's tag but never its data; the cause is debug-only",
    () => {
      const records = Ref.makeUnsafe<ReadonlyArray<{ level: string; text: string }>>([]);
      const Capture = Logger.layer([
        Logger.make((options) => {
          Effect.runSync(
            Ref.update(records, (r) => [
              ...r,
              { level: options.logLevel, text: JSON.stringify(options.message, replacer) },
            ]),
          );
        }),
      ]);
      return Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const events = yield* AuthEvents.AuthEvents;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              AuthEvents.on("auth.token.replay", () =>
                Effect.fail({ _tag: "SinkError", token: "s3cr3t-token-value" }).pipe(
                  Effect.ensuring(Deferred.succeed(done, undefined)),
                ),
              ),
            );
            yield* events.publish({ _tag: "auth.token.replay", identifier: "x" });
            yield* Deferred.await(done);
            yield* Effect.yieldNow;
          }),
        );
        const all = yield* Ref.get(records);
        const errors = all.filter((r) => r.level === "Error" && r.text.includes("observer.error"));
        assert.strictEqual(errors.length, 1);
        assert.include(errors[0]?.text ?? "", "SinkError");
        assert.notInclude(errors[0]?.text ?? "", "s3cr3t-token-value");
        const debug = all.filter((r) => r.level === "Debug" && r.text.includes("observer.error"));
        assert.strictEqual(debug.length, 1);
        assert.include(debug[0]?.text ?? "", "s3cr3t-token-value");
      }).pipe(
        Effect.provide(Layer.merge(AuthEventsLive, Capture)),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    },
  );

  it.effect(
    "EOTS-005/JH-002: subscriber failures are counted in awthaq_event_observer_error_total",
    () => {
      const counter = Metric.withAttributes(Observability.eventObserverErrors, {
        tag: "auth.token.replay",
      });
      return Effect.gen(function* () {
        const before = (yield* Metric.value(counter)).count;
        const done = yield* Deferred.make<void>();
        const events = yield* AuthEvents.AuthEvents;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(
              AuthEvents.on("auth.token.replay", () =>
                Effect.die(new Error("boom")).pipe(
                  Effect.ensuring(Deferred.succeed(done, undefined)),
                ),
              ),
            );
            yield* events.publish({ _tag: "auth.token.replay", identifier: "x" });
            yield* Deferred.await(done);
            yield* Effect.yieldNow;
          }),
        );
        assert.strictEqual((yield* Metric.value(counter)).count - before, 1);
      }).pipe(Effect.provide(AuthEventsLive));
    },
  );

  it.effect(
    "ESA-002: every delivered event carries eventId and occurredAt equal to its AuditLog row",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* events.subscribe;
            const collected = yield* Effect.forkChild(
              stream.pipe(Stream.take(1), Stream.runCollect),
              { startImmediately: true },
            );
            yield* TestClock.adjust("42 millis");
            yield* events.publish({ _tag: "auth.user.created", userId });
            const [delivered] = yield* Fiber.join(collected);
            const [row] = yield* auditLog.list();
            assert.isDefined(delivered);
            assert.isDefined(row);
            assert.strictEqual(delivered?.eventId, row?.id);
            assert.strictEqual(delivered?.occurredAt.epochMilliseconds, 42);
            assert.deepStrictEqual(delivered?.occurredAt, row?.occurredAt);
          }),
        );
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ESA-002: event ids are time-ordered, so they sort in publish order even within one millisecond",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        for (let i = 0; i < 25; i++) {
          yield* events.publish({ _tag: "auth.token.replay", identifier: `n${i}` });
        }
        const replayed = Array.from(yield* auditLog.replay().pipe(Stream.runCollect), (record) =>
          record.payload._tag === "auth.token.replay" ? record.payload.identifier : "",
        );
        assert.deepStrictEqual(
          replayed,
          Array.from({ length: 25 }, (_, i) => `n${i}`),
        );
        const [row] = yield* auditLog.list();
        assert.match(
          row?.id ?? "",
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "ALF-006: publish stamps correlationId, ip and userAgent from AuthRequestContext, on the bus and in the audit row",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* events.subscribe;
            const collected = yield* Effect.forkChild(
              stream.pipe(Stream.take(2), Stream.runCollect),
              { startImmediately: true },
            );
            yield* events.publish({ _tag: "auth.user.created", userId }).pipe(
              Effect.provideService(AuthRequestContext.AuthRequestContext, {
                correlationId: Option.some("req-1"),
                ip: Option.some("203.0.113.9"),
                userAgent: Option.some("vitest"),
              }),
            );
            yield* events.publish({ _tag: "auth.token.replay", identifier: "outside-a-request" });
            const delivered = yield* Fiber.join(collected);
            assert.deepStrictEqual(delivered[0]?.correlationId, Option.some("req-1"));
            assert.deepStrictEqual(delivered[0]?.ip, Option.some("203.0.113.9"));
            assert.deepStrictEqual(delivered[1]?.correlationId, Option.none());
            const rows = yield* auditLog.list({ eventTag: "auth.user.created" });
            assert.deepStrictEqual(rows[0]?.correlationId, Option.some("req-1"));
            assert.deepStrictEqual(rows[0]?.ip, Option.some("203.0.113.9"));
            assert.deepStrictEqual(rows[0]?.userAgent, Option.some("vitest"));
          }),
        );
      }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect("ALF-006: the envelope names the span that was current at the publish site", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* events.subscribe;
          const collected = yield* Effect.forkChild(
            stream.pipe(Stream.take(2), Stream.runCollect),
            { startImmediately: true },
          );
          yield* Effect.withSpan("request")(
            Effect.gen(function* () {
              const request = yield* Effect.currentSpan;
              yield* events.publish({ _tag: "auth.token.replay", identifier: "in-request" });
              return request;
            }),
          ).pipe(
            Effect.flatMap((request) =>
              Effect.gen(function* () {
                yield* events.publish({ _tag: "auth.token.replay", identifier: "no-span" });
                const [inRequest, noSpan] = yield* Fiber.join(collected);
                assert.deepStrictEqual(inRequest?.traceId, Option.some(request.traceId));
                assert.deepStrictEqual(inRequest?.spanId, Option.some(request.spanId));
                assert.deepStrictEqual(noSpan?.traceId, Option.none());
              }),
            ),
          );
        }),
      );
    }).pipe(Effect.provide(AuthEventsLive)),
  );

  it.effect(
    "BEH-EA-100: publish durably records every event via AuditLog, with zero subscribers",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        yield* events.publish({ _tag: "auth.user.created", userId });
        yield* events.publish({ _tag: "auth.token.replay", identifier: "verify-email:u1" });
        const recorded = yield* auditLog.list();
        assert.deepStrictEqual(recorded.map((r) => r.eventTag).toSorted(), [
          "auth.token.replay",
          "auth.user.created",
        ]);
      }).pipe(Effect.provide(AuthEventsLive)),
  );
});

// ---- helpers ------------------------------------------------------------------

/** A delivered-event fixture for tests that fake the bus itself. */
function eventFixture(
  tag: "auth.token.replay",
  identifier: string,
): AuthEvents.Published<AuthEvents.EventOf<"auth.token.replay">> {
  return {
    _tag: tag,
    identifier,
    eventId: "018f0000-0000-7000-8000-000000000001",
    occurredAt: DateTime.makeUnsafe(0),
    correlationId: Option.none(),
    traceId: Option.none(),
    spanId: Option.none(),
    ip: Option.none(),
    userAgent: Option.none(),
  };
}

/** `JSON.stringify` replacer that renders a `Cause` as its structure, so a log's whole payload can be searched. */
const replacer = (_key: string, value: unknown): unknown =>
  Cause.isCause(value) ? { cause: Cause.pretty(value) } : value;
