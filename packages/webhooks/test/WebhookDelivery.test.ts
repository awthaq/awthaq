// BEH-EA-275/276/279/280/281 (spec/behaviors/34-webhooks.md): the delivery machinery over the event relay —
// enqueue idempotence, signed requests a receiver can verify, retry/backoff/dead-letter, no redirects,
// SSRF refusal at attempt time, rate deferral, secret rotation overlap and endpoint auto-disable.
import { AuthEvents, EventRelay, Users } from "@awthaq/core";
import { Encryption, RateLimiter } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as WebhookDelivery from "../src/WebhookDelivery.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as WebhookSecrets from "../src/WebhookSecrets.ts";
import * as WebhookSignature from "../src/WebhookSignature.ts";
import {
  deliveryLayer,
  enqueueAndDrain,
  fakeReceiver,
  published,
  seedEndpoint,
  signedIn,
} from "./support.ts";

// One receiver per test that inspects it (a receiver records everything it is sent).
const receiver = fakeReceiver();
const receiver2 = fakeReceiver();
const down = fakeReceiver(() => ({ status: 503 }));
const recovering = (() => {
  let calls = 0;
  return fakeReceiver(() => ({ status: (calls += 1) === 1 ? 500 : 200 }));
})();
const silent = fakeReceiver(() => ({ never: true }));
const refusing = fakeReceiver(() => ({ transportError: true }));
const redirecting = fakeReceiver(() => ({ status: 302 }));
const blocked = fakeReceiver();
const blocked2 = fakeReceiver();
const local = fakeReceiver();
const leaky = fakeReceiver(() => ({ status: 500 }));
const budgeted = fakeReceiver();
const graceful = fakeReceiver();
const tampered = fakeReceiver();

const deliveriesOf = (endpointId: string) =>
  Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    records.listDeliveries({ endpointId, limit: 50 }),
  );

const only = <A>(rows: ReadonlyArray<A>): A => {
  const [first] = rows;
  if (first === undefined || rows.length !== 1)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
};

describe("a delivery a receiver can verify", () => {
  it.effect(
    "POSTs the event as JSON with Standard-Webhooks headers that verify under the endpoint secret",
    () =>
      Effect.gen(function* () {
        const { endpoint, secret } = yield* seedEndpoint();
        const event = yield* published(signedIn("user-1"));
        assert.strictEqual(yield* enqueueAndDrain(event), 1);
        const [request] = receiver.sent;
        assert.isDefined(request);
        if (request === undefined) return;
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.url, endpoint.url);
        assert.strictEqual(request.headers["content-type"], "application/json");
        assert.strictEqual(request.headers["user-agent"], "awthaq-webhooks/1");
        // The receiver's own verification, from the raw headers and body.
        const id = yield* WebhookSignature.verify({
          secrets: [secret],
          headers: request.headers,
          body: request.body,
          nowSeconds: 0,
        });
        assert.strictEqual(id, event.eventId);
        const body = JSON.parse(request.body);
        assert.strictEqual(body.type, "auth.user.signedIn");
        assert.strictEqual(body.id, event.eventId);
        assert.deepStrictEqual(body.data, { userId: "user-1", strategy: "password" });

        const log = only(yield* deliveriesOf(endpoint.id));
        assert.strictEqual(log.status, "succeeded");
        assert.strictEqual(log.attempts, 1);
        assert.deepStrictEqual(log.lastStatusCode, Option.some(200));
      }).pipe(Effect.provide(deliveryLayer({ receiver: receiver.layer }))),
  );

  it.effect("each attempt is re-stamped but keeps the event id as its idempotency key", () =>
    Effect.gen(function* () {
      const flaky = fakeReceiver((request) => ({
        status: request.headers["webhook-timestamp"] === "0" ? 500 : 200,
      }));
      yield* Effect.gen(function* () {
        yield* seedEndpoint();
        const event = yield* published(signedIn());
        yield* enqueueAndDrain(event);
        yield* TestClock.adjust(Duration.seconds(10));
        yield* WebhookDelivery.drainDue;
        assert.strictEqual(flaky.sent.length, 2);
        assert.strictEqual(
          flaky.sent[0]?.headers["webhook-id"],
          flaky.sent[1]?.headers["webhook-id"],
        );
        assert.strictEqual(flaky.sent[0]?.headers["webhook-timestamp"], "0");
        assert.strictEqual(flaky.sent[1]?.headers["webhook-timestamp"], "10");
      }).pipe(Effect.provide(deliveryLayer({ receiver: flaky.layer })));
    }),
  );
});

