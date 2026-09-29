// BEH-EA-279/280 (spec/behaviors/34-webhooks.md): `WebhookRecords`, one contract suite over both layers.
// `layerSql` is migrated through the plugin's own real `migrations` (and, under `pnpm run test:pg`,
// runs on Postgres), so the unique (endpoint, event) pair is a real database constraint.
import { Migrations } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("webhooks_WebhookRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Webhooks.Webhooks.migrations)).pipe(
  Layer.provide(SqlLive),
);

const SqlLayer = WebhookRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const at = (millis: number) => DateTime.makeUnsafe(millis);

const endpointInput = (id: string, extra: { readonly tags?: ReadonlyArray<string> } = {}) => ({
  id,
  url: `https://${id}.example.com/hook`,
  description: `endpoint ${id}`,
  eventTags: extra.tags ?? ["*"],
  secret: `sealed-${id}`,
  createdBy: "admin-1",
});

const newDelivery = (
  id: string,
  endpointId: string,
  eventId: string,
  nextAttemptAt = at(1_000),
  subjectUserId?: string,
): WebhookRecords.NewDelivery => ({
  id,
  endpointId,
  eventId,
  eventTag: "auth.user.signedIn",
  subjectUserId,
  body: `{"id":"${eventId}"}`,
  nextAttemptAt,
});

