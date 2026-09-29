// BEH-EA-304 (spec/behaviors/34-webhooks.md): per-endpoint custom request headers. Values are credentials: sealed with
// `Encryption` (AAD naming endpoint and field), never returned (only names), and bounded so a custom header can never
// replace what the delivery itself says.
import { Encryption } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookHeaders from "../src/WebhookHeaders.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSecrets from "../src/WebhookSecrets.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { adminLayer, adminPrincipal, fakeReceiver, published, signedIn } from "./support.ts";

const admin = adminPrincipal();

const create = (headers?: Readonly<Record<string, string>>) =>
  Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
    webhooks.createEndpoint(admin, {
      url: "https://hooks.example.com/awthaq",
      eventTags: ["auth.user.*"],
      ...(headers === undefined ? {} : { headers }),
    }),
  );

const refusalOf = (headers: Readonly<Record<string, string>>) =>
  create(headers).pipe(
    Effect.flip,
    Effect.map((failure) =>
      failure._tag === "InvalidWebhookEndpoint" ? failure.reason : failure._tag,
    ),
  );

describe("WebhookHeaders.problem", () => {
  const refused = (headers: Record<string, string>) =>
    Option.isSome(WebhookHeaders.problem(headers));

  it("accepts ordinary receiver-facing headers", () => {
    assert.isFalse(refused({ Authorization: "Bearer abc.def", "X-Api-Key": "k-123" }));
  });

  it("refuses what the delivery itself sets or what changes the request's meaning", () => {
    for (const name of [
      "Host",
      "Content-Type",
      "content-length",
      "User-Agent",
      "Transfer-Encoding",
      "Connection",
      "Upgrade",
      "Cookie",
      "webhook-id",
      "Webhook-Signature",
      "proxy-authorization",
      "sec-fetch-mode",
    ]) {
      assert.isTrue(refused({ [name]: "x" }), name);
    }
  });

  it("refuses bad names, control characters in values (header injection), empty and oversized values", () => {
    assert.isTrue(refused({ "bad name": "x" }));
    assert.isTrue(refused({ "x:y": "x" }));
    assert.isTrue(refused({ "": "x" }));
    assert.isTrue(refused({ "x-a": "line\r\nx-injected: 1" }));
    assert.isTrue(refused({ "x-a": "nul\u0000" }));
    assert.isTrue(refused({ "x-a": "" }));
    assert.isTrue(refused({ "x-a": "é" }));
    assert.isTrue(refused({ "x-a": "v".repeat(WebhookHeaders.MAX_VALUE_LENGTH + 1) }));
  });

  it("caps the count and refuses one name spelled two ways", () => {
    const many = Object.fromEntries(
      Array.from({ length: WebhookHeaders.MAX_HEADERS + 1 }, (_, index) => [`x-h${index}`, "v"]),
    );
    assert.isTrue(refused(many));
    assert.isTrue(refused({ "X-Token": "a", "x-token": "b" }));
  });
});