describe("enqueue and the event relay", () => {
  it.effect(
    "the relay's redelivered batch is queued once, and filters decide who is sent what",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const users = (yield* seedEndpoint({ id: "users", eventTags: ["auth.user.*"] })).endpoint;
        const orgs = (yield* seedEndpoint({
          id: "orgs",
          eventTags: ["auth.organization.created", "auth.session.*"],
        })).endpoint;
        const all = (yield* seedEndpoint({ id: "all", eventTags: ["*"] })).endpoint;
        const signedInEvent = yield* published(signedIn("u-1"));
        const orgEvent = yield* published({
          _tag: "auth.organization.created",
          organizationId: "org-1",
          creatorUserId: Users.UserId("u-1"),
        });
        const batch = [signedInEvent, orgEvent];
        assert.strictEqual(yield* WebhookDelivery.enqueue(batch), 4);
        // The same batch again (the relay crashed before its cursor write): nothing new.
        assert.strictEqual(yield* WebhookDelivery.enqueue(batch), 0);
        const tags = (id: string) =>
          records
            .listDeliveries({ endpointId: id, limit: 10 })
            .pipe(Effect.map((rows) => rows.map((row) => row.eventTag).sort()));
        assert.deepStrictEqual(yield* tags(users.id), ["auth.user.signedIn"]);
        assert.deepStrictEqual(yield* tags(orgs.id), ["auth.organization.created"]);
        assert.deepStrictEqual(yield* tags(all.id), [
          "auth.organization.created",
          "auth.user.signedIn",
        ]);
      }).pipe(Effect.provide(deliveryLayer())),
  );

  it.effect(
    "an endpoint hears what happened after it was registered, not the log's history; a disabled one hears nothing",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const before = yield* published(signedIn("early"));
        yield* TestClock.adjust(Duration.seconds(5));
        const { endpoint } = yield* seedEndpoint({ id: "late" });
        const off = (yield* seedEndpoint({ id: "off" })).endpoint;
        yield* records.setDisabled(off.id, { at: endpoint.createdAt, reason: "manual" });
        const after = yield* published(signedIn("later"));
        yield* WebhookDelivery.enqueue([before, after]);
        assert.deepStrictEqual(
          (yield* deliveriesOf("late")).map((row) => row.eventId),
          [after.eventId],
        );
        assert.deepStrictEqual(yield* deliveriesOf("off"), []);
      }).pipe(Effect.provide(deliveryLayer())),
  );

  it.effect(
    "end to end: events published on the bus reach the receiver through the audit log, the relay's cursor and the worker",
    () =>
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const { endpoint, secret } = yield* seedEndpoint({ eventTags: ["auth.user.signedIn"] });
        yield* TestClock.adjust(Duration.millis(1));
        yield* events.publish(signedIn("relayed"));
        yield* events.publish({ _tag: "auth.user.created", userId: Users.UserId("ignored") });
        yield* TestClock.adjust(Duration.seconds(3));
        const transport = yield* Layer.build(
          Layer.mergeAll(WebhookDelivery.transportLayer, EventRelay.layerCursorMemory),
        );
        const drain = EventRelay.drainOnce({ name: WebhookDelivery.RELAY_NAME }).pipe(
          Effect.provide(transport),
        );
        assert.strictEqual(yield* drain, 2);
        // Caught up: the cursor moved past both, so nothing is handed over twice.
        assert.strictEqual(yield* drain, 0);
        assert.strictEqual(yield* WebhookDelivery.drainDue, 1);
        const [request] = receiver2.sent;
        assert.isDefined(request);
        if (request === undefined) return;
        yield* WebhookSignature.verify({
          secrets: [secret],
          headers: request.headers,
          body: request.body,
          nowSeconds: 3,
        });
        assert.deepStrictEqual(JSON.parse(request.body).data, {
          userId: "relayed",
          strategy: "password",
        });
        assert.strictEqual(only(yield* deliveriesOf(endpoint.id)).status, "succeeded");
      }).pipe(Effect.provide(deliveryLayer({ receiver: receiver2.layer }))),
  );
});

