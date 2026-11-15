// Phase 6 Wave 0 oracle (REC-03): the equal-createdAt order of the webhook listings the comparator helper rewrites
// (WebhookRecords.listEndpoints, listEnabledEndpoints and listBySubject), on both adapters. Expected orders are
// literals over canonical ids. Never edited after its add commit.
import { Auth } from "@awthaq/core";
import { HostResolver, Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";

const X = "019a8f00-0000-7000-8000-000000000009";
const A = "019a8f00-0000-7000-8000-000000000001";
const B = "019a8f00-0000-7000-8000-000000000002";
const C = "019a8f00-0000-7000-8000-000000000003";
const OTHER = "019a8f00-0000-7000-8000-000000000007";

const relay = TenantScoped.crossTenant("webhooks order pins: the relay serves every tenant");

const endpointInput = (id: string) => ({
  id,
  url: `https://${id}.example.com/hook`,
  description: `endpoint ${id}`,
  eventTags: ["*"],
  secret: Redacted.make(`secret-${id}`),
  createdBy: "admin-1",
});

const newDelivery = (id: string, endpointId: string, subjectUserId: string) => ({
  id,
  endpointId,
  eventId: `event-${id}`,
  eventTag: "auth.user.signedIn",
  subjectUserId,
  body: `{"id":"event-${id}"}`,
  nextAttemptAt: DateTime.makeUnsafe(1_000),
});

const built = Auth.make([Webhooks.Webhooks]);
const services = Layer.mergeAll(HostResolver.layerStatic({}), Webhooks.config({}));

const compositions = {
  memory: TestAuth.layer(built, { services }),
  sql: TestAuth.layer(built, { records: "sql", suite: "webhooks_RecordOrderPins", services }),
};

/** Endpoints X, then C, A, B at one later instant (supplied ids). */
const seedEndpoints = Effect.gen(function* () {
  const records = yield* WebhookRecords.WebhookRecords;
  yield* records.createEndpoint(endpointInput(X));
  yield* TestClock.adjust("1 millis");
  yield* records.createEndpoint(endpointInput(C));
  yield* records.createEndpoint(endpointInput(A));
  yield* records.createEndpoint(endpointInput(B));
  return records;
});

for (const [mode, Live] of Object.entries(compositions)) {
  describe(`webhooks record order pins (${mode})`, () => {
    it.effect("WebhookRecords.listEndpoints: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* seedEndpoints;
        yield* records.createEndpoint(endpointInput(OTHER)).pipe(Tenant.withTenant("org-other"));
        assert.deepStrictEqual(
          (yield* records.listEndpoints).map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("WebhookRecords.listEnabledEndpoints: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* seedEndpoints;
        assert.deepStrictEqual(
          (yield* records.listEnabledEndpoints(relay)).map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );

    it.effect("WebhookRecords.listBySubject: time first, then id, ascending", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("endpoint-pin"));
        yield* records.enqueue([newDelivery(X, "endpoint-pin", "user-pin")]);
        yield* TestClock.adjust("1 millis");
        yield* records.enqueue([newDelivery(C, "endpoint-pin", "user-pin")]);
        yield* records.enqueue([newDelivery(A, "endpoint-pin", "user-pin")]);
        yield* records.enqueue([newDelivery(B, "endpoint-pin", "user-pin")]);
        yield* records.enqueue([newDelivery(OTHER, "endpoint-pin", "user-other")]);
        assert.deepStrictEqual(
          (yield* records.listBySubject(relay, "user-pin")).map((row) => row.id),
          [X, A, B, C],
        );
      }).pipe(TestAuth.withoutRequest, Effect.provide(Live)),
    );
  });
}
