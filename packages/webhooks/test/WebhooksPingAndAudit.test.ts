// BEH-EA-301 (the test ping) and BEH-EA-302 (audit events for successful administrative mutations)
// (spec/behaviors/34-webhooks.md).
import { AuditLog, Tenant } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSignature from "../src/WebhookSignature.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { adminLayer, adminPrincipal, fakeReceiver } from "./support.ts";

const admin = adminPrincipal();

const create = (url = "https://hooks.example.com/awthaq") =>
  Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
    webhooks.createEndpoint(admin, { url, eventTags: ["auth.user.*"] }),
  );

const auditTags = Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.list()).pipe(
  Effect.map((rows) =>
    rows
      .filter((row) => row.eventTag.startsWith("auth.webhooks."))
      .map((row) => row.eventTag)
      .reverse(),
  ),
);

describe("the test ping", () => {
  it.effect(
    "queues a signed synthetic event that the worker sends once and the delivery log records",
    () => {
      const receiver = fakeReceiver();
      return Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        const created = yield* create();
        const queued = yield* webhooks.testEndpoint(admin, created.endpoint.id);
        assert.strictEqual(queued.status, "pending");
        assert.strictEqual(queued.eventTag, "webhook.test");
        assert.strictEqual(receiver.sent.length, 0);
        yield* WebhookDelivery.drainDue;
        const [request] = receiver.sent;
        if (request === undefined) return assert.fail("the ping was not sent");
        // Signed like every other delivery: the receiver's own verification passes.
        const id = yield* WebhookSignature.verify({
          secrets: [Redacted.make(created.secret)],
          headers: request.headers,
          body: request.body,
          nowSeconds: 0,
        });
        assert.strictEqual(id, queued.eventId);
        const body = JSON.parse(request.body);
        assert.strictEqual(body.type, "webhook.test");
        assert.strictEqual(body.id, queued.eventId);
        assert.deepStrictEqual(body.data, { endpointId: created.endpoint.id });
        const log = yield* webhooks.listDeliveries(admin, created.endpoint.id, {});
        assert.deepStrictEqual(
          log.map((row) => [row.eventTag, row.status, row.lastStatusCode]),
          [["webhook.test", "succeeded", 200]],
        );
      }).pipe(Effect.provide(adminLayer({ receiver: receiver.layer })));
    },
  );

  it.effect(
    "a ping is one attempt: a failure is logged as dead, and does not count against the endpoint",
    () => {
      const down = fakeReceiver(() => ({ status: 503 }));
      return Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        const records = yield* WebhookRecords.WebhookRecords;
        const created = yield* create();
        const queued = yield* webhooks.testEndpoint(admin, created.endpoint.id);
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(down.sent.length, 1);
        const [row] = yield* webhooks.listDeliveries(admin, created.endpoint.id, {});
        assert.strictEqual(row?.id, queued.id);
        assert.strictEqual(row?.status, "dead");
        assert.strictEqual(row?.attempts, 1);
        assert.strictEqual(row?.lastStatusCode, 503);
        const endpoint = Option.getOrThrow(yield* records.findEndpoint(created.endpoint.id));
        assert.strictEqual(endpoint.consecutiveDead, 0);
        assert.isTrue(Option.isNone(endpoint.disabledAt));
      }).pipe(
        Effect.provide(
          adminLayer({ receiver: down.layer, config: { disableAfterConsecutiveDead: 1 } }),
        ),
      );
    },
  );

  it.effect("carries the endpoint's tenant, and is refused for a disabled endpoint", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const records = yield* WebhookRecords.WebhookRecords;
      const created = yield* create().pipe(Tenant.withTenant("org-a"));
      const queued = yield* webhooks
        .testEndpoint(admin, created.endpoint.id)
        .pipe(Tenant.withTenant("org-a"));
      const stored = Option.getOrThrow(yield* records.findDelivery(queued.id));
      assert.strictEqual(JSON.parse(stored.body).tenantId, "org-a");
      yield* webhooks
        .updateEndpoint(admin, created.endpoint.id, { enabled: false })
        .pipe(Tenant.withTenant("org-a"));
      const refused = yield* webhooks
        .testEndpoint(admin, created.endpoint.id)
        .pipe(Tenant.withTenant("org-a"), Effect.flip);
      assert.strictEqual(refused._tag, "InvalidWebhookEndpoint");
    }).pipe(Effect.provide(adminLayer())),
  );

  it.effect("is behind the gate like every operation, by its own action name", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const created = yield* create();
      const denied = yield* webhooks.testEndpoint(admin, created.endpoint.id).pipe(Effect.flip);
      assert.strictEqual(denied._tag, "WebhooksActionDenied");
    }).pipe(
      Effect.provide(
        adminLayer({
          config: { canManageWebhooks: ({ action }) => Effect.succeed(action !== "testEndpoint") },
        }),
      ),
    ),
  );
});