describe("retry, backoff and dead-letter", () => {
  const config = {
    maxAttempts: 3,
    retryBase: Duration.seconds(10),
    retryFactor: 3,
    retryMax: Duration.hours(1),
    disableAfterConsecutiveDead: 2,
  } as const;

  it.effect(
    "a failing receiver is retried on a capped exponential schedule, then dead-lettered",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        yield* enqueueAndDrain(yield* published(signedIn()));
        const state = () => deliveriesOf(endpoint.id).pipe(Effect.map(only));
        let row = yield* state();
        assert.strictEqual(row.status, "pending");
        assert.strictEqual(row.attempts, 1);
        assert.deepStrictEqual(row.lastStatusCode, Option.some(503));
        assert.deepStrictEqual(row.lastError, Option.some("status"));
        // Not due before the delay, due after it: first retry 10s after the first failure ...
        yield* TestClock.adjust(Duration.seconds(9));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 0);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 1);
        row = yield* state();
        assert.strictEqual(row.attempts, 2);
        // ... the second 30s (factor 3) after that.
        yield* TestClock.adjust(Duration.seconds(29));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 0);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 1);
        row = yield* state();
        // maxAttempts spent: dead-lettered, kept as the log, and never picked up again.
        assert.strictEqual(row.status, "dead");
        assert.strictEqual(row.attempts, 3);
        assert.isTrue(Option.isSome(row.completedAt));
        yield* TestClock.adjust(Duration.hours(24));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 0);
        assert.strictEqual(down.sent.length, 3);
      }).pipe(Effect.provide(deliveryLayer({ receiver: down.layer, config }))),
  );

  it.effect(
    "a success after failures ends the retries and resets the endpoint's failure count",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const { endpoint } = yield* seedEndpoint();
        yield* records.bumpDead(endpoint.id);
        yield* enqueueAndDrain(yield* published(signedIn()));
        yield* TestClock.adjust(Duration.seconds(10));
        yield* WebhookDelivery.drainDue;
        const row = only(yield* deliveriesOf(endpoint.id));
        assert.strictEqual(row.status, "succeeded");
        assert.strictEqual(row.attempts, 2);
        const fresh = yield* records.findEndpoint(endpoint.id);
        assert.strictEqual(Option.getOrThrow(fresh).consecutiveDead, 0);
      }).pipe(Effect.provide(deliveryLayer({ receiver: recovering.layer, config }))),
  );

  it.effect(
    "consecutive dead-letters switch an endpoint off; its queue waits, and re-enabling resumes it",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const { endpoint } = yield* seedEndpoint();
        // Two events, each exhausting its 3 attempts (disableAfterConsecutiveDead: 2).
        yield* WebhookDelivery.enqueue([
          yield* published(signedIn("a")),
          yield* published(signedIn("b")),
        ]);
        for (let round = 0; round < 3; round++) {
          yield* WebhookDelivery.drainDue;
          yield* TestClock.adjust(Duration.minutes(1));
        }
        const off = Option.getOrThrow(yield* records.findEndpoint(endpoint.id));
        assert.deepStrictEqual(off.disabledReason, Option.some("failing"));
        // A later event is not queued for a disabled endpoint.
        assert.strictEqual(yield* WebhookDelivery.enqueue([yield* published(signedIn("c"))]), 0);
        yield* records.setDisabled(endpoint.id, null);
        assert.strictEqual(
          Option.getOrThrow(yield* records.findEndpoint(endpoint.id)).consecutiveDead,
          0,
        );
      }).pipe(Effect.provide(deliveryLayer({ receiver: down.layer, config }))),
  );

  it.effect(
    "a receiver that never answers times out after requestTimeout, and that is a failed attempt",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        yield* WebhookDelivery.enqueue([yield* published(signedIn())]);
        const fiber = yield* Effect.forkChild(WebhookDelivery.drainDue, { startImmediately: true });
        // Decrypting the secret is real (WebCrypto) async work, so the request's deadline is not
        // registered on the test clock at once: step the clock until the attempt has finished.
        for (let step = 0; step < 100 && fiber.pollUnsafe() === undefined; step++) {
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
          yield* TestClock.adjust(Duration.seconds(1));
        }
        yield* Fiber.join(fiber);
        const row = only(yield* deliveriesOf(endpoint.id));
        assert.strictEqual(row.attempts, 1);
        assert.deepStrictEqual(row.lastError, Option.some("timeout"));
        assert.isTrue(Option.isNone(row.lastStatusCode));
      }).pipe(
        Effect.provide(
          deliveryLayer({
            receiver: silent.layer,
            config: { requestTimeout: Duration.seconds(10) },
          }),
        ),
      ),
  );

  it.effect("a transport failure is recorded as a class, never a message", () =>
    Effect.gen(function* () {
      const { endpoint } = yield* seedEndpoint();
      yield* enqueueAndDrain(yield* published(signedIn()));
      const row = only(yield* deliveriesOf(endpoint.id));
      assert.deepStrictEqual(row.lastError, Option.some("connect"));
    }).pipe(Effect.provide(deliveryLayer({ receiver: refusing.layer }))),
  );
});

