// spec/behaviors/13-events.md, BEH-EA-097 through BEH-EA-104.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as Users from "../src/Users.ts";

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

const AuthEventsLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));

describe("AuthEvents", () => {
  it.effect("BEH-EA-098/102: publish returns immediately; stream sees every published event", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      // `startImmediately` runs the forked fiber synchronously up to its own
      // first suspension point (inside the PubSub subscribe, waiting for a
      // published item) before this call returns — without it, the fork is
      // merely scheduled, and publishing below could race a subscription
      // that hasn't registered with the PubSub yet.
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
            Stream.runForEach((e) => Ref.update(seen, (s) => [...s, e.identifier])),
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

  const seen = Effect.runSync(Ref.make<ReadonlyArray<string>>([]));
  const Subscription = AuthEvents.on("auth.token.replay", (event) =>
    Ref.update(seen, (s) => [...s, event.identifier]),
  );

  it.live("BEH-EA-103: on(tag, handler) only invokes the handler for its own tag", () =>
    Effect.gen(function* () {
      yield* Ref.set(seen, []);
      const events = yield* AuthEvents.AuthEvents;
      // Real wall-clock time (`it.live`, not `it.effect`'s `TestClock`): a
      // small real sleep gives the subscription Layer's own internally
      // forked fiber (built without `startImmediately`, since `on`'s public
      // signature has no such knob) a chance to actually subscribe.
      yield* Effect.sleep("20 millis");
      yield* events.publish({ _tag: "auth.user.signedIn", userId, strategy: "password" });
      yield* events.publish({ _tag: "auth.token.replay", identifier: "reset-password:u1" });
      yield* Effect.sleep("20 millis");
      assert.deepStrictEqual(yield* Ref.get(seen), ["reset-password:u1"]);
    }).pipe(Effect.provide(Subscription.pipe(Layer.provideMerge(AuthEventsLive)))),
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
