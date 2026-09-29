// BEH-EA-262 (spec/behaviors/31-webhooks.md): `Webhooks.background()` end to end, running for real —
// the relay tailing the audit log into the queue and the worker sending it, driven by the test clock,
// with an endpoint that fails once (retry).
import { AuthEvents, EventRelay, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { deliveryLayer, fakeReceiver, seedEndpoint, signedIn } from "./support.ts";

/**
 * Lets the forked relay and worker fibers run between clock ticks. Decrypting an endpoint secret is real
 * (WebCrypto) async work, so a few real milliseconds are given as well as scheduler turns.
 */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 15)));
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

const tick = (by: Duration.Input) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(by);
    yield* settle;
  });

describe("Webhooks.background: relay + worker", () => {
  it.effect("delivers a published event, retries a failed attempt on backoff, and does not resend on a later tick", () =>
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* WebhookRecords.WebhookRecords;
      const { endpoint } = yield* seedEndpoint({ eventTags: ["auth.user.signedIn"] });
      yield* tick(Duration.millis(1));

      yield* Layer.build(
        Webhooks.Webhooks.background({ settleDelay: Duration.seconds(1), pollInterval: Duration.seconds(1) }),
      );
      yield* events.publish(signedIn("live"));
      yield* events.publish({ _tag: "auth.user.created", userId: Users.UserId("filtered-out") });

      // Not yet settled: the relay holds the event back for `settleDelay`.
      yield* tick(Duration.millis(500));
      assert.strictEqual(flaky.sent.length, 0);
      // Settled and relayed; the worker's first attempt fails (the fake answers 500 once) ...
      yield* tick(Duration.seconds(3));
      assert.strictEqual(flaky.sent.length, 1);
      // ... and is retried once the 10s backoff has elapsed, then succeeds.
      yield* tick(Duration.seconds(10));
      assert.strictEqual(flaky.sent.length, 2);
      const rows = yield* records.listDeliveries({ endpointId: endpoint.id, limit: 10 });
      assert.deepStrictEqual(rows.map((row) => [row.eventTag, row.status, row.attempts]), [
        ["auth.user.signedIn", "succeeded", 2],
      ]);
      // Nothing more is sent on later ticks: the cursor is past the event and the row is finished.
      yield* tick(Duration.minutes(5));
      assert.strictEqual(flaky.sent.length, 2);
      assert.strictEqual(flaky.sent[0]?.headers["webhook-id"], flaky.sent[1]?.headers["webhook-id"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(deliveryLayer({ receiver: flaky.layer }), EventRelay.layerCursorMemory)),
    ),
  );
});

let calls = 0;
const flaky = fakeReceiver(() => ({ status: (calls += 1) === 1 ? 500 : 200 }));