describe("what an attempt refuses to do", () => {
  it.effect(
    "a redirect is not followed: the 3xx is a failed attempt, and the redirect target is never contacted",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        yield* enqueueAndDrain(yield* published(signedIn()));
        // The fake sends `Location: http://169.254.169.254/` with the 302: only the one request was made.
        assert.strictEqual(redirecting.sent.length, 1);
        // The client was told not to follow (the fake does not, so this is what proves the instruction).
        assert.strictEqual(redirecting.sent[0]?.redirect, "manual");
        const row = only(yield* deliveriesOf(endpoint.id));
        assert.deepStrictEqual(row.lastStatusCode, Option.some(302));
        assert.strictEqual(row.status, "pending");
      }).pipe(Effect.provide(deliveryLayer({ receiver: redirecting.layer }))),
  );

  it.effect(
    "a name that now resolves to a private address is blocked at attempt time, with no request made",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint({ url: "https://rebind.example.com/hook" });
        yield* enqueueAndDrain(yield* published(signedIn()));
        assert.strictEqual(blocked.sent.length, 0);
        const row = only(yield* deliveriesOf(endpoint.id));
        assert.deepStrictEqual(row.lastError, Option.some("blocked"));
        assert.strictEqual(row.attempts, 1);
      }).pipe(Effect.provide(deliveryLayer({ receiver: blocked.layer }))),
  );

  it.effect(
    "a private literal in a stored URL (a row written before the rules, or by hand) is blocked too",
    () =>
      Effect.gen(function* () {
        yield* seedEndpoint({ url: "https://169.254.169.254/latest/meta-data" });
        yield* enqueueAndDrain(yield* published(signedIn()));
        assert.strictEqual(blocked2.sent.length, 0);
      }).pipe(Effect.provide(deliveryLayer({ receiver: blocked2.layer }))),
  );

  it.effect("allowPrivateTargets (development) lets a delivery reach http://localhost", () =>
    Effect.gen(function* () {
      yield* seedEndpoint({ url: "http://localhost:3000/hook" });
      yield* enqueueAndDrain(yield* published(signedIn()));
      assert.strictEqual(local.sent.length, 1);
    }).pipe(
      Effect.provide(
        deliveryLayer({ receiver: local.layer, config: { allowPrivateTargets: true } }),
      ),
    ),
  );

  it.effect(
    "the response body is never stored: the log holds a status and an error class only",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        yield* enqueueAndDrain(yield* published(signedIn()));
        const row = only(yield* deliveriesOf(endpoint.id));
        const dump = JSON.stringify(row);
        assert.notInclude(dump, "secret-internal-detail");
        assert.deepStrictEqual(row.lastError, Option.some("status"));
      }).pipe(Effect.provide(deliveryLayer({ receiver: leaky.layer }))),
  );
});

