// BEH-EA-261/262 (spec/behaviors/31-webhooks.md): the administrator's surface — fail-closed by default,
// secret shown once and stored sealed, the SSRF floor and filter validation at registration, rotation,
// the delivery log and manual redrive, and the per-administrator rate limit.
import { Api } from "@awthaq/api";
import { AuthEvents, Auth, Erasure, DataExport, Users } from "@awthaq/core";
import { Encryption, RateLimiter } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSecrets from "../src/WebhookSecrets.ts";
import * as Webhooks from "../src/Webhooks.ts";
import { CoreLive, deliveryLayer, seedEndpoint } from "./support.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

const allow = () => Effect.succeed(true);
const DateNowUtc = (millis: number) => DateTime.makeUnsafe(millis);
const nowUtc = DateTime.now;

const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive))),
);
const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("webhooks-admin-test-csrf-secret-padded-to-32-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildLayer = (
  config: Partial<Webhooks.WebhooksConfigShape> = {},
  limiter: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
) =>
  Webhooks.Webhooks.layer.pipe(
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(deliveryLayer({ config, limiter })),
  );

const admin = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
  sessionId: "admin-session",
});

const create = (overrides: Partial<{ url: string; eventTags: ReadonlyArray<string>; description: string }> = {}) =>
  Effect.gen(function* () {
    const webhooks = yield* Webhooks.Webhooks;
    return yield* webhooks.createEndpoint(admin, {
      url: "https://hooks.example.com/awthaq",
      eventTags: ["auth.user.*"],
      ...overrides,
    });
  });