describe("custom headers on an endpoint", () => {
  it.effect("values are sealed at rest and never returned; the API shows the names", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const records = yield* WebhookRecords.WebhookRecords;
      const encryption = yield* Encryption.Encryption;
      const created = yield* create({
        Authorization: "Bearer very-secret-token",
        "X-Team": "billing",
      });
      assert.deepStrictEqual(created.endpoint.headerNames, ["authorization", "x-team"]);
      const row = Option.getOrThrow(yield* records.findEndpoint(created.endpoint.id));
      const stored = Option.getOrThrow(row.headers);
      assert.notInclude(stored, "very-secret-token");
      assert.notInclude(JSON.stringify(row), "very-secret-token");
      // It opens only under its own endpoint and field.
      const opened = yield* WebhookSecrets.openHeaders(encryption, row);
      assert.deepStrictEqual(Option.getOrThrow(opened), {
        authorization: "Bearer very-secret-token",
        "x-team": "billing",
      });
      const elsewhere = yield* WebhookSecrets.openHeaders(encryption, { ...row, id: "another" });
      assert.isTrue(Option.isNone(elsewhere));
      // Reads carry names only.
      const dump = JSON.stringify([
        yield* webhooks.listEndpoints(admin),
        yield* webhooks.getEndpoint(admin, created.endpoint.id),
      ]);
      assert.notInclude(dump, "very-secret-token");
      assert.include(dump, "authorization");
    }).pipe(Effect.provide(adminLayer())),
  );

  it.effect("are sent with every delivery, beneath the delivery's own headers", () => {
    const receiver = fakeReceiver();
    return Effect.gen(function* () {
      yield* create({ Authorization: "Bearer very-secret-token", "X-Team": "billing" });
      yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
      yield* WebhookDelivery.drainDue;
      const [request] = receiver.sent;
      assert.strictEqual(request?.headers["authorization"], "Bearer very-secret-token");
      assert.strictEqual(request?.headers["x-team"], "billing");
      assert.match(request?.headers["webhook-signature"] ?? "", /^v1,/);
      assert.strictEqual(request?.headers["content-type"], "application/json");
    }).pipe(Effect.provide(adminLayer({ receiver: receiver.layer })));
  });

  it.effect("the API refuses a reserved or malformed header, creating nothing", () =>
    Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      assert.include(yield* refusalOf({ "Webhook-Signature": "forged" }), "cannot be customised");
      assert.include(yield* refusalOf({ Host: "internal.example.com" }), "cannot be customised");
      assert.include(yield* refusalOf({ "x-a": "a\r\nb: c" }), "printable ASCII");
      assert.deepStrictEqual(yield* records.listEndpoints, []);
    }).pipe(Effect.provide(adminLayer())),
  );

  it.effect("update replaces the set as a whole, and null clears it", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const created = yield* create({ "x-old": "1" });
      const replaced = yield* webhooks.updateEndpoint(admin, created.endpoint.id, {
        headers: { "x-new": "2" },
      });
      assert.deepStrictEqual(replaced.headerNames, ["x-new"]);
      // Untouched when the field is left out.
      const untouched = yield* webhooks.updateEndpoint(admin, created.endpoint.id, {
        description: "renamed",
      });
      assert.deepStrictEqual(untouched.headerNames, ["x-new"]);
      const cleared = yield* webhooks.updateEndpoint(admin, created.endpoint.id, { headers: null });
      assert.deepStrictEqual(cleared.headerNames, []);
      const refused = yield* webhooks
        .updateEndpoint(admin, created.endpoint.id, { headers: { host: "x" } })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "InvalidWebhookEndpoint");
    }).pipe(Effect.provide(adminLayer())),
  );

  it.effect(
    "a sealed header set that no longer opens fails the attempt as `secret` and sends nothing",
    () => {
      const receiver = fakeReceiver();
      return Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const first = yield* create({ "x-a": "1" });
        const second = yield* create({ "x-b": "2" });
        const stolen = Option.getOrThrow(
          Option.getOrThrow(yield* records.findEndpoint(second.endpoint.id)).headers,
        );
        // The other endpoint's sealed headers copied into this endpoint's row do not decrypt.
        yield* records.updateEndpoint(first.endpoint.id, {
          headers: { sealed: stolen, names: ["x-b"] },
        });
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        yield* WebhookDelivery.drainDue;
        // Both endpoints hear the event; only the intact one (`second`, sealed for itself) was sent to.
        assert.strictEqual(receiver.sent.length, 1);
        assert.strictEqual(receiver.sent[0]?.headers["x-b"], "2");
        const rows = yield* records.listDeliveries({ endpointId: first.endpoint.id, limit: 5 });
        assert.deepStrictEqual(rows[0]?.lastError, Option.some("secret"));
      }).pipe(Effect.provide(adminLayer({ receiver: receiver.layer })));
    },
  );
});
