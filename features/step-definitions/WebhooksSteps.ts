// P20a: the steps of 34-webhooks.feature (BEH-EA-275 through BEH-EA-282). Deliveries are driven
// through the plugin's own `enqueue` and `drainDue` (what the relay and the worker run) against a
// programmable fake receiver, and read back from the delivery records; the administrator's
// surface is driven through the plugin service, and over real HTTP for the admin-tier scenarios.
//
// Endpoints a scenario merely needs are seeded straight into the records with a sealed secret
// (the way the package's own tests do), so a scenario about the administrator gate can still have
// an endpoint the gate then refuses to show; endpoints a scenario is *about* are registered through
// the service.
import { Auth, AuthEvents, DataExport, Erasure, EventRelay, Sessions, Users } from "@awthaq/core";
import { Encryption } from "@awthaq/ports";
import {
  WebhookDelivery,
  WebhookPayload,
  WebhookRecords,
  WebhookSignature,
  Webhooks,
  WebhooksApi,
} from "@awthaq/webhooks";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ADMIN,
  advance,
  allRequests,
  configure,
  deliver,
  deliveriesOf,
  drain,
  enqueue,
  eventOfTag,
  httpApp,
  metricCount,
  otherAdmin,
  publishedEvent,
  requestsTo,
  run,
  updateReplies,
  World,
  type SentRequest,
} from "./WebhooksWorld.ts";
import { isRecord, parseJson } from "./shared/WireJson.ts";
import { isNumber, isString } from "./shared/Outcomes.ts";

// ---- helpers ------------------------------------------------------------------------------------

/** The additional authenticated data the plugin binds a sealed secret to (BEH-EA-276): the endpoint and the field. */
const aad = (endpointId: string, field: "secret" | "previousSecret") =>
  `webhooks-endpoint:${endpointId}:${field}`;

const isSentRequest = (value: unknown): value is SentRequest =>
  isRecord(value) &&
  typeof value["url"] === "string" &&
  typeof value["method"] === "string" &&
  typeof value["body"] === "string" &&
  isRecord(value["headers"]);

const endpointNamed = Effect.fn("features.webhooks.endpointNamed")(function* (name: string) {
  const world = yield* World;
  return yield* world.endpoints.get(name);
});

const eventNamed = Effect.fn("features.webhooks.eventNamed")(function* (name: string) {
  const world = yield* World;
  return yield* world.events.get(name);
});

const lastRequestTo = Effect.fn("features.webhooks.lastRequestTo")(function* (name: string) {
  const endpoint = yield* endpointNamed(name);
  const request = (yield* requestsTo(endpoint)).at(-1);
  if (request === undefined) return yield* Effect.die(new Error(`nothing was sent to "${name}"`));
  const world = yield* World;
  yield* world.out.set("request", request);
  return request;
});

const thatRequest = Effect.fn("features.webhooks.thatRequest")(function* () {
  const world = yield* World;
  return yield* world.out.getAs("request", isSentRequest);
});

const bodyOf = (request: SentRequest) => {
  const parsed = parseJson(request.body);
  if (!isRecord(parsed)) throw new Error(`the body is not a JSON object: ${request.body}`);
  return parsed;
};

/** Seeds an endpoint into the records with a real sealed secret, bypassing the administrator gate. */
const seedEndpoint = Effect.fn("features.webhooks.seedEndpoint")(function* (
  name: string,
  filter: string,
  url: string,
) {
  const world = yield* World;
  const secret = yield* run(WebhookSignature.generateSecret);
  yield* run(
    Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const encryption = yield* Encryption.Encryption;
      yield* records.createEndpoint({
        id: name,
        url,
        eventTags: [filter],
        secret: yield* encryption.encrypt(secret, aad(name, "secret")),
        createdBy: "admin-1",
      });
    }),
  );
  yield* world.endpoints.set(name, { id: name, url, secret: Redacted.value(secret) });
});

const urlFor = (name: string) => `https://hooks.example.com/${name}`;

const endpointRow = Effect.fn("features.webhooks.endpointRow")(function* (name: string) {
  const row = yield* run(
    Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.findEndpoint(name)),
  );
  if (Option.isNone(row)) return yield* Effect.die(new Error(`no endpoint row "${name}"`));
  return row.value;
});

const deliveryOf = Effect.fn("features.webhooks.deliveryOf")(function* (
  eventName: string,
  endpointName: string,
) {
  const endpoint = yield* endpointNamed(endpointName);
  const event = yield* eventNamed(eventName);
  const row = (yield* deliveriesOf(endpoint.id)).find((entry) => entry.eventId === event.eventId);
  if (row === undefined)
    return yield* Effect.die(new Error(`no delivery of "${eventName}" to "${endpointName}"`));
  return row;
});

const service = <A, E>(use: (webhooks: Webhooks.WebhooksShape) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(Webhooks.Webhooks, use));

const failureTag = (result: Result.Result<unknown, { readonly _tag: string }>) =>
  Result.isFailure(result) ? result.failure._tag : "succeeded";

/** `verify` under one secret, with the request's headers and body unless a scenario tampered with them. */
const verifyWith = (
  request: SentRequest,
  secret: string,
  tampered: {
    readonly headers?: Readonly<Record<string, string | undefined>>;
    readonly body?: string;
    readonly nowSeconds?: number;
  } = {},
) =>
  run(
    WebhookSignature.verify({
      secrets: [Redacted.make(secret)],
      headers: tampered.headers ?? request.headers,
      body: tampered.body ?? request.body,
      ...(tampered.nowSeconds === undefined ? {} : { nowSeconds: tampered.nowSeconds }),
    }),
  );

/** The reason a receiver's verification was refused; a refusal that is not the signature's own is a defect in the step. */
const refusalReason = (result: Result.Result<unknown, { readonly _tag: string }>) => {
  if (Result.isSuccess(result)) return "ok";
  const failure = result.failure;
  if (failure._tag !== "InvalidWebhookSignature") {
    throw new Error(`verification failed for a reason other than the signature: ${failure._tag}`);
  }
  return Reflect.get(failure, "reason");
};

const REFUSAL = "verification";