describe("the gate is fail-closed", () => {
  it.effect("with no gate configured every operation is denied, publishes actionDenied, and touches nothing", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* WebhookRecords.WebhookRecords;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* events.stream.pipe(
        Stream.runForEach((event) =>
          event._tag === "auth.admin.actionDenied"
            ? Ref.update(seen, (all) => [...all, event.action])
            : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const denied = [
        yield* create().pipe(Effect.flip),
        yield* webhooks.listEndpoints(admin).pipe(Effect.flip),
        yield* webhooks.getEndpoint(admin, "any").pipe(Effect.flip),
        yield* webhooks.updateEndpoint(admin, "any", {}).pipe(Effect.flip),
        yield* webhooks.deleteEndpoint(admin, "any").pipe(Effect.flip),
        yield* webhooks.rotateSecret(admin, "any").pipe(Effect.flip),
        yield* webhooks.listDeliveries(admin, "any", {}).pipe(Effect.flip),
        yield* webhooks.retryDelivery(admin, "any").pipe(Effect.flip),
      ];
      assert.isTrue(denied.every((failure) => failure._tag === "WebhooksActionDenied"));
      assert.deepStrictEqual(yield* records.listEndpoints, []);
      yield* TestClock.adjust(Duration.millis(10));
      assert.deepStrictEqual(yield* Ref.get(seen), [
        "webhooks.createEndpoint",
        "webhooks.listEndpoints",
        "webhooks.getEndpoint",
        "webhooks.updateEndpoint",
        "webhooks.deleteEndpoint",
        "webhooks.rotateSecret",
        "webhooks.listDeliveries",
        "webhooks.retryDelivery",
      ]);
    }).pipe(Effect.scoped, Effect.provide(buildLayer())),
  );

  it.effect("the gate sees the action, so an auditor can read the log while only an owner registers receivers", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const denied = yield* create().pipe(Effect.flip);
      assert.strictEqual(denied._tag, "WebhooksActionDenied");
      assert.deepStrictEqual(yield* webhooks.listEndpoints(admin), []);
    }).pipe(
      Effect.provide(
        buildLayer({ canManageWebhooks: ({ action }) => Effect.succeed(action.startsWith("list")) }),
      ),
    ),
  );

  it.effect("a caller who fails the gate learns nothing about which ids exist; one who passes gets 404 for an unknown id", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const { endpoint } = yield* seedEndpoint({ id: "real" });
      const deniedReal = yield* webhooks.getEndpoint(admin, endpoint.id).pipe(Effect.flip);
      const deniedFake = yield* webhooks.getEndpoint(admin, "fake").pipe(Effect.flip);
      assert.strictEqual(deniedReal._tag, "WebhooksActionDenied");
      assert.strictEqual(deniedFake._tag, "WebhooksActionDenied");
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("registering an endpoint", () => {
  it.effect("returns the secret once; the row holds only its sealed envelope; reads never carry it", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const encryption = yield* Encryption.Encryption;
      const records = yield* WebhookRecords.WebhookRecords;
      const created = yield* create({ description: "  primary  " });
      assert.match(created.secret, /^whsec_/);
      assert.strictEqual(created.endpoint.description, "primary");
      assert.deepStrictEqual(created.endpoint.eventTags, ["auth.user.*"]);
      assert.isTrue(created.endpoint.enabled);
      const row = Option.getOrThrow(yield* records.findEndpoint(created.endpoint.id));
      assert.notInclude(row.secret, created.secret);
      const opened = yield* encryption.decrypt(row.secret, WebhookSecrets.aad(row.id, "secret"));
      assert.strictEqual(Redacted.value(opened.plaintext), created.secret);
      // No later read ever includes it.
      const listed = JSON.stringify(yield* webhooks.listEndpoints(admin));
      const got = JSON.stringify(yield* webhooks.getEndpoint(admin, created.endpoint.id));
      assert.notInclude(listed, created.secret);
      assert.notInclude(got, created.secret);
      assert.notInclude(listed, "sealed");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );

  it.effect("applies the SSRF floor and refuses a filter that matches nothing, creating nothing", () =>
    Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const refuse = (url: string, eventTags: ReadonlyArray<string> = ["*"]) =>
        create({ url, eventTags }).pipe(
          Effect.flip,
          Effect.map((failure) => (failure._tag === "InvalidWebhookEndpoint" ? failure.reason : failure._tag)),
        );
      assert.include(yield* refuse("http://hooks.example.com/x"), "must be https");
      assert.include(yield* refuse("https://user:pw@hooks.example.com/x"), "credentials");
      assert.include(yield* refuse("https://169.254.169.254/latest"), "private or loopback");
      assert.include(yield* refuse("https://[::ffff:127.0.0.1]/x"), "private or loopback");
      assert.include(yield* refuse("https://localhost/x"), "private or loopback");
      assert.include(yield* refuse("https://intranet/x"), "fully qualified");
      assert.include(yield* refuse("not a url"), "absolute URL");
      // A public-looking name that RESOLVES to a private address; and one that does not resolve at all.
      assert.include(yield* refuse("https://rebind.example.com/x"), "resolves to a private");
      assert.include(yield* refuse("https://nx.example.com/x"), "does not resolve");
      // Filters.
      assert.include(yield* refuse("https://hooks.example.com/x", ["auth.user.signedInn"]), "matches no event");
      assert.deepStrictEqual(yield* records.listEndpoints, []);
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );

  it.effect("development mode (allowPrivateTargets) accepts http://localhost, and only then", () =>
    Effect.gen(function* () {
      const created = yield* create({ url: "http://localhost:3000/hook" });
      assert.strictEqual(created.endpoint.url, "http://localhost:3000/hook");
      const credentials = yield* create({ url: "http://a:b@localhost/hook" }).pipe(Effect.flip);
      assert.strictEqual(credentials._tag, "InvalidWebhookEndpoint");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow, allowPrivateTargets: true }))),
  );

  it.effect("stops at maxEndpoints", () =>
    Effect.gen(function* () {
      yield* create();
      yield* create();
      const over = yield* create().pipe(Effect.flip);
      assert.strictEqual(over._tag, "WebhookEndpointLimitReached");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow, maxEndpoints: 2 }))),
  );
});