const suite = (
  name: string,
  layer: Layer.Layer<WebhookRecords.WebhookRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("an endpoint round-trips, lists oldest first, and is edited in place", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const created = yield* records.createEndpoint(endpointInput("a", { tags: ["auth.user.*", "auth.session.revoked"] }));
        assert.deepStrictEqual(created.eventTags, ["auth.user.*", "auth.session.revoked"]);
        assert.deepStrictEqual(created.description, Option.some("endpoint a"));
        assert.isTrue(Option.isNone(created.disabledAt));
        yield* TestClockTick;
        yield* records.createEndpoint(endpointInput("b"));
        assert.deepStrictEqual(
          (yield* records.listEndpoints).map((row) => row.id),
          ["a", "b"],
        );
        const edited = yield* records.updateEndpoint("a", {
          url: "https://moved.example.com/hook",
          description: null,
          eventTags: ["*"],
        });
        assert.strictEqual(edited.url, "https://moved.example.com/hook");
        assert.isTrue(Option.isNone(edited.description));
        assert.deepStrictEqual(edited.eventTags, ["*"]);
        // Fields left out are untouched.
        const untouched = yield* records.updateEndpoint("a", {});
        assert.strictEqual(untouched.url, "https://moved.example.com/hook");
        const missing = yield* records.updateEndpoint("nope", {}).pipe(Effect.flip);
        assert.strictEqual(missing._tag, "WebhookRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );

    it.effect("secrets and the disabled flag are written whole; re-enabling resets the failure count", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        const rotated = yield* records.setSecrets("a", {
          secret: "sealed-new",
          previousSecret: "sealed-old",
          previousSecretExpiresAt: at(5_000),
        });
        assert.strictEqual(rotated.secret, "sealed-new");
        assert.deepStrictEqual(rotated.previousSecret, Option.some("sealed-old"));
        assert.deepStrictEqual(rotated.previousSecretExpiresAt, Option.some(at(5_000)));
        const cleared = yield* records.setSecrets("a", {
          secret: "sealed-new",
          previousSecret: null,
          previousSecretExpiresAt: null,
        });
        assert.isTrue(Option.isNone(cleared.previousSecret));

        assert.strictEqual(yield* records.bumpDead("a"), 1);
        assert.strictEqual(yield* records.bumpDead("a"), 2);
        const off = yield* records.setDisabled("a", { at: at(2_000), reason: "failing" });
        assert.deepStrictEqual(off.disabledReason, Option.some("failing"));
        assert.strictEqual(off.consecutiveDead, 2);
        const on = yield* records.setDisabled("a", null);
        assert.isTrue(Option.isNone(on.disabledAt));
        assert.strictEqual(on.consecutiveDead, 0);
        yield* records.bumpDead("a");
        yield* records.clearDead("a");
        assert.strictEqual((yield* records.findEndpoint("a")).pipe(Option.map((row) => row.consecutiveDead), Option.getOrElse(() => -1)), 0);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("enqueue is idempotent on (endpoint, event): a redelivered batch adds nothing", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.createEndpoint(endpointInput("b"));
        assert.strictEqual(yield* records.enqueue([newDelivery("d1", "a", "e1"), newDelivery("d2", "b", "e1")]), 2);
        // The relay hands the same batch again (crash before its cursor write) — plus one new event.
        assert.strictEqual(
          yield* records.enqueue([
            newDelivery("d3", "a", "e1"),
            newDelivery("d4", "b", "e1"),
            newDelivery("d5", "a", "e2"),
          ]),
          1,
        );
        assert.deepStrictEqual(
          (yield* records.listDeliveries({ endpointId: "a", limit: 10 })).map((row) => row.id),
          ["d5", "d1"],
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("claimDue leases: what is due is handed out once, oldest first, and skips disabled endpoints", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.createEndpoint(endpointInput("off"));
        yield* records.setDisabled("off", { at: at(0), reason: "manual" });
        yield* records.enqueue([
          newDelivery("d1", "a", "e1", at(1_000)),
          newDelivery("d2", "a", "e2", at(500)),
          newDelivery("d3", "a", "e3", at(900_000)), // not due yet
          newDelivery("d4", "off", "e1", at(0)), // endpoint switched off
        ]);
        const lease = Duration.seconds(60);
        const first = yield* records.claimDue({ now: at(2_000), limit: 10, lease });
        assert.deepStrictEqual(first.map((row) => row.id), ["d2", "d1"]);
        // A second worker finds nothing: the rows are leased.
        assert.deepStrictEqual(yield* records.claimDue({ now: at(2_001), limit: 10, lease }), []);
        // The lease lapses (a worker that died): the rows are due again.
        const again = yield* records.claimDue({ now: at(2_000 + 60_000), limit: 10, lease });
        assert.deepStrictEqual(again.map((row) => row.id), ["d1", "d2"]);
        // limit is honoured.
        const limited = yield* records.claimDue({ now: at(2_000 + 200_000), limit: 1, lease });
        assert.strictEqual(limited.length, 1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("outcomes move a delivery: succeeded, rescheduled, deferred, dead, redriven", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.enqueue([
          newDelivery("ok", "a", "e1"),
          newDelivery("retry", "a", "e2"),
          newDelivery("dead", "a", "e3"),
        ]);
        yield* records.markSucceeded("ok", { at: at(2_000), statusCode: 204 });
        const ok = yield* records.findDelivery("ok");
        assert.isTrue(Option.isSome(ok));
        if (Option.isSome(ok)) {
          assert.strictEqual(ok.value.status, "succeeded");
          assert.strictEqual(ok.value.attempts, 1);
          assert.deepStrictEqual(ok.value.lastStatusCode, Option.some(204));
          assert.isTrue(Option.isSome(ok.value.completedAt));
        }

        yield* records.reschedule("retry", { at: at(2_000), nextAttemptAt: at(12_000), statusCode: 503, error: "status" });
        yield* records.defer("retry", at(13_000));
        const retry = yield* records.findDelivery("retry");
        if (Option.isSome(retry)) {
          assert.strictEqual(retry.value.status, "pending");
          // The deferral is not an attempt.
          assert.strictEqual(retry.value.attempts, 1);
          assert.deepStrictEqual(retry.value.nextAttemptAt, at(13_000));
          assert.deepStrictEqual(retry.value.lastError, Option.some("status"));
        }

        yield* records.markDead("dead", { at: at(3_000), error: "timeout" });
        // Only a dead delivery can be redriven.
        const notDead = yield* records.redrive("retry", at(4_000)).pipe(Effect.flip);
        assert.strictEqual(notDead._tag, "WebhookRecordNotFound");
        const revived = yield* records.redrive("dead", at(4_000));
        assert.strictEqual(revived.status, "pending");
        assert.strictEqual(revived.attempts, 0);
        assert.isTrue(Option.isNone(revived.completedAt));
        assert.deepStrictEqual(revived.nextAttemptAt, at(4_000));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("listDeliveries pages newest first by id and filters on status", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.createEndpoint(endpointInput("b"));
        yield* records.enqueue([
          newDelivery("d1", "a", "e1"),
          newDelivery("d2", "a", "e2"),
          newDelivery("d3", "a", "e3"),
          newDelivery("d4", "b", "e1"),
        ]);
        yield* records.markDead("d2", { at: at(2_000), error: "status" });
        const page1 = yield* records.listDeliveries({ endpointId: "a", limit: 2 });
        assert.deepStrictEqual(page1.map((row) => row.id), ["d3", "d2"]);
        const page2 = yield* records.listDeliveries({ endpointId: "a", limit: 2, before: "d2" });
        assert.deepStrictEqual(page2.map((row) => row.id), ["d1"]);
        const dead = yield* records.listDeliveries({ endpointId: "a", status: "dead", limit: 10 });
        assert.deepStrictEqual(dead.map((row) => row.id), ["d2"]);
        // Another endpoint's rows never leak in.
        assert.deepStrictEqual(
          (yield* records.listDeliveries({ endpointId: "b", limit: 10 })).map((row) => row.id),
          ["d4"],
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("prunes finished rows past the cutoff, never pending ones", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.enqueue([
          newDelivery("old-ok", "a", "e1"),
          newDelivery("new-ok", "a", "e2"),
          newDelivery("old-dead", "a", "e3"),
          newDelivery("pending", "a", "e4"),
        ]);
        yield* records.markSucceeded("old-ok", { at: at(1_000) });
        yield* records.markSucceeded("new-ok", { at: at(9_000) });
        yield* records.markDead("old-dead", { at: at(1_500) });
        assert.strictEqual(yield* records.pruneFinished(at(5_000)), 2);
        assert.deepStrictEqual(
          (yield* records.listDeliveries({ endpointId: "a", limit: 10 })).map((row) => row.id).sort(),
          ["new-ok", "pending"],
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect("deleting an endpoint removes its deliveries; erasure removes a subject's rows only", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.createEndpoint(endpointInput("b"));
        yield* records.enqueue([
          newDelivery("d1", "a", "e1", at(1_000), "user-1"),
          newDelivery("d2", "b", "e1", at(1_000), "user-1"),
          newDelivery("d3", "b", "e2", at(1_000), "user-2"),
        ]);
        assert.deepStrictEqual(
          (yield* records.listBySubject("user-1")).map((row) => row.id).sort(),
          ["d1", "d2"],
        );
        yield* records.deleteBySubject("user-1");
        assert.deepStrictEqual(yield* records.listBySubject("user-1"), []);
        assert.strictEqual((yield* records.listBySubject("user-2")).length, 1);

        yield* records.deleteEndpoint("b");
        assert.deepStrictEqual(yield* records.listDeliveries({ endpointId: "b", limit: 10 }), []);
        assert.isTrue(Option.isNone(yield* records.findEndpoint("b")));
        const again = yield* records.deleteEndpoint("b").pipe(Effect.flip);
        assert.strictEqual(again._tag, "WebhookRecordNotFound");
      }).pipe(Effect.provide(layer)),
    );
  });
};

/** Two `createdAt`s that sort (the memory layer stamps the ambient clock, which `it.effect` freezes). */
const TestClockTick = TestClock.adjust(Duration.millis(5));

suite("WebhookRecords (layerMemory)", WebhookRecords.layerMemory);
suite("WebhookRecords (layerSql)", SqlLayer);