/** Applies one of the scenario's named tamperings to a delivered request and records what the receiver said. */
const receiverVerifies = Effect.fn("features.webhooks.receiverVerifies")(function* (
  tampering: string,
) {
  const world = yield* World;
  const name = yield* world.endpoints.current;
  const request = yield* lastRequestTo(name);
  const secret = (yield* endpointNamed(name)).secret;
  const timestamp = Number(request.headers["webhook-timestamp"]);
  const remove = /^removing the "(.+)" header$/.exec(tampering);
  const set = /^setting "(.+)" to "(.*)"$/.exec(tampering);
  const clock = /^its own clock running (\d+) minutes (ahead|behind)$/.exec(tampering);
  let attempt: ReturnType<typeof verifyWith>;
  if (remove?.[1] !== undefined) {
    attempt = verifyWith(request, secret, {
      headers: { ...request.headers, [remove[1]]: undefined },
    });
  } else if (set?.[1] !== undefined && set[2] !== undefined) {
    attempt = verifyWith(request, secret, { headers: { ...request.headers, [set[1]]: set[2] } });
  } else if (clock?.[1] !== undefined) {
    const offset = Number(clock[1]) * 60 * (clock[2] === "ahead" ? 1 : -1);
    attempt = verifyWith(request, secret, { nowSeconds: timestamp + offset });
  } else if (tampering === "changing one character of the body") {
    attempt = verifyWith(request, secret, { body: request.body.replace("user-1", "user-2") });
  } else if (tampering === "replacing the signature with one from another key") {
    const other = Redacted.value(yield* run(WebhookSignature.generateSecret));
    const forged = yield* run(
      WebhookSignature.sign(Redacted.make(other), {
        id: request.headers["webhook-id"] ?? "",
        timestamp,
        body: request.body,
      }),
    );
    attempt = verifyWith(request, secret, {
      headers: { ...request.headers, "webhook-signature": forged },
    });
  } else {
    return yield* Effect.die(new Error(`the World does not know the tampering "${tampering}"`));
  }
  const outcome = yield* Effect.result(attempt);
  yield* world.out.set(REFUSAL, refusalReason(outcome));
});

const registrationOutcome = "registration";

const tryRegister = Effect.fn("features.webhooks.tryRegister")(function* (
  url: string,
  filter: string,
) {
  const world = yield* World;
  const result = yield* service((webhooks) =>
    Effect.result(webhooks.createEndpoint(ADMIN, { url, eventTags: [filter] })),
  );
  if (Result.isSuccess(result)) {
    yield* world.out.set(registrationOutcome, { tag: "created", reason: "" });
    return result.success;
  }
  const failure = result.failure;
  yield* world.out.set(registrationOutcome, {
    tag: failure._tag,
    reason: failure._tag === "InvalidWebhookEndpoint" ? failure.reason : "",
  });
  return undefined;
});

const isRefusal = (value: unknown): value is { readonly tag: string; readonly reason: string } =>
  isRecord(value) && typeof value["tag"] === "string" && typeof value["reason"] === "string";

const OPERATIONS = [
  "createEndpoint",
  "listEndpoints",
  "getEndpoint",
  "updateEndpoint",
  "deleteEndpoint",
  "rotateSecret",
  "listDeliveries",
  "retryDelivery",
] as const;

const expectQueued = (
  rows: ReadonlyArray<{ readonly eventId: string }>,
  event: AuthEvents.Published,
) => rows.some((row) => row.eventId === event.eventId);

const deliveredHeadersCount = (request: SentRequest) =>
  (request.headers["webhook-signature"] ?? "").split(" ").filter((part) => part !== "").length;

const advanceBy = (unit: "seconds" | "minutes" | "hours" | "days") =>
  function* (amount: number) {
    yield* advance(Duration[unit](amount));
  };

// ---- the steps ----------------------------------------------------------------------------------

