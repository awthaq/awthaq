// BEH-EA-309 (spec/behaviors/34-webhooks.md): endpoints belong to a tenant. An event reaches only the endpoints of
// the tenant it happened in; the platform's own endpoint hears the untenanted events (and every tenant's only when
// `platformEndpointsHearAllTenants` is set); administration is scoped to the ambient tenant, and an endpoint or delivery
// of another tenant is indistinguishable from one that does not exist.
import { AuditLog, AuthEvents, Tenant } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";
import {
  adminLayer,
  adminPrincipal,
  deliveryLayer,
  fakeReceiver,
  published,
  seedEndpoint,
  signedIn,
} from "./support.ts";

const admin = adminPrincipal();

const create = (url = "https://hooks.example.com/awthaq") =>
  Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
    webhooks.createEndpoint(admin, { url, eventTags: ["*"] }),
  );

/** The deliveries an endpoint was given, read as an administrator of `tenant` (the store scopes by it). */
const deliveredEventIds = (endpointId: string, tenant?: string) => {
  const read = Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    records.listDeliveries({ endpointId, limit: 50 }),
  );
  return (tenant === undefined ? read : read.pipe(Tenant.withTenant(tenant))).pipe(
    Effect.map((rows) => rows.map((row) => row.eventId).sort()),
  );
};

describe("events are routed to the endpoints of their own tenant", () => {
  const routing = (hearAll: boolean) =>
    Effect.gen(function* () {
      const platform = (yield* seedEndpoint({ id: "platform" })).endpoint;
      const orgA = (yield* seedEndpoint({ id: "org-a-hook", tenantId: "org-a" })).endpoint;
      const orgB = (yield* seedEndpoint({ id: "org-b-hook", tenantId: "org-b" })).endpoint;
      const inA = yield* published(signedIn("u-a"), { tenantId: Option.some("org-a") });
      const inB = yield* published(signedIn("u-b"), { tenantId: Option.some("org-b") });
      const nowhere = yield* published(signedIn("u-x"));
      yield* WebhookDelivery.enqueue([inA, inB, nowhere]);
      return {
        platform: yield* deliveredEventIds(platform.id),
        a: yield* deliveredEventIds(orgA.id, "org-a"),
        b: yield* deliveredEventIds(orgB.id, "org-b"),
        ids: { inA: inA.eventId, inB: inB.eventId, nowhere: nowhere.eventId },
      };
    }).pipe(
      Effect.provide(deliveryLayer({ config: { platformEndpointsHearAllTenants: hearAll } })),
    );

  it.effect(
    "a tenant's endpoint hears only its tenant; the platform's hears only untenanted events",
    () =>
      Effect.gen(function* () {
        const seen = yield* routing(false);
        assert.deepStrictEqual(seen.a, [seen.ids.inA]);
        assert.deepStrictEqual(seen.b, [seen.ids.inB]);
        assert.deepStrictEqual(seen.platform, [seen.ids.nowhere]);
      }),
  );

  it.effect(
    "platformEndpointsHearAllTenants lets the platform's endpoint hear everyone, never the reverse",
    () =>
      Effect.gen(function* () {
        const seen = yield* routing(true);
        assert.deepStrictEqual(
          seen.platform,
          [seen.ids.inA, seen.ids.inB, seen.ids.nowhere].sort(),
        );
        // A tenant's endpoint is still only its own.
        assert.deepStrictEqual(seen.a, [seen.ids.inA]);
        assert.deepStrictEqual(seen.b, [seen.ids.inB]);
      }),
  );

  it.effect("the delivered body names the tenant, and no tenant leaks into another's data", () =>
    Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const { endpoint } = yield* seedEndpoint({ id: "org-a-hook", tenantId: "org-a" });
      yield* WebhookDelivery.enqueue([
        yield* published(signedIn("u-a"), { tenantId: Option.some("org-a") }),
      ]);
      const [row] = yield* records
        .listDeliveries({ endpointId: endpoint.id, limit: 5 })
        .pipe(Tenant.withTenant("org-a"));
      const body = JSON.parse(row?.body ?? "{}");
      assert.strictEqual(body.tenantId, "org-a");
      // The envelope field is not copied into `data`.
      assert.notProperty(body.data, "tenantId");
    }).pipe(Effect.provide(deliveryLayer())),
  );

  it.effect(
    "end to end: an event published inside a tenant carries the tenant through the audit log to the right endpoint",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const auditLog = yield* AuditLog.AuditLog;
        const orgA = (yield* seedEndpoint({ id: "org-a-hook", tenantId: "org-a" })).endpoint;
        const orgB = (yield* seedEndpoint({ id: "org-b-hook", tenantId: "org-b" })).endpoint;
        yield* events
          .publish({ _tag: "auth.user.signedIn", userId: signedIn().userId, strategy: "password" })
          .pipe(Tenant.withTenant("org-a"));
        const relayed = yield* auditLog.replay().pipe(
          Stream.runCollect,
          Effect.map((rows) => rows.map(AuditLog.toPublished)),
        );
        yield* WebhookDelivery.enqueue(relayed);
        assert.strictEqual((yield* deliveredEventIds(orgA.id, "org-a")).length, 1);
        assert.deepStrictEqual(yield* deliveredEventIds(orgB.id, "org-b"), []);
      }).pipe(Effect.provide(deliveryLayer())),
  );
});