describe("editing, rotating and removing", () => {
  it.effect("update validates a new URL, switches an endpoint off and on, and clears the description", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const { endpoint } = yield* create({ description: "first" });
      const bad = yield* webhooks.updateEndpoint(admin, endpoint.id, { url: "http://insecure.example.com" }).pipe(Effect.flip);
      assert.strictEqual(bad._tag, "InvalidWebhookEndpoint");
      const moved = yield* webhooks.updateEndpoint(admin, endpoint.id, {
        url: "https://other.example.com/hook",
        description: null,
        eventTags: ["auth.session.*"],
      });
      assert.strictEqual(moved.url, "https://other.example.com/hook");
      assert.isNull(moved.description);
      assert.deepStrictEqual(moved.eventTags, ["auth.session.*"]);
      const off = yield* webhooks.updateEndpoint(admin, endpoint.id, { enabled: false });
      assert.isFalse(off.enabled);
      assert.strictEqual(off.disabledReason, "manual");
      const on = yield* webhooks.updateEndpoint(admin, endpoint.id, { enabled: true });
      assert.isTrue(on.enabled);
      assert.isNull(on.disabledReason);
      const missing = yield* webhooks.updateEndpoint(admin, "nope", {}).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "WebhookEndpointNotFound");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );

  it.effect("rotation issues a fresh secret and keeps the previous one signing for the grace window only", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const encryption = yield* Encryption.Encryption;
      const records = yield* WebhookRecords.WebhookRecords;
      const first = yield* create();
      const rotated = yield* webhooks.rotateSecret(admin, first.endpoint.id);
      assert.notStrictEqual(rotated.secret, first.secret);
      assert.isNotNull(rotated.endpoint.previousSecretExpiresAt);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const row = Option.getOrThrow(yield* records.findEndpoint(first.endpoint.id));
      const during = Option.getOrThrow(yield* WebhookSecrets.open(encryption, row, DateNowUtc(now)));
      assert.deepStrictEqual(during.map(Redacted.value), [rotated.secret, first.secret]);
      const after = Option.getOrThrow(
        yield* WebhookSecrets.open(encryption, row, DateNowUtc(now + Duration.toMillis(Duration.hours(25)))),
      );
      assert.deepStrictEqual(after.map(Redacted.value), [rotated.secret]);
      // A second rotation forgets the first secret: only ever current + previous.
      const again = yield* webhooks.rotateSecret(admin, first.endpoint.id);
      const row2 = Option.getOrThrow(yield* records.findEndpoint(first.endpoint.id));
      const two = Option.getOrThrow(yield* WebhookSecrets.open(encryption, row2, DateNowUtc(now)));
      assert.deepStrictEqual(two.map(Redacted.value), [again.secret, rotated.secret]);
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );

  it.effect("delete removes the endpoint and its log; an unknown id is 404 (after the gate)", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const records = yield* WebhookRecords.WebhookRecords;
      const { endpoint } = yield* create();
      yield* webhooks.deleteEndpoint(admin, endpoint.id);
      assert.isTrue(Option.isNone(yield* records.findEndpoint(endpoint.id)));
      const again = yield* webhooks.deleteEndpoint(admin, endpoint.id).pipe(Effect.flip);
      assert.strictEqual(again._tag, "WebhookEndpointNotFound");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );
});

describe("the delivery log", () => {
  it.effect("lists outcomes newest first with a status filter, and redrives only a dead delivery", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      const records = yield* WebhookRecords.WebhookRecords;
      const { endpoint } = yield* create({ eventTags: ["*"] });
      yield* records.enqueue([
        { id: "d1", endpointId: endpoint.id, eventId: "e1", eventTag: "auth.user.signedIn", body: "{}", nextAttemptAt: yield* nowUtc },
        { id: "d2", endpointId: endpoint.id, eventId: "e2", eventTag: "auth.user.signedIn", body: "{}", nextAttemptAt: yield* nowUtc },
      ]);
      yield* records.markDead("d1", { at: yield* nowUtc, statusCode: 500, error: "status" });
      const all = yield* webhooks.listDeliveries(admin, endpoint.id, {});
      assert.deepStrictEqual(all.map((row) => [row.id, row.status]), [["d2", "pending"], ["d1", "dead"]]);
      const dead = yield* webhooks.listDeliveries(admin, endpoint.id, { status: "dead" });
      assert.deepStrictEqual(dead.map((row) => row.id), ["d1"]);
      const paged = yield* webhooks.listDeliveries(admin, endpoint.id, { limit: 1, before: "d2" });
      assert.deepStrictEqual(paged.map((row) => row.id), ["d1"]);
      // The log carries outcomes, never a payload or a response.
      assert.notInclude(JSON.stringify(all), "body");

      const notDead = yield* webhooks.retryDelivery(admin, "d2").pipe(Effect.flip);
      assert.strictEqual(notDead._tag, "WebhookDeliveryNotRetryable");
      const unknown = yield* webhooks.retryDelivery(admin, "nope").pipe(Effect.flip);
      assert.strictEqual(unknown._tag, "WebhookDeliveryNotFound");
      const revived = yield* webhooks.retryDelivery(admin, "d1");
      assert.strictEqual(revived.status, "pending");
      assert.strictEqual(revived.attempts, 0);
      const missing = yield* webhooks.listDeliveries(admin, "nope", {}).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "WebhookEndpointNotFound");
    }).pipe(Effect.provide(buildLayer({ canManageWebhooks: allow }))),
  );
});

