// BEH-EA-279 (spec/behaviors/34-webhooks.md): `Webhooks.background()` end to end, running for real —
// the relay tailing the audit log into the queue and the worker sending it, driven by the test clock,
// with an endpoint that fails once (retry).
import { AuthEvents, EventRelay, Retention, Users } from "@awthaq/core";
import { Tenant } from "@awthaq/ports";
import { StoreFailure } from "@awthaq/sql";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { deliveryLayer, fakeReceiver, published, seedEndpoint, signedIn } from "./support.ts";

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
  it.effect(
    "delivers a published event, retries a failed attempt on backoff, and does not resend on a later tick",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const records = yield* WebhookRecords.WebhookRecords;
        const { endpoint } = yield* seedEndpoint({ eventTags: ["auth.user.signedIn"] });
        yield* tick(Duration.millis(1));

        yield* Layer.build(
          Webhooks.Webhooks.background({
            settleDelay: Duration.seconds(1),
            pollInterval: Duration.seconds(1),
          }),
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
        assert.deepStrictEqual(
          rows.map((row) => [row.eventTag, row.status, row.attempts]),
          [["auth.user.signedIn", "succeeded", 2]],
        );
        // Nothing more is sent on later ticks: the cursor is past the event and the row is finished.
        yield* tick(Duration.minutes(5));
        assert.strictEqual(flaky.sent.length, 2);
        assert.strictEqual(
          flaky.sent[0]?.headers["webhook-id"],
          flaky.sent[1]?.headers["webhook-id"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(deliveryLayer({ receiver: flaky.layer }), EventRelay.layerCursorMemory),
        ),
      ),
  );
});

describe("Webhooks retention contribution", () => {
  it.effect("Retention.sweep deletes finished deliveries older than deliveryRetention only", () => {
    const receiver = fakeReceiver();
    return Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const { endpoint } = yield* seedEndpoint({ eventTags: ["auth.user.signedIn"] });
      yield* WebhookDelivery.enqueue([yield* published(signedIn("sweep"))]);
      yield* WebhookDelivery.drainDue;
      const listed = () => records.listDeliveries({ endpointId: endpoint.id, limit: 10 });
      assert.deepStrictEqual(
        (yield* listed()).map((row) => row.status),
        ["succeeded"],
      );
      // Inside the 30-day default window: kept.
      yield* TestClock.adjust(Duration.days(29));
      const kept = yield* Retention.sweep;
      assert.strictEqual(kept.plugins.find((p) => p.id === "webhooks.deliveries")?.deleted, 0);
      assert.strictEqual((yield* listed()).length, 1);
      // Past it: gone.
      yield* TestClock.adjust(Duration.days(2));
      const swept = yield* Retention.sweep;
      assert.deepStrictEqual(
        swept.plugins.find((p) => p.id === "webhooks.deliveries"),
        { id: "webhooks.deliveries", deleted: 1, failed: false },
      );
      assert.strictEqual((yield* listed()).length, 0);
    }).pipe(Effect.provide(deliveryLayer({ receiver: receiver.layer })));
  });
});

describe("Webhooks.background: a store outage", () => {
  it.effect(
    "in claimDue is logged and retried on the next tick, and the worker keeps running",
    () => {
      const receiver = fakeReceiver();
      let outages = 1;
      // The first claim finds the store down; every later one reaches the real records.
      const flaky = Layer.effect(
        WebhookRecords.WebhookRecords,
        Effect.map(WebhookRecords.WebhookRecords, (records) =>
          WebhookRecords.WebhookRecords.of({
            ...records,
            claimDue: (grant, input) => {
              if (outages <= 0) return records.claimDue(grant, input);
              outages -= 1;
              return Effect.fail(
                new StoreFailure.StoreUnavailable({ operation: "WebhookRecords.claimDue" }),
              );
            },
          }),
        ),
      ).pipe(Layer.provideMerge(deliveryLayer({ receiver: receiver.layer })));
      return Effect.gen(function* () {
        yield* seedEndpoint({ eventTags: ["auth.user.signedIn"] });
        yield* WebhookDelivery.enqueue([yield* published(signedIn("outage"))]);
        yield* Layer.build(
          WebhookDelivery.workerLayer.pipe(
            Layer.provide(Webhooks.config({ pollInterval: Duration.seconds(1) })),
          ),
        );
        yield* tick(Duration.millis(10));
        assert.strictEqual(outages, 0, "the first claim hit the outage");
        assert.strictEqual(receiver.sent.length, 0);
        // The worker backs off and tries again; this time the store answers.
        yield* tick(Duration.seconds(5));
        assert.strictEqual(receiver.sent.length, 1);
      }).pipe(Effect.scoped, Effect.provide(flaky));
    },
  );
});

describe("Webhooks.background: tenants", () => {
  // Plan 05 phase 2: the store confines `findEndpoint` to the ambient tenant, and the relay and the
  // worker run with none; without their witness a tenant's delivery would be marked `endpointGone`.
  it.effect(
    "a tenant's endpoint receives its delivery when the relay runs with no ambient tenant",
    () => {
      const receiver = fakeReceiver();
      return Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const records = yield* WebhookRecords.WebhookRecords;
        const { endpoint } = yield* seedEndpoint({
          eventTags: ["auth.user.signedIn"],
          tenantId: "org-a",
        });
        yield* tick(Duration.millis(1));
        yield* Layer.build(
          Webhooks.Webhooks.background({
            settleDelay: Duration.seconds(1),
            pollInterval: Duration.seconds(1),
          }),
        );
        yield* events.publish(signedIn("in-a")).pipe(Tenant.withTenant("org-a"));
        yield* tick(Duration.seconds(3));
        assert.strictEqual(receiver.sent.length, 1);
        const rows = yield* records
          .listDeliveries({ endpointId: endpoint.id, limit: 10 })
          .pipe(Tenant.withTenant("org-a"));
        assert.deepStrictEqual(
          rows.map((row) => [row.status, row.lastError._tag]),
          [["succeeded", "None"]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(deliveryLayer({ receiver: receiver.layer }), EventRelay.layerCursorMemory),
        ),
      );
    },
  );
});

let calls = 0;
const flaky = fakeReceiver(() => ({ status: (calls += 1) === 1 ? 500 : 200 }));