describe("successful administrative mutations are audited, identifiers only", () => {
  it.effect(
    "create, update, rotate, test and delete each publish one audit event naming the administrator",
    () =>
      Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        const auditLog = yield* AuditLog.AuditLog;
        const created = yield* create();
        yield* webhooks.updateEndpoint(admin, created.endpoint.id, {
          url: "https://other.example.com/private-path-token",
          description: "a description that must not be audited",
          enabled: false,
        });
        yield* webhooks.updateEndpoint(admin, created.endpoint.id, { enabled: true });
        yield* webhooks.rotateSecret(admin, created.endpoint.id);
        yield* webhooks.testEndpoint(admin, created.endpoint.id);
        yield* webhooks.deleteEndpoint(admin, created.endpoint.id);
        assert.deepStrictEqual(yield* auditTags, [
          "auth.webhooks.endpointCreated",
          "auth.webhooks.endpointUpdated",
          "auth.webhooks.endpointUpdated",
          "auth.webhooks.secretRotated",
          "auth.webhooks.testQueued",
          "auth.webhooks.endpointDeleted",
        ]);
        const rows = yield* auditLog.list();
        const webhookRows = rows.filter((row) => row.eventTag.startsWith("auth.webhooks."));
        for (const row of webhookRows) {
          assert.deepStrictEqual(row.actorUserId, Option.some("admin-1"));
        }
        const updated = webhookRows.filter(
          (row) => row.eventTag === "auth.webhooks.endpointUpdated",
        );
        const fields = updated.map((row) =>
          row.payload._tag === "auth.webhooks.endpointUpdated" ? row.payload.fields : [],
        );
        assert.deepStrictEqual(
          fields.map((names) => [...names].sort()).sort((a, b) => a.length - b.length),
          [["enabled"], ["description", "enabled", "url"]],
        );
        // Names of fields, never values: nothing the administrator typed is in the trail.
        const dump = JSON.stringify(webhookRows.map((row) => row.payload));
        assert.notInclude(dump, "private-path-token");
        assert.notInclude(dump, "must not be audited");
        assert.notInclude(dump, "hooks.example.com");
      }).pipe(Effect.provide(adminLayer())),
  );

  it.effect(
    "a refused or failed mutation publishes nothing (a denial publishes actionDenied only)",
    () =>
      Effect.gen(function* () {
        const webhooks = yield* Webhooks.Webhooks;
        yield* create("http://insecure.example.com/x").pipe(Effect.flip);
        yield* webhooks.updateEndpoint(admin, "missing", { enabled: false }).pipe(Effect.flip);
        yield* webhooks.deleteEndpoint(admin, "missing").pipe(Effect.flip);
        yield* webhooks.rotateSecret(admin, "missing").pipe(Effect.flip);
        yield* webhooks.testEndpoint(admin, "missing").pipe(Effect.flip);
        assert.deepStrictEqual(yield* auditTags, []);
      }).pipe(Effect.provide(adminLayer())),
  );

  it.effect("a denial publishes auth.admin.actionDenied and no mutation event", () =>
    Effect.gen(function* () {
      yield* create().pipe(Effect.flip);
      const auditLog = yield* AuditLog.AuditLog;
      assert.deepStrictEqual(yield* auditTags, []);
      const denied = yield* auditLog.list({ eventTag: "auth.admin.actionDenied" });
      assert.strictEqual(denied.length, 1);
    }).pipe(
      Effect.provide(adminLayer({ config: { canManageWebhooks: () => Effect.succeed(false) } })),
    ),
  );

  it.effect("the event is stamped with the tenant the administrator acted in", () =>
    Effect.gen(function* () {
      const auditLog = yield* AuditLog.AuditLog;
      yield* create().pipe(Tenant.withTenant("org-a"));
      const [row] = yield* auditLog.list({ eventTag: "auth.webhooks.endpointCreated" });
      assert.deepStrictEqual(row?.tenantId, Option.some("org-a"));
    }).pipe(Effect.provide(adminLayer())),
  );
});