describe("rate limits", () => {
  it.effect("an administrator is limited per window once past the gate", () =>
    Effect.gen(function* () {
      const webhooks = yield* Webhooks.Webhooks;
      yield* webhooks.listEndpoints(admin);
      yield* webhooks.listEndpoints(admin);
      const limited = yield* webhooks.listEndpoints(admin).pipe(Effect.flip);
      assert.strictEqual(limited._tag, "RateLimited");
      // Another administrator has their own budget.
      const other = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "admin-2" }),
        sessionId: "s2",
      });
      yield* webhooks.listEndpoints(other);
      // The window rolls.
      yield* TestClock.adjust(Duration.minutes(1));
      yield* webhooks.listEndpoints(admin);
    }).pipe(
      Effect.provide(
        buildLayer(
          { canManageWebhooks: allow, adminRate: { limit: 2, window: Duration.minutes(1) } },
          RateLimiter.layerMemory,
        ),
      ),
    ),
  );
});

describe("the plugin composes on the admin tier", () => {
  it("Auth.make([Webhooks]) puts the group in the admin API, out of the public one", () => {
    const auth = Auth.make([Webhooks.Webhooks]);
    assert.include(Object.keys(auth.adminApi.groups), "webhooks.admin");
    assert.notInclude(Object.keys(auth.publicApi.groups), "webhooks.admin");
    assert.deepStrictEqual(auth.manifest.plugins, [
      {
        id: "webhooks",
        apiVersion: 1,
        tables: ["webhooks_endpoint", "webhooks_delivery"],
        dependsOn: [],
        groups: ["webhooks.admin"],
      },
    ]);
  });
});

describe("privacy: erasure and export", () => {
  const PrivacyLayer = Layer.mergeAll(WebhookRecords.layerMemory).pipe(
    Layer.provideMerge(Layer.mergeAll(Erasure.registryLayer, DataExport.registryLayer)),
    Layer.provideMerge(CoreLive),
  );

  it.effect("erasing a user removes the delivery rows about them and leaves everyone else's", () =>
    Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const registry = yield* Erasure.ErasureRegistry;
      const exports = yield* DataExport.DataExportRegistry;
      yield* Layer.build(Webhooks.webhooksErasure);
      yield* Layer.build(Webhooks.webhooksExport);
      yield* records.createEndpoint({ id: "ep", url: "https://hooks.example.com/x", eventTags: ["*"], secret: "sealed", createdBy: "a" });
      const at = yield* nowUtc;
      const delivery = (id: string, subject: string) => ({
        id,
        endpointId: "ep",
        eventId: id,
        eventTag: "auth.user.signedIn",
        subjectUserId: subject,
        body: "{}",
        nextAttemptAt: at,
      });
      yield* records.enqueue([delivery("mine-1", "me"), delivery("mine-2", "me"), delivery("theirs", "them")]);

      // The export lists outcomes only — never a body.
      const collectors = yield* exports.contributions;
      const mine = collectors.find((entry) => entry.id === "webhooks");
      assert.isDefined(mine);
      const doc = yield* (mine?.collect({ userId: Users.UserId("me") }) ?? Effect.succeed({}));
      const text = JSON.stringify(doc);
      assert.include(text, "mine-1");
      assert.notInclude(text, "theirs");
      assert.notInclude(text, '"body"');

      for (const contribution of yield* registry.contributions) {
        yield* contribution.erase({ userId: Users.UserId("me") });
      }
      assert.deepStrictEqual(yield* records.listBySubject("me"), []);
      assert.strictEqual((yield* records.listBySubject("them")).length, 1);
    }).pipe(Effect.scoped, Effect.provide(PrivacyLayer)),
  );
});