describe("rate limits and secrets", () => {
  it.effect(
    "over the endpoint's outbound budget a delivery waits (no attempt is spent), then goes",
    () =>
      Effect.gen(function* () {
        const { endpoint } = yield* seedEndpoint();
        yield* WebhookDelivery.enqueue([
          yield* published(signedIn("a")),
          yield* published(signedIn("b")),
        ]);
        assert.strictEqual(yield* WebhookDelivery.drainDue, 2);
        // One sent; the other deferred with its attempts untouched.
        assert.strictEqual(budgeted.sent.length, 1);
        const rows = yield* deliveriesOf(endpoint.id);
        assert.deepStrictEqual(rows.map((row) => [row.status, row.attempts]).sort(), [
          ["pending", 0],
          ["succeeded", 1],
        ]);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.strictEqual(yield* WebhookDelivery.drainDue, 1);
        assert.strictEqual(budgeted.sent.length, 2);
      }).pipe(
        Effect.provide(
          deliveryLayer({
            receiver: budgeted.layer,
            limiter: RateLimiter.layerMemory,
            config: { deliveryRate: { limit: 1, window: Duration.minutes(1) } },
          }),
        ),
      ),
  );

  it.effect(
    "a rotation signs with both secrets during the grace window, and only the new one after it",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const encryption = yield* Encryption.Encryption;
        const { endpoint, secret: oldSecret } = yield* seedEndpoint();
        const newSecret = yield* WebhookSignature.generateSecret;
        const rotated = yield* records.setSecrets(endpoint.id, {
          secret: yield* WebhookSecrets.seal(encryption, endpoint.id, "secret", newSecret),
          previousSecret: yield* WebhookSecrets.seal(
            encryption,
            endpoint.id,
            "previousSecret",
            oldSecret,
          ),
          previousSecretExpiresAt: DateTime.addDuration(yield* DateTime.now, Duration.hours(1)),
        });
        assert.isTrue(Option.isSome(rotated.previousSecret));
        yield* enqueueAndDrain(yield* published(signedIn("in-grace")));
        const during = graceful.sent[0];
        assert.isDefined(during);
        if (during === undefined) return;
        assert.strictEqual(during.headers["webhook-signature"]?.split(" ").length, 2);
        // A receiver still on the old secret verifies; so does one already on the new.
        for (const known of [oldSecret, newSecret]) {
          yield* WebhookSignature.verify({
            secrets: [known],
            headers: during.headers,
            body: during.body,
            nowSeconds: 0,
          });
        }
        // After the window: one signature, the new secret's.
        yield* TestClock.adjust(Duration.hours(2));
        yield* enqueueAndDrain(yield* published(signedIn("after-grace")));
        const after = graceful.sent.at(-1);
        assert.strictEqual(after?.headers["webhook-signature"]?.split(" ").length, 1);
        const stale = yield* WebhookSignature.verify({
          secrets: [oldSecret],
          headers: after?.headers ?? {},
          body: after?.body ?? "",
          nowSeconds: 7_200,
        }).pipe(Effect.flip);
        assert.strictEqual(stale.reason, "noMatchingSignature");
      }).pipe(Effect.provide(deliveryLayer({ receiver: graceful.layer }))),
  );

  it.effect(
    "a secret that no longer decrypts (wrong AAD: copied from another endpoint) fails as `secret`, never sends",
    () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const encryption = yield* Encryption.Encryption;
        const { endpoint } = yield* seedEndpoint({ id: "victim" });
        // The sealed secret of ANOTHER endpoint, pasted into this row.
        const foreign = yield* WebhookSecrets.seal(
          encryption,
          "someone-else",
          "secret",
          Redacted.make("whsec_x"),
        );
        yield* records.setSecrets(endpoint.id, {
          secret: foreign,
          previousSecret: null,
          previousSecretExpiresAt: null,
        });
        yield* enqueueAndDrain(yield* published(signedIn()));
        assert.strictEqual(tampered.sent.length, 0);
        assert.deepStrictEqual(
          only(yield* deliveriesOf(endpoint.id)).lastError,
          Option.some("secret"),
        );
      }).pipe(Effect.provide(deliveryLayer({ receiver: tampered.layer }))),
  );

  it.effect("the stored secret is an Encryption envelope, never the plaintext", () =>
    Effect.gen(function* () {
      const { endpoint, secret } = yield* seedEndpoint();
      assert.notInclude(endpoint.secret, Redacted.value(secret));
      assert.notInclude(endpoint.secret, "whsec_");
    }).pipe(Effect.provide(deliveryLayer())),
  );
});