export const webhooksSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- configuration (before the app is first used) ----

  Given("the plugin is configured with includeClientContext", function* () {
    yield* configure({ includeClientContext: true });
  });
  Given("the plugin is configured with allowPrivateTargets", function* () {
    yield* configure({ allowPrivateTargets: true });
  });
  Given("the administrator gate allows every action", function* () {
    yield* configure({ gate: "allow" });
  });
  Given("no administrator gate is configured", function* () {
    yield* configure({ gate: "deny" });
  });
  Given(
    "the administrator gate allows only actions starting with {string}",
    function* (prefix: string) {
      assert.equal(prefix, "list", "the World's read-only gate lets through the list actions");
      yield* configure({ gate: "readOnly" });
    },
  );
  Given(
    "the plugin allows {int} delivery attempts, retrying after {int} seconds with a factor of {int}",
    function* (attempts: number, base: number, factor: number) {
      yield* configure({
        maxAttempts: attempts,
        retryBase: Duration.seconds(base),
        retryFactor: factor,
      });
    },
  );
  Given("the retry delay is capped at {int} seconds", function* (seconds: number) {
    yield* configure({ retryMax: Duration.seconds(seconds) });
  });
  Given(
    "endpoints are switched off after {int} consecutive dead-lettered deliveries",
    function* (count: number) {
      yield* configure({ disableAfterConsecutiveDead: count });
    },
  );
  Given("each administrator may make {int} calls per minute", function* (limit: number) {
    yield* configure({ limiter: "memory" });
    yield* configure({ adminRate: { limit, window: Duration.minutes(1) } });
  });
  Given("each endpoint may receive {int} delivery per minute", function* (limit: number) {
    yield* configure({ limiter: "memory" });
    yield* configure({ deliveryRate: { limit, window: Duration.minutes(1) } });
  });
  Given("no more than {int} endpoints may be registered", function* (limit: number) {
    yield* configure({ maxEndpoints: limit });
  });

  // ---- the receiver ----

  const answers = function* (status: number) {
    yield* updateReplies((current) => ({ ...current, base: () => ({ status }) }));
  };
  Given("the receiver answers {int}", answers);
  Given("the receiver answers {int} to {string}", function* (status: number, name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* updateReplies((current) => ({
      ...current,
      byUrl: { ...current.byUrl, [endpoint.url]: () => ({ status }) },
    }));
  });
  Given(
    "the receiver answers {int} to the first attempt and 200 afterwards",
    function* (first: number) {
      let calls = 0;
      yield* updateReplies((current) => ({
        ...current,
        base: () => ({ status: (calls += 1) === 1 ? first : 200 }),
      }));
    },
  );
  Given("the receiver fails at the transport level", function* () {
    yield* updateReplies((current) => ({ ...current, base: () => ({ transportError: true }) }));
  });
  Given(
    "the receiver answers 302 with a Location header naming the cloud metadata address",
    function* () {
      // The fake receiver puts `Location: http://169.254.169.254/` on every answer.
      yield* updateReplies((current) => ({ ...current, base: () => ({ status: 302 }) }));
    },
  );
  Given("the receiver answers 500 with the body {string}", function* (body: string) {
    yield* updateReplies((current) => ({ ...current, base: () => ({ status: 500, body }) }));
  });

  // ---- endpoints ----

  Given("an endpoint {string} registered for {string}", function* (name: string, filter: string) {
    yield* seedEndpoint(name, filter, urlFor(name));
  });
  Given(
    "an endpoint {string} registered for {string} at {string}",
    function* (name: string, filter: string, url: string) {
      yield* seedEndpoint(name, filter, url);
    },
  );

  const rotate = function* (name: string, keeping: string) {
    const world = yield* World;
    const endpoint = yield* endpointNamed(name);
    yield* world.secrets.set(keeping, endpoint.secret);
    const rotated = yield* service((webhooks) => webhooks.rotateSecret(ADMIN, endpoint.id));
    yield* world.endpoints.set(name, { ...endpoint, secret: rotated.secret });
    yield* world.out.set("rotated", rotated);
  };
  Given("the secret of {string} is rotated, keeping the old one as {string}", rotate);

  Given(
    "the sealed secret of {string} is copied into the row of {string}",
    function* (from: string, into: string) {
      const source = yield* endpointRow(from);
      yield* run(
        Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
          records.setSecrets(into, {
            secret: source.secret,
            previousSecret: null,
            previousSecretExpiresAt: null,
          }),
        ),
      );
    },
  );
  Given(
    "the previous sealed secret of {string} is moved into its current secret field",
    function* (name: string) {
      const row = yield* endpointRow(name);
      const previous = Option.getOrThrow(row.previousSecret);
      yield* run(
        Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
          records.setSecrets(name, {
            secret: previous,
            previousSecret: null,
            previousSecretExpiresAt: null,
          }),
        ),
      );
    },
  );

  const switchOff = function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* service((webhooks) => webhooks.updateEndpoint(ADMIN, endpoint.id, { enabled: false }));
  };
  const switchOn = function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* service((webhooks) => webhooks.updateEndpoint(ADMIN, endpoint.id, { enabled: true }));
  };
  Given("endpoint {string} is switched off", switchOff);
  Given("endpoint {string} is switched back on", switchOn);

  // ---- events ----

  Given(
    "a {string} event {string} for user {string}",
    function* (tag: string, name: string, user: string) {
      const world = yield* World;
      const event = yield* publishedEvent(yield* eventOfTag(tag, user));
      yield* world.events.set(name, event);
    },
  );
  Given(
    "a {string} event {string} for user {string} with correlation {string} and trace {string}",
    function* (tag: string, name: string, user: string, correlation: string, trace: string) {
      const world = yield* World;
      const event = yield* publishedEvent(yield* eventOfTag(tag, user), {
        correlationId: Option.some(correlation),
        traceId: Option.some(trace),
      });
      yield* world.events.set(name, event);
    },
  );
  Given(
    "a {string} event {string} for user {string} that also carries a field {string} holding {string}",
    function* (tag: string, name: string, user: string, field: string, value: string) {
      const world = yield* World;
      const event = yield* publishedEvent(yield* eventOfTag(tag, user));
      // A future event with a careless field, added after the fact: no event schema declares it.
      const careless = { ...event };
      Reflect.set(careless, field, value);
      yield* world.events.set(name, careless);
    },
  );
  Given(
    "an impersonation event {string} with the justification {string}",
    function* (name: string, justification: string) {
      const world = yield* World;
      const event = yield* publishedEvent({
        _tag: "auth.admin.impersonationStarted",
        adminUserId: Users.UserId("admin-1"),
        targetUserId: Users.UserId("user-2"),
        reason: justification,
        sessionId: Sessions.SessionId("s-1"),
      });
      yield* world.events.set(name, event);
    },
  );
  Given(
    "a sign-in failure event {string} from {string} with the user agent {string}",
    function* (name: string, address: string, userAgent: string) {
      const world = yield* World;
      const event = yield* publishedEvent(
        {
          _tag: "auth.user.signInFailed",
          strategy: "password",
          reason: "invalidCredentials",
          clientIp: address,
          identifierDigest: "abc123",
        },
        { ip: Option.some(address), userAgent: Option.some(userAgent) },
      );
      yield* world.events.set(name, event);
    },
  );

  // ---- queueing and delivery ----

  When("event {string} is queued", function* (name: string) {
    yield* enqueue([yield* eventNamed(name)]);
  });
  When("event {string} is queued and delivered", function* (name: string) {
    yield* deliver([yield* eventNamed(name)]);
  });
  When("events {string} and {string} are queued", function* (first: string, second: string) {
    const world = yield* World;
    yield* world.out.set(
      "queued1",
      yield* enqueue([yield* eventNamed(first), yield* eventNamed(second)]),
    );
  });
  When("events {string} and {string} are queued again", function* (first: string, second: string) {
    const world = yield* World;
    yield* world.out.set(
      "queued2",
      yield* enqueue([yield* eventNamed(first), yield* eventNamed(second)]),
    );
  });
  When(
    "events {string} and {string} are queued and delivered",
    function* (first: string, second: string) {
      yield* deliver([yield* eventNamed(first), yield* eventNamed(second)]);
    },
  );
  When("the delivery worker runs", function* () {
    yield* drain;
  });

  Given("the clock advances {int} seconds", advanceBy("seconds"));
  Given("the clock advances {int} minutes", advanceBy("minutes"));
  Given("the clock advances {int} hours", advanceBy("hours"));
  Given("the clock advances {int} days", advanceBy("days"));

  Given(
    "events are published on the bus: a {string} event for user {string} and a {string} event for user {string}",
    function* (tagA: string, userA: string, tagB: string, userB: string) {
      yield* run(
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          yield* events.publish(yield* eventOfTag(tagA, userA));
          yield* events.publish(yield* eventOfTag(tagB, userB));
        }),
      );
    },
  );
  const handOver = run(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* Layer.build(WebhookDelivery.transportLayer);
        return yield* EventRelay.drainOnce({ name: WebhookDelivery.RELAY_NAME }).pipe(
          Effect.provide(transport),
        );
      }),
    ),
  );
  When("the relay named {string} hands over what it has settled", function* (name: string) {
    assert.equal(name, WebhookDelivery.RELAY_NAME);
    const world = yield* World;
    // Let the relay's settle delay pass, so the events are old enough to be handed over.
    yield* advance(Duration.seconds(3));
    yield* world.out.set("handed1", yield* handOver);
  });
  When("the relay hands over what it has settled again", function* () {
    const world = yield* World;
    yield* world.out.set("handed2", yield* handOver);
  });

  When("a worker claims what is due and never finishes", function* () {
    yield* run(
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const claimed = yield* records.claimDue({
          now: yield* DateTime.now,
          limit: 50,
          lease: Duration.minutes(1),
        });
        assert.equal(claimed.length, 1);
      }),
    );
  });

  When(
    "the administrator retries the delivery of event {string} to {string}",
    function* (eventName: string, endpointName: string) {
      const row = yield* deliveryOf(eventName, endpointName);
      yield* service((webhooks) => webhooks.retryDelivery(ADMIN, row.id));
    },
  );

  When("the retention prune runs", function* () {
    const world = yield* World;
    yield* world.out.set("pruned", yield* run(WebhookDelivery.pruneOnce));
  });

  When("the account erasure of {string} runs", function* (user: string) {
    yield* run(
      Effect.gen(function* () {
        const registry = yield* Erasure.ErasureRegistry;
        for (const contribution of yield* registry.contributions) {
          yield* contribution.erase({ userId: Users.UserId(user) });
        }
      }),
    );
  });

  // ---- what a receiver sees ----

  Then("endpoint {string} was sent {int} request(s)", function* (name: string, count: number) {
    const endpoint = yield* endpointNamed(name);
    const requests = yield* requestsTo(endpoint);
    assert.equal(requests.length, count);
    if (count === 1 && requests[0] !== undefined) {
      const world = yield* World;
      yield* world.out.set("request", requests[0]);
    }
  });
  Then("no request was sent to any receiver", function* () {
    assert.equal((yield* allRequests).length, 0);
  });
  Then("that request is a POST of a JSON body", function* () {
    const request = yield* thatRequest();
    assert.equal(request.method, "POST");
    assert.match(request.headers["content-type"] ?? "", /^application\/json/);
    bodyOf(request);
  });
  Then("its {string} header is the id of event {string}", function* (header: string, name: string) {
    const request = yield* thatRequest();
    assert.equal(request.headers[header], (yield* eventNamed(name)).eventId);
  });
  Then("its {string} header is one {string} signature", function* (header: string, scheme: string) {
    const request = yield* thatRequest();
    const value = request.headers[header] ?? "";
    assert.equal(value.split(" ").length, 1);
    assert.ok(value.startsWith(scheme), `expected a "${scheme}" signature, got ${value}`);
  });
  Then(
    "verifying that request under the secret of {string} succeeds and yields the id of event {string}",
    function* (name: string, eventName: string) {
      const request = yield* thatRequest();
      const id = yield* verifyWith(request, (yield* endpointNamed(name)).secret);
      assert.equal(id, (yield* eventNamed(eventName)).eventId);
    },
  );
  Then("both requests carry the same {string}", function* (header: string) {
    const world = yield* World;
    const endpoint = yield* world.endpoints.get(yield* world.endpoints.current);
    const [first, second] = yield* requestsTo(endpoint);
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.headers[header], second.headers[header]);
    assert.ok(first.headers[header] !== undefined);
  });
  Then(
    "the second request's {string} is {int} seconds after the first's",
    function* (header: string, seconds: number) {
      const world = yield* World;
      const endpoint = yield* world.endpoints.get(yield* world.endpoints.current);
      const [first, second] = yield* requestsTo(endpoint);
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(Number(second.headers[header]) - Number(first.headers[header]), seconds);
    },
  );

  // ---- signatures and rotation ----

  Then(
    "the request to {string} carries {int} signature(s)",
    function* (name: string, count: number) {
      assert.equal(deliveredHeadersCount(yield* lastRequestTo(name)), count);
    },
  );
  Then("verifying that request under the secret {string} succeeds", function* (name: string) {
    const world = yield* World;
    yield* verifyWith(yield* thatRequest(), yield* world.secrets.get(name));
  });
  Then(
    "verifying that request under the current secret of {string} succeeds",
    function* (name: string) {
      yield* verifyWith(yield* thatRequest(), (yield* endpointNamed(name)).secret);
    },
  );
  Then(
    "verifying that request under the secret {string} is refused as {string}",
    function* (name: string, reason: string) {
      const world = yield* World;
      const outcome = yield* Effect.result(
        verifyWith(yield* thatRequest(), yield* world.secrets.get(name)),
      );
      assert.ok(Result.isFailure(outcome), "the verification should have been refused");
      assert.equal(refusalReason(outcome), reason);
    },
  );
  When("the receiver verifies that request after {}", function* (tampering: string) {
    yield* receiverVerifies(tampering);
  });
  Then("the verification is refused as {string}", function* (reason: string) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs(REFUSAL, isString), reason);
  });
  Then("the verification succeeds", function* () {
    const world = yield* World;
    assert.equal(yield* world.out.getAs(REFUSAL, isString), "ok");
  });

  // ---- secrets ----

  When(
    "the administrator registers {string} for {string} as {string}",
    function* (url: string, filter: string, name: string) {
      const world = yield* World;
      const created = yield* tryRegister(url, filter);
      assert.ok(created !== undefined, "the registration should have succeeded");
      yield* world.endpoints.set(name, { id: created.endpoint.id, url, secret: created.secret });
      yield* world.out.set("creation", created.secret);
      yield* world.out.set("createdId", created.endpoint.id);
    },
  );
  Then(
    "the creation response carries a secret of the form {string} followed by 32 random bytes",
    function* (prefix: string) {
      const world = yield* World;
      const secret = yield* world.out.getAs("creation", isString);
      assert.equal(prefix, "whsec_");
      assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
    },
  );
  Then("listing endpoints never contains that secret", function* () {
    const world = yield* World;
    const secret = yield* world.out.getAs("creation", isString);
    const listed = yield* service((webhooks) => webhooks.listEndpoints(ADMIN));
    assert.equal(JSON.stringify(listed).includes(secret), false);
  });
  Then("reading endpoint {string} never contains that secret", function* (name: string) {
    const world = yield* World;
    const secret = yield* world.out.getAs("creation", isString);
    const endpoint = yield* endpointNamed(name);
    const read = yield* service((webhooks) => webhooks.getEndpoint(ADMIN, endpoint.id));
    assert.equal(JSON.stringify(read).includes(secret), false);
  });

  Then("the stored secret of {string} does not contain its plaintext", function* (name: string) {
    const world = yield* World;
    const endpoint = yield* endpointNamed(name);
    const row = yield* endpointRow(name);
    assert.equal(row.secret.includes(endpoint.secret), false);
    assert.equal(row.secret.includes("whsec_"), false);
    yield* world.out.set("sealed", name);
  });
  Then(
    "it decrypts to the plaintext only under the additional data naming {string} and {string}",
    function* (name: string, field: string) {
      const world = yield* World;
      const sealedOf = yield* world.out.getAs("sealed", isString);
      const row = yield* endpointRow(sealedOf);
      const plaintext = yield* run(
        Effect.flatMap(Encryption.Encryption, (encryption) =>
          encryption.decrypt(
            row.secret,
            aad(name, field === "secret" ? "secret" : "previousSecret"),
          ),
        ),
      );
      assert.equal(Redacted.value(plaintext.plaintext), (yield* endpointNamed(sealedOf)).secret);
    },
  );
  Then(
    "it does not decrypt under the additional data naming {string} and {string}",
    function* (name: string, field: string) {
      const world = yield* World;
      const sealedOf = yield* world.out.getAs("sealed", isString);
      const row = yield* endpointRow(sealedOf);
      const outcome = yield* run(
        Effect.flatMap(Encryption.Encryption, (encryption) =>
          Effect.exit(
            encryption.decrypt(
              row.secret,
              aad(name, field === "secret" ? "secret" : "previousSecret"),
            ),
          ),
        ),
      );
      assert.ok(
        Exit.isFailure(outcome),
        "the envelope must not open under another endpoint's or field's data",
      );
    },
  );

  Then(
    "the delivery of event {string} to {string} failed as {string}",
    function* (eventName: string, endpointName: string, errorClass: string) {
      const row = yield* deliveryOf(eventName, endpointName);
      assert.deepEqual(row.lastError, Option.some(errorClass));
    },
  );
  Then(
    "the secret of {string} is different from {string}",
    function* (name: string, other: string) {
      const world = yield* World;
      assert.notEqual((yield* endpointNamed(name)).secret, yield* world.secrets.get(other));
    },
  );
  Then(
    "the previous secret of {string} expires {int} hours from now",
    function* (name: string, hours: number) {
      const row = yield* endpointRow(name);
      const now = yield* DateTime.now;
      const expires = Option.getOrThrow(row.previousSecretExpiresAt);
      assert.equal(
        DateTime.toEpochMillis(expires) - DateTime.toEpochMillis(now),
        Duration.toMillis(Duration.hours(hours)),
      );
    },
  );

  // ---- the payload ----

  Then(
    "the body sent to {string} has version 1, type {string}, the id of event {string} and an ISO timestamp",
    function* (name: string, type: string, eventName: string) {
      const body = bodyOf(yield* lastRequestTo(name));
      assert.equal(body["version"], 1);
      assert.equal(body["type"], type);
      assert.equal(body["id"], (yield* eventNamed(eventName)).eventId);
      assert.ok(
        typeof body["timestamp"] === "string" && !Number.isNaN(Date.parse(body["timestamp"])),
      );
    },
  );
  Then(
    "its data is exactly the event's fields {string} and {string}",
    function* (first: string, second: string) {
      const body = bodyOf(yield* thatRequest());
      const data = body["data"];
      assert.ok(isRecord(data));
      assert.deepEqual(Object.keys(data).sort(), [first, second].sort());
    },
  );
  Then(
    "the body sent to {string} carries correlationId {string} and traceId {string}",
    function* (name: string, correlation: string, trace: string) {
      const body = bodyOf(yield* lastRequestTo(name));
      assert.equal(body["correlationId"], correlation);
      assert.equal(body["traceId"], trace);
    },
  );
  Then(
    "the body sent to {string} does not contain {string}",
    function* (name: string, text: string) {
      assert.equal((yield* lastRequestTo(name)).body.includes(text), false);
    },
  );
  Then("the body sent to {string} contains {string}", function* (name: string, text: string) {
    assert.ok((yield* lastRequestTo(name)).body.includes(text));
  });
  Then("the body sent to {string} has no client block", function* (name: string) {
    assert.equal("client" in bodyOf(yield* lastRequestTo(name)), false);
  });
  Then(
    "the body sent to {string} has the client block ip {string} and userAgent {string}",
    function* (name: string, address: string, userAgent: string) {
      const client = bodyOf(yield* lastRequestTo(name))["client"];
      assert.ok(isRecord(client));
      assert.equal(client["ip"], address);
      assert.equal(client["userAgent"], userAgent);
    },
  );
  When(
    "the payload of event {string} is built with includeClientContext",
    function* (name: string) {
      const world = yield* World;
      const body = WebhookPayload.toBody(yield* eventNamed(name), { includeClientContext: true });
      yield* world.out.set("payload", JSON.stringify(body));
    },
  );
  Then("the payload does not contain {string}", function* (text: string) {
    const world = yield* World;
    assert.equal((yield* world.out.getAs("payload", isString)).includes(text), false);
  });
  Then("the payload still contains the field {string}", function* (field: string) {
    const world = yield* World;
    assert.ok((yield* world.out.getAs("payload", isString)).includes(`"${field}"`));
  });
  Then(
    "listing the deliveries of {string} returns 1 delivery with outcome fields only",
    function* (name: string) {
      const world = yield* World;
      const endpoint = yield* endpointNamed(name);
      const rows = yield* service((webhooks) => webhooks.listDeliveries(ADMIN, endpoint.id, {}));
      assert.equal(rows.length, 1);
      const text = JSON.stringify(rows);
      assert.equal(text.includes('"body"'), false);
      yield* world.out.set("listing", text);
    },
  );
  Then("that listing does not contain the payload", function* () {
    const world = yield* World;
    const text = yield* world.out.getAs("listing", isString);
    for (const leaked of ["strategy", "user-1", 'auth.user.signedIn":']) {
      assert.equal(
        text.includes(`"${leaked}"`),
        false,
        `the listing must not carry the payload (${leaked})`,
      );
    }
    assert.equal(text.includes('"userId"'), false);
  });

  // ---- filters ----

  Then(
    "event {string} is queued for {string}",
    function* (eventName: string, endpointName: string) {
      const endpoint = yield* endpointNamed(endpointName);
      assert.ok(expectQueued(yield* deliveriesOf(endpoint.id), yield* eventNamed(eventName)));
    },
  );
  Then(
    "event {string} is not queued for {string}",
    function* (eventName: string, endpointName: string) {
      const endpoint = yield* endpointNamed(endpointName);
      assert.equal(
        expectQueued(yield* deliveriesOf(endpoint.id), yield* eventNamed(eventName)),
        false,
      );
    },
  );
  Then("nothing is queued for {string}", function* (endpointName: string) {
    const endpoint = yield* endpointNamed(endpointName);
    assert.deepEqual(yield* deliveriesOf(endpoint.id), []);
  });
  Then(
    "event {string} is not queued for {string} when it is queued",
    function* (eventName: string, endpointName: string) {
      const endpoint = yield* endpointNamed(endpointName);
      const event = yield* eventNamed(eventName);
      yield* enqueue([event]);
      assert.equal(expectQueued(yield* deliveriesOf(endpoint.id), event), false);
    },
  );
  When(
    "the administrator tries to register {string} for {string}",
    function* (url: string, filter: string) {
      yield* tryRegister(url, filter);
    },
  );
  Then(
    "registration is refused as InvalidWebhookEndpoint naming {string}",
    function* (rule: string) {
      const world = yield* World;
      const outcome = yield* world.out.getAs(registrationOutcome, isRefusal);
      assert.equal(outcome.tag, "InvalidWebhookEndpoint");
      assert.ok(
        outcome.reason.includes(rule),
        `expected the reason to name "${rule}", got "${outcome.reason}"`,
      );
    },
  );
  Then("registration is refused as WebhooksActionDenied", function* () {
    const world = yield* World;
    assert.equal(
      (yield* world.out.getAs(registrationOutcome, isRefusal)).tag,
      "WebhooksActionDenied",
    );
  });
  Then("no endpoint exists", function* () {
    const rows = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.listEndpoints),
    );
    assert.deepEqual(rows, []);
  });
  Then(
    "a registration with no event tags is rejected by the endpoint payload schema",
    function* () {
      const outcome = yield* Effect.result(
        Schema.decodeUnknownEffect(WebhooksApi.CreateEndpointPayload)({
          url: "https://hooks.example.com/billing",
          eventTags: [],
        }),
      );
      assert.ok(Result.isFailure(outcome));
    },
  );

  // ---- queueing, retry, dead letter ----

  Then(
    "the first hand-over queued {int} deliveries and the second queued {int}",
    function* (first: number, second: number) {
      const world = yield* World;
      assert.equal(yield* world.out.getAs("queued1", isNumber), first);
      assert.equal(yield* world.out.getAs("queued2", isNumber), second);
    },
  );
  Then("{string} holds exactly {int} delivery rows", function* (name: string, count: number) {
    const endpoint = yield* endpointNamed(name);
    assert.equal((yield* deliveriesOf(endpoint.id)).length, count);
  });
  Then(
    "the first hand-over carried {int} events and the second carried {int}",
    function* (first: number, second: number) {
      const world = yield* World;
      assert.equal(yield* world.out.getAs("handed1", isNumber), first);
      assert.equal(yield* world.out.getAs("handed2", isNumber), second);
    },
  );
  Then(
    "the delivery to {string} succeeded while the delivery to {string} is pending its retry",
    function* (healthy: string, down: string) {
      const ok = (yield* deliveriesOf((yield* endpointNamed(healthy)).id))[0];
      const failing = (yield* deliveriesOf((yield* endpointNamed(down)).id))[0];
      assert.equal(ok?.status, "succeeded");
      assert.equal(failing?.status, "pending");
      assert.equal(failing?.attempts, 1);
    },
  );
  Then(
    "the delivery of event {string} to {string} is pending after {int} attempt(s)",
    function* (eventName: string, endpointName: string, attempts: number) {
      const row = yield* deliveryOf(eventName, endpointName);
      assert.equal(row.status, "pending");
      assert.equal(row.attempts, attempts);
    },
  );
  Then(
    "the delivery of event {string} to {string} is dead after {int} attempt(s)",
    function* (eventName: string, endpointName: string, attempts: number) {
      const row = yield* deliveryOf(eventName, endpointName);
      assert.equal(row.status, "dead");
      assert.equal(row.attempts, attempts);
      assert.ok(Option.isSome(row.completedAt));
    },
  );
  Then("the delivery worker finds nothing due", function* () {
    assert.equal(yield* drain, 0);
  });
  Then("a second worker finds nothing due", function* () {
    assert.equal(yield* drain, 0);
  });
  Then("the delivery worker attempts {int} delivery", function* (count: number) {
    assert.equal(yield* drain, count);
  });
  Then(
    "the delivery of event {string} to {string} records {} and the error class {string}",
    function* (eventName: string, endpointName: string, status: string, errorClass: string) {
      const row = yield* deliveryOf(eventName, endpointName);
      const code = /^status code (\d+)$/.exec(status);
      if (code?.[1] !== undefined) {
        assert.deepEqual(row.lastStatusCode, Option.some(Number(code[1])));
      } else {
        assert.equal(status, "no status code");
        assert.ok(Option.isNone(row.lastStatusCode));
      }
      assert.deepEqual(row.lastError, Option.some(errorClass));
    },
  );
  Then(
    "endpoint {string} is switched off because it is {string}",
    function* (name: string, reason: string) {
      const row = yield* endpointRow(name);
      assert.deepEqual(row.disabledReason, Option.some(reason));
    },
  );
  Then(
    "endpoint {string} has {int} consecutive dead-letters and is still enabled",
    function* (name: string, count: number) {
      const row = yield* endpointRow(name);
      assert.equal(row.consecutiveDead, count);
      assert.ok(Option.isNone(row.disabledAt));
    },
  );
  Then(
    "the delivery of event {string} to {string} is still pending",
    function* (eventName: string, endpointName: string) {
      assert.equal((yield* deliveryOf(eventName, endpointName)).status, "pending");
    },
  );
  Then(
    "the counter awthaq_webhook_deliveries_total for outcome {string} grew by {int}",
    function* (outcome: string, growth: number) {
      const world = yield* World;
      assert.equal((yield* metricCount(outcome)) - (world.metricBase[outcome] ?? 0), growth);
    },
  );

  // ---- SSRF ----

  Then("that request told the client not to follow redirects", function* () {
    assert.equal((yield* thatRequest()).redirect, "manual");
  });
  Then("the request was not repeated at the redirect target", function* () {
    for (const request of yield* allRequests) {
      assert.equal(request.url.includes("169.254.169.254"), false);
    }
  });
  Then(
    "the delivery log of {string} does not contain {string}",
    function* (name: string, text: string) {
      const rows = yield* deliveriesOf((yield* endpointNamed(name)).id);
      assert.equal(JSON.stringify(rows).includes(text), false);
    },
  );
  Then("endpoint {string} exists", function* (name: string) {
    const world = yield* World;
    const endpoint = yield* world.endpoints.get(name).pipe(Effect.orElseSucceed(() => undefined));
    const id = endpoint?.id ?? name;
    const row = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.findEndpoint(id)),
    );
    assert.ok(Option.isSome(row));
  });
  Then("a delivery to {string} is sent", function* (name: string) {
    const world = yield* World;
    const endpoint = yield* endpointNamed(name);
    const event = yield* publishedEvent(yield* eventOfTag("auth.user.signedIn", "user-1"));
    yield* world.events.set("sent", event);
    yield* deliver([event]);
    assert.equal((yield* requestsTo(endpoint)).length, 1);
  });

  // ---- administration ----

  When("the administrator attempts every webhooks operation", function* () {
    const world = yield* World;
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* run(
      Effect.flatMap(AuthEvents.AuthEvents, (events) =>
        events.stream.pipe(
          Stream.runForEach((event) =>
            event._tag === "auth.admin.actionDenied"
              ? Ref.update(seen, (all) => [...all, event.action])
              : Effect.void,
          ),
          Effect.forkIn(world.scope, { startImmediately: true }),
        ),
      ),
    );
    const results = [
      yield* service((webhooks) =>
        Effect.result(
          webhooks.createEndpoint(ADMIN, { url: urlFor("x"), eventTags: ["auth.user.*"] }),
        ),
      ),
      yield* service((webhooks) => Effect.result(webhooks.listEndpoints(ADMIN))),
      yield* service((webhooks) => Effect.result(webhooks.getEndpoint(ADMIN, "any"))),
      yield* service((webhooks) => Effect.result(webhooks.updateEndpoint(ADMIN, "any", {}))),
      yield* service((webhooks) => Effect.result(webhooks.deleteEndpoint(ADMIN, "any"))),
      yield* service((webhooks) => Effect.result(webhooks.rotateSecret(ADMIN, "any"))),
      yield* service((webhooks) => Effect.result(webhooks.listDeliveries(ADMIN, "any", {}))),
      yield* service((webhooks) => Effect.result(webhooks.retryDelivery(ADMIN, "any"))),
    ];
    yield* advance(Duration.millis(10));
    yield* world.out.set(
      "denials",
      results.filter((result) => failureTag(result) === "WebhooksActionDenied").length,
    );
    yield* world.out.set("denialActions", yield* Ref.get(seen));
  });
  Then("all {int} are refused as WebhooksActionDenied", function* (count: number) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("denials", isNumber), count);
  });
  Then('each refusal published auth.admin.actionDenied naming "webhooks.<action>"', function* () {
    const world = yield* World;
    const actions = yield* world.out.getAs(
      "denialActions",
      (value): value is ReadonlyArray<string> => Array.isArray(value) && value.every(isString),
    );
    assert.deepEqual(
      actions,
      OPERATIONS.map((operation) => `webhooks.${operation}`),
    );
  });
  Then("listing endpoints is allowed", function* () {
    assert.deepEqual(yield* service((webhooks) => webhooks.listEndpoints(ADMIN)), []);
  });

  When(
    "the administrator reads endpoint {string} and an unknown endpoint {string}",
    function* (real: string, fake: string) {
      const world = yield* World;
      const endpoint = yield* endpointNamed(real);
      const known = yield* service((webhooks) =>
        Effect.result(webhooks.getEndpoint(ADMIN, endpoint.id)),
      );
      const unknown = yield* service((webhooks) =>
        Effect.result(webhooks.getEndpoint(ADMIN, fake)),
      );
      yield* world.out.set("readTags", [failureTag(known), failureTag(unknown)].join(","));
    },
  );
  Then("both are refused as WebhooksActionDenied", function* () {
    const world = yield* World;
    assert.equal(
      yield* world.out.getAs("readTags", isString),
      "WebhooksActionDenied,WebhooksActionDenied",
    );
  });
  When("the administrator reads an unknown endpoint {string}", function* (fake: string) {
    const world = yield* World;
    const outcome = yield* service((webhooks) => Effect.result(webhooks.getEndpoint(ADMIN, fake)));
    yield* world.out.set("readTags", failureTag(outcome));
  });
  Then("the read is refused as WebhookEndpointNotFound", function* () {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("readTags", isString), "WebhookEndpointNotFound");
  });

  When(
    "administrator {string} lists endpoints {int} times",
    function* (who: string, times: number) {
      const world = yield* World;
      assert.equal(who, "admin-1");
      const tags: Array<string> = [];
      for (let call = 0; call < times; call++) {
        tags.push(
          failureTag(yield* service((webhooks) => Effect.result(webhooks.listEndpoints(ADMIN)))),
        );
      }
      yield* world.out.set("rateTags", tags.join(","));
    },
  );
  Then("the third call is refused as RateLimited", function* () {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("rateTags", isString), "succeeded,succeeded,RateLimited");
  });
  Then("administrator {string} may still list endpoints", function* (who: string) {
    assert.equal(who, "admin-2");
    yield* service((webhooks) => webhooks.listEndpoints(otherAdmin));
  });
  Then("administrator {string} may list endpoints again", function* (who: string) {
    assert.equal(who, "admin-1");
    yield* service((webhooks) => webhooks.listEndpoints(ADMIN));
  });

  When("the administrator registers {int} endpoints", function* (count: number) {
    const world = yield* World;
    const tags: Array<string> = [];
    for (let index = 0; index < count; index++) {
      const result = yield* service((webhooks) =>
        Effect.result(
          webhooks.createEndpoint(ADMIN, { url: urlFor(`n${index}`), eventTags: ["auth.user.*"] }),
        ),
      );
      tags.push(failureTag(result));
    }
    yield* world.out.set("limitTags", tags.join(","));
  });
  Then("the third is refused as WebhookEndpointLimitReached", function* () {
    const world = yield* World;
    assert.equal(
      yield* world.out.getAs("limitTags", isString),
      "succeeded,succeeded,WebhookEndpointLimitReached",
    );
  });

  Then(
    "composing Webhooks puts {string} in the admin API and not in the public API",
    function* (group: string) {
      yield* Effect.void; // an assertion-only step: `Auth.make` is a pure composition
      const auth = Auth.make([Webhooks.Webhooks]);
      assert.ok(Object.keys(auth.adminApi.groups).includes(group));
      assert.equal(Object.keys(auth.publicApi.groups).includes(group), false);
    },
  );

  // ---- over HTTP ----

  Given(
    "the webhooks admin API is served over HTTP with the gate allowing every action",
    function* () {
      yield* configure({ gate: "allow" });
      yield* httpApp;
    },
  );
  Given("the webhooks admin API is served over HTTP with no gate configured", function* () {
    yield* configure({ gate: "deny" });
    yield* httpApp;
  });
  const newEndpoint = { url: urlFor("http"), eventTags: ["auth.user.*"] };
  const httpOutcome = "http";
  When("an unauthenticated client registers an endpoint", function* () {
    const world = yield* World;
    const http = yield* httpApp;
    const response = yield* Effect.promise(() =>
      http.call("POST", "/admin/webhooks/endpoints", { body: newEndpoint }),
    );
    yield* world.out.set(httpOutcome, response);
  });
  When("a signed-in administrator registers an endpoint", function* () {
    const world = yield* World;
    const http = yield* httpApp;
    const response = yield* Effect.promise(async () =>
      http.call("POST", "/admin/webhooks/endpoints", {
        cookie: await http.sessionCookie(),
        body: newEndpoint,
      }),
    );
    yield* world.out.set(httpOutcome, response);
  });
  When("a signed-in administrator registers an endpoint without the CSRF token", function* () {
    const world = yield* World;
    const http = yield* httpApp;
    const response = yield* Effect.promise(async () =>
      http.call("POST", "/admin/webhooks/endpoints", {
        cookie: await http.sessionCookie(),
        body: newEndpoint,
        csrf: false,
      }),
    );
    yield* world.out.set(httpOutcome, response);
  });
  const isHttpOutcome = (
    value: unknown,
  ): value is { readonly status: number; readonly tag: string | undefined } =>
    isRecord(value) && typeof value["status"] === "number";
  Then("the response status is {int}", function* (status: number) {
    const world = yield* World;
    assert.equal((yield* world.out.getAs(httpOutcome, isHttpOutcome)).status, status);
  });
  Then(
    "the response status is {int} with the tag {string}",
    function* (status: number, tag: string) {
      const world = yield* World;
      const outcome = yield* world.out.getAs(httpOutcome, isHttpOutcome);
      assert.equal(outcome.status, status);
      assert.equal(outcome.tag, tag);
    },
  );

  // ---- the rest of the administrator's surface ----

  When(
    "the administrator updates {string} to filter {string} and switches it off and on",
    function* (name: string, filter: string) {
      const world = yield* World;
      const endpoint = yield* endpointNamed(name);
      const moved = yield* service((webhooks) =>
        webhooks.updateEndpoint(ADMIN, endpoint.id, { eventTags: [filter] }),
      );
      assert.deepEqual(moved.eventTags, [filter]);
      const off = yield* service((webhooks) =>
        webhooks.updateEndpoint(ADMIN, endpoint.id, { enabled: false }),
      );
      assert.equal(off.enabled, false);
      const on = yield* service((webhooks) =>
        webhooks.updateEndpoint(ADMIN, endpoint.id, { enabled: true }),
      );
      assert.equal(on.enabled, true);
      yield* world.out.set("updated", true);
    },
  );
  When("the administrator deletes {string}", function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* service((webhooks) => webhooks.deleteEndpoint(ADMIN, endpoint.id));
  });
  Then("endpoint {string} no longer exists", function* (name: string) {
    const row = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.findEndpoint(name)),
    );
    assert.ok(Option.isNone(row));
  });
  Then("deleting it again is refused as WebhookEndpointNotFound", function* () {
    const world = yield* World;
    const endpoint = yield* endpointNamed(yield* world.endpoints.current);
    const outcome = yield* service((webhooks) =>
      Effect.result(webhooks.deleteEndpoint(ADMIN, endpoint.id)),
    );
    assert.equal(failureTag(outcome), "WebhookEndpointNotFound");
  });

  // ---- erasure, export, retention, budget ----

  Then("{string} holds no delivery row about {string}", function* (name: string, user: string) {
    const rows = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.listBySubject(user)),
    );
    assert.equal(rows.filter((row) => row.endpointId === name).length, 0);
  });
  Then(
    "{string} still holds the delivery row about {string}",
    function* (name: string, user: string) {
      const rows = yield* run(
        Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.listBySubject(user)),
      );
      assert.equal(rows.filter((row) => row.endpointId === name).length, 1);
    },
  );
  const exportFor = (user: string) =>
    run(
      Effect.gen(function* () {
        const registry = yield* DataExport.DataExportRegistry;
        const mine = (yield* registry.contributions).find((entry) => entry.id === "webhooks");
        assert.ok(mine !== undefined, "the webhooks plugin contributes to the data-subject export");
        return JSON.stringify(yield* mine.collect({ userId: Users.UserId(user) }));
      }),
    );
  Then(
    "the export for {string} lists event {string} and not event {string}",
    function* (user: string, listed: string, unlisted: string) {
      const text = yield* exportFor(user);
      assert.ok(text.includes((yield* eventNamed(listed)).eventId));
      assert.equal(text.includes((yield* eventNamed(unlisted)).eventId), false);
    },
  );
  Then("the export for {string} contains no body", function* (user: string) {
    const text = yield* exportFor(user);
    assert.equal(text.includes('"body"'), false);
    assert.equal(text.includes("strategy"), false);
  });
  Then("the prune removed {int} row(s)", function* (count: number) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("pruned", isNumber), count);
  });
  Then(
    "one delivery to {string} is pending with 0 attempts and one succeeded",
    function* (name: string) {
      const rows = yield* deliveriesOf((yield* endpointNamed(name)).id);
      assert.deepEqual(rows.map((row) => [row.status, row.attempts]).sort(), [
        ["pending", 0],
        ["succeeded", 1],
      ]);
    },
  );
});