describe("administration is scoped to the ambient tenant", () => {
  it.effect(
    "every by-id operation answers another tenant's endpoint exactly like one that does not exist",
    () =>
      Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        const { endpoint } = yield* create().pipe(Tenant.withTenant("org-a"));
        const asB = Tenant.withTenant("org-b");
        const foreign = [
          yield* webhooks.getEndpoint(admin, endpoint.id).pipe(asB, Effect.flip),
          yield* webhooks
            .updateEndpoint(admin, endpoint.id, { enabled: false })
            .pipe(asB, Effect.flip),
          yield* webhooks.deleteEndpoint(admin, endpoint.id).pipe(asB, Effect.flip),
          yield* webhooks.rotateSecret(admin, endpoint.id).pipe(asB, Effect.flip),
          yield* webhooks.listDeliveries(admin, endpoint.id, {}).pipe(asB, Effect.flip),
          yield* webhooks.testEndpoint(admin, endpoint.id).pipe(asB, Effect.flip),
          // The platform (no tenant) has no view into a tenant's endpoints either.
          yield* webhooks.getEndpoint(admin, endpoint.id).pipe(Effect.flip),
        ];
        const unknown = yield* webhooks.getEndpoint(admin, "nope").pipe(asB, Effect.flip);
        for (const failure of foreign) assert.deepStrictEqual(failure, unknown);
        // And nothing was touched.
        const still = yield* webhooks
          .getEndpoint(admin, endpoint.id)
          .pipe(Tenant.withTenant("org-a"));
        assert.isTrue(still.enabled);
      }).pipe(Effect.provide(adminLayer())),
  );

  it.effect("maxEndpoints is a per-tenant budget", () =>
    Effect.gen(function* () {
      yield* create().pipe(Tenant.withTenant("org-a"));
      const over = yield* create().pipe(Tenant.withTenant("org-a"), Effect.flip);
      assert.strictEqual(over._tag, "WebhookEndpointLimitReached");
      // Another tenant, and the platform, each have their own.
      yield* create().pipe(Tenant.withTenant("org-b"));
      yield* create();
    }).pipe(Effect.provide(adminLayer({ config: { maxEndpoints: 1 } }))),
  );

  it.effect(
    "the receiver of a tenant's endpoint is sent only that tenant's events end to end",
    () => {
      const receiver = fakeReceiver();
      return Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        yield* webhooks
          .createEndpoint(admin, { url: "https://hooks.example.com/a", eventTags: ["*"] })
          .pipe(Tenant.withTenant("org-a"));
        const inA = yield* published(signedIn("u-a"), { tenantId: Option.some("org-a") });
        const inB = yield* published(signedIn("u-b"), { tenantId: Option.some("org-b") });
        yield* WebhookDelivery.enqueue([inB, inA]);
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(receiver.sent.length, 1);
        assert.strictEqual(JSON.parse(receiver.sent[0]?.body ?? "{}").id, inA.eventId);
      }).pipe(Effect.provide(adminLayer({ receiver: receiver.layer })));
    },
  );
});
