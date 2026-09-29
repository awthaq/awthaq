// The steps of 34-webhooks.feature's BEH-EA-299 through BEH-EA-303 rules: the tenant on the event envelope, per-tenant
// endpoints, the test ping, the audit events of administrative mutations, and connection pinning. They share the World
// of `WebhooksSteps.ts` (the real in-memory core, records and plugin service, a programmable receiver) and add a
// scriptable resolver and a recording transport, so what a scenario asserts about the pin is what the transport was asked
// to connect to.
import { AuditLog, AuthEvents, Tenant } from "@awthaq/core";
import { WebhookRecords, WebhookSignature, WebhookTransport, Webhooks } from "@awthaq/webhooks";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Http from "node:http";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ADMIN,
  app,
  configure,
  deliveriesOf,
  deliver,
  eventOfTag,
  publishedEvent,
  run,
  World,
} from "./WebhooksWorld.ts";
import {
  bodyOf,
  endpointNamed,
  eventNamed,
  failureTag,
  lastRequestTo,
  seedEndpoint,
  service,
  thatRequest,
  urlFor,
} from "./WebhooksSteps.ts";
import { isRecord } from "./shared/WireJson.ts";
import { isNumber, isString } from "./shared/Outcomes.ts";

/** `none` is outside any tenant; anything else is a tenant (organization) id. */
const inScope = <A, E, R>(scope: string, effect: Effect.Effect<A, E, R>) =>
  scope === "none" ? effect : Tenant.withTenant(scope)(effect);

const tenantOption = (scope: string) =>
  scope === "none" ? Option.none<string>() : Option.some(scope);

const auditRows = run(Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.list()));

const webhookAuditRows = Effect.map(auditRows, (rows) =>
  rows.filter((row) => row.eventTag.startsWith("auth.webhooks.")),
);

const deliveryRows = (endpointId: string) => deliveriesOf(endpointId);

const testDeliveryOf = Effect.fn("features.webhooks.testDeliveryOf")(function* (name: string) {
  const endpoint = yield* endpointNamed(name);
  const row = (yield* deliveryRows(endpoint.id)).find((entry) => entry.eventTag === "webhook.test");
  if (row === undefined) return yield* Effect.die(new Error(`no test delivery for "${name}"`));
  return row;
});

const isTransportRequest = (value: unknown): value is WebhookTransport.TransportRequest =>
  isRecord(value) && typeof value["url"] === "string" && isRecord(value["headers"]);

export const webhooksOperationsSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-299: the tenant on the envelope ----

  When(
    "a {string} event for user {string} is published inside tenant {string} and relayed from the audit log",
    function* (tag: string, user: string, tenant: string) {
      const world = yield* World;
      const event = yield* eventOfTag(tag, user);
      yield* run(
        Effect.flatMap(AuthEvents.AuthEvents, (events) => events.publish(event)).pipe(
          Tenant.withTenant(tenant),
        ),
      );
      const rows = yield* run(
        Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.replay().pipe(Stream.runCollect)),
      );
      const [row] = rows;
      assert.ok(row !== undefined, "the event reached the audit log");
      yield* world.out.set(
        "auditTenant",
        Option.getOrElse(row.tenantId, () => "none"),
      );
      yield* deliver(rows.map(AuditLog.toPublished));
    },
  );
  When(
    "a {string} event for user {string} is published outside a tenant and relayed from the audit log",
    function* (tag: string, user: string) {
      const world = yield* World;
      const event = yield* eventOfTag(tag, user);
      yield* run(Effect.flatMap(AuthEvents.AuthEvents, (events) => events.publish(event)));
      const rows = yield* run(
        Effect.flatMap(AuditLog.AuditLog, (auditLog) => auditLog.replay().pipe(Stream.runCollect)),
      );
      const [row] = rows;
      assert.ok(row !== undefined, "the event reached the audit log");
      yield* world.out.set(
        "auditTenant",
        Option.getOrElse(row.tenantId, () => "none"),
      );
      yield* deliver(rows.map(AuditLog.toPublished));
    },
  );
  Then("the audit row of that event names tenant {string}", function* (tenant: string) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("auditTenant", isString), tenant);
  });
  Then("the audit row of that event names no tenant", function* () {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("auditTenant", isString), "none");
  });
  Then(
    "the body sent to {string} carries tenantId {string}",
    function* (name: string, tenant: string) {
      assert.equal(bodyOf(yield* lastRequestTo(name))["tenantId"], tenant);
    },
  );
  Then("the body sent to {string} has no tenantId", function* (name: string) {
    assert.equal("tenantId" in bodyOf(yield* lastRequestTo(name)), false);
  });
  Then(
    "the body sent to {string} has no {string} among its data fields",
    function* (name: string, field: string) {
      const data = bodyOf(yield* lastRequestTo(name))["data"];
      assert.ok(isRecord(data));
      assert.equal(field in data, false);
    },
  );

  // ---- BEH-EA-300: endpoints belong to a tenant ----

  Given("the plugin is configured to let platform endpoints hear every tenant", function* () {
    yield* configure({ platformEndpointsHearAllTenants: true });
  });
  Given(
    "an endpoint {string} of tenant {string} registered for {string}",
    function* (name: string, tenant: string, filter: string) {
      yield* seedEndpoint(name, filter, urlFor(name), tenant);
    },
  );
  Given(
    "a {string} event {string} for user {string} in scope {string}",
    function* (tag: string, name: string, user: string, scope: string) {
      const world = yield* World;
      const event = yield* publishedEvent(yield* eventOfTag(tag, user), {
        tenantId: tenantOption(scope),
      });
      yield* world.events.set(name, event);
    },
  );
  Then("event {string} is queued only for {string}", function* (eventName: string, only: string) {
    const event = yield* eventNamed(eventName);
    const endpoints = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.listEndpoints),
    );
    assert.ok(endpoints.length > 1, "the scenario has several endpoints to tell apart");
    for (const endpoint of endpoints) {
      const queued = (yield* deliveriesOf(endpoint.id)).some(
        (row) => row.eventId === event.eventId,
      );
      assert.equal(queued, endpoint.id === only, `endpoint "${endpoint.id}"`);
    }
  });
  When(
    "the administrator in scope {string} registers {string} for {string} as {string}",
    function* (scope: string, url: string, filter: string, name: string) {
      const world = yield* World;
      const created = yield* run(
        inScope(
          scope,
          Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
            webhooks.createEndpoint(ADMIN, { url, eventTags: [filter] }),
          ),
        ),
      );
      yield* world.endpoints.set(name, { id: created.endpoint.id, url, secret: created.secret });
    },
  );
  Then("endpoint {string} belongs to tenant {string}", function* (name: string, tenant: string) {
    const endpoint = yield* endpointNamed(name);
    const row = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.findEndpoint(endpoint.id)),
    );
    assert.ok(Option.isSome(row));
    assert.deepEqual(row.value.tenantId, Option.some(tenant));
  });
  Then(
    "the administrator in scope {string} lists {int} endpoint(s)",
    function* (scope: string, count: number) {
      const listed = yield* run(
        inScope(
          scope,
          Effect.flatMap(Webhooks.Webhooks, (webhooks) => webhooks.listEndpoints(ADMIN)),
        ),
      );
      assert.equal(listed.length, count);
    },
  );
  When(
    "the administrator in scope {string} tries every operation on endpoint {string}",
    function* (scope: string, name: string) {
      const world = yield* World;
      const endpoint = yield* endpointNamed(name);
      const attempts = yield* run(
        inScope(
          scope,
          Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
            Effect.all([
              Effect.result(webhooks.getEndpoint(ADMIN, endpoint.id)),
              Effect.result(webhooks.updateEndpoint(ADMIN, endpoint.id, { enabled: false })),
              Effect.result(webhooks.rotateSecret(ADMIN, endpoint.id)),
              Effect.result(webhooks.listDeliveries(ADMIN, endpoint.id, {})),
              Effect.result(webhooks.testEndpoint(ADMIN, endpoint.id)),
              Effect.result(webhooks.deleteEndpoint(ADMIN, endpoint.id)),
            ]),
          ),
        ),
      );
      const unknown = yield* run(
        inScope(
          scope,
          Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
            Effect.result(webhooks.getEndpoint(ADMIN, "no-such-endpoint")),
          ),
        ),
      );
      yield* world.out.set("foreignTags", attempts.map(failureTag).join(","));
      yield* world.out.set("unknownTag", failureTag(unknown));
    },
  );
  Then("every operation is answered exactly as for an endpoint that does not exist", function* () {
    const world = yield* World;
    const unknown = yield* world.out.getAs("unknownTag", isString);
    assert.equal(unknown, "WebhookEndpointNotFound");
    assert.equal(
      yield* world.out.getAs("foreignTags", isString),
      Array.from({ length: 6 }, () => unknown).join(","),
    );
  });
  Then("endpoint {string} is untouched and enabled", function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    const row = yield* run(
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) => records.findEndpoint(endpoint.id)),
    );
    assert.ok(Option.isSome(row));
    assert.ok(Option.isNone(row.value.disabledAt));
  });
  When(
    "the administrator in scope {string} registers 2 endpoints, one at a time",
    function* (scope: string) {
      const world = yield* World;
      const attempt = () =>
        run(
          inScope(
            scope,
            Effect.flatMap(Webhooks.Webhooks, (webhooks) =>
              Effect.result(webhooks.createEndpoint(ADMIN, { url: urlFor("x"), eventTags: ["*"] })),
            ),
          ),
        );
      const first = yield* attempt();
      const second = yield* attempt();
      yield* world.out.set("budget", `${failureTag(first)},${failureTag(second)}`);
    },
  );
  Then("the first succeeds and the second is refused as WebhookEndpointLimitReached", function* () {
    const world = yield* World;
    assert.equal(
      yield* world.out.getAs("budget", isString),
      "succeeded,WebhookEndpointLimitReached",
    );
  });

  // ---- BEH-EA-301: the test ping ----

  When("the administrator sends a test ping to {string}", function* (name: string) {
    const world = yield* World;
    const endpoint = yield* endpointNamed(name);
    const outcome = yield* service((webhooks) =>
      Effect.result(webhooks.testEndpoint(ADMIN, endpoint.id)),
    );
    yield* world.out.set("pingTag", failureTag(outcome));
    if (Result.isSuccess(outcome)) {
      yield* world.out.set("pingEventId", outcome.success.eventId);
      yield* world.out.set("pingStatus", outcome.success.status);
    }
  });
  Then("the ping is queued as pending and nothing has been sent", function* () {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("pingTag", isString), "succeeded");
    assert.equal(yield* world.out.getAs("pingStatus", isString), "pending");
    assert.equal((yield* (yield* app).receiver.sent).length, 0);
  });
  Then(
    "the body sent to {string} is the test event naming endpoint {string}",
    function* (name: string, endpointName: string) {
      const world = yield* World;
      const body = bodyOf(yield* lastRequestTo(name));
      assert.equal(body["type"], "webhook.test");
      assert.equal(body["id"], yield* world.out.getAs("pingEventId", isString));
      assert.deepEqual(body["data"], { endpointId: (yield* endpointNamed(endpointName)).id });
    },
  );
  Then("that request verifies under the secret of {string}", function* (name: string) {
    const world = yield* World;
    const request = yield* thatRequest();
    const id = yield* run(
      WebhookSignature.verify({
        secrets: [Redacted.make((yield* endpointNamed(name)).secret)],
        headers: request.headers,
        body: request.body,
        nowSeconds: Math.floor(Number(request.headers["webhook-timestamp"])),
      }),
    );
    assert.equal(id, yield* world.out.getAs("pingEventId", isString));
  });
  Then(
    "the delivery log of {string} shows the test delivery as succeeded",
    function* (name: string) {
      const row = yield* testDeliveryOf(name);
      assert.equal(row.status, "succeeded");
      assert.equal(row.attempts, 1);
    },
  );
  Then(
    "the test delivery of {string} is dead after {int} attempt",
    function* (name: string, attempts: number) {
      const row = yield* testDeliveryOf(name);
      assert.equal(row.status, "dead");
      assert.equal(row.attempts, attempts);
    },
  );
  Then("the ping is refused as {word}", function* (tag: string) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("pingTag", isString), tag);
  });

  // ---- BEH-EA-302: audit events for mutations ----

  When(
    "the administrator updates {string} to the URL {string} and the description {string}",
    function* (name: string, url: string, description: string) {
      const endpoint = yield* endpointNamed(name);
      yield* service((webhooks) =>
        webhooks.updateEndpoint(ADMIN, endpoint.id, { url, description }),
      );
    },
  );
  When("the administrator updates the description of {string}", function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* service((webhooks) =>
      webhooks.updateEndpoint(ADMIN, endpoint.id, { description: "primary receiver" }),
    );
  });
  When("the administrator rotates the secret of {string}", function* (name: string) {
    const endpoint = yield* endpointNamed(name);
    yield* service((webhooks) => webhooks.rotateSecret(ADMIN, endpoint.id));
  });
  When("the administrator tries to delete an unknown endpoint {string}", function* (fake: string) {
    yield* service((webhooks) => Effect.result(webhooks.deleteEndpoint(ADMIN, fake)));
  });
  Then(
    "the audit log holds an {string} event for {string} naming administrator {string}",
    function* (tag: string, name: string, admin: string) {
      const endpoint = yield* endpointNamed(name);
      const rows = (yield* webhookAuditRows).filter((row) => row.eventTag === tag);
      assert.equal(rows.length, 1, `one "${tag}" event`);
      assert.deepEqual(rows[0]?.actorUserId, Option.some(admin));
      const payload = rows[0]?.payload;
      assert.ok(payload !== undefined && Reflect.get(payload, "endpointId") === endpoint.id);
    },
  );
  Then(
    "the audit log holds an {string} event for {string} naming the fields {string} and {string}",
    function* (tag: string, name: string, first: string, second: string) {
      const endpoint = yield* endpointNamed(name);
      const rows = (yield* webhookAuditRows).filter((row) => row.eventTag === tag);
      const payload = rows.at(-1)?.payload;
      assert.ok(payload !== undefined && Reflect.get(payload, "endpointId") === endpoint.id);
      const fields = Reflect.get(payload, "fields");
      assert.ok(Array.isArray(fields));
      assert.deepEqual([...fields].sort(), [first, second].sort());
    },
  );
  Then("no audit event mentions {string} or {string}", function* (first: string, second: string) {
    const dump = JSON.stringify((yield* auditRows).map((row) => row.payload));
    assert.ok(!dump.includes(first) && !dump.includes(second));
  });
  Then("the audit log holds no webhooks mutation event", function* () {
    assert.deepEqual(
      (yield* webhookAuditRows).map((row) => row.eventTag),
      [],
    );
  });

  // ---- BEH-EA-304: custom headers ----

  When(
    "the administrator registers {string} for {string} with the headers {string} holding {string} as {string}",
    function* (url: string, filter: string, header: string, value: string, name: string) {
      const world = yield* World;
      const created = yield* service((webhooks) =>
        webhooks.createEndpoint(ADMIN, { url, eventTags: [filter], headers: { [header]: value } }),
      );
      yield* world.endpoints.set(name, { id: created.endpoint.id, url, secret: created.secret });
    },
  );
  const tryRegisterWithHeader = function* (
    url: string,
    filter: string,
    header: string,
    value: string,
  ) {
    const world = yield* World;
    const outcome = yield* service((webhooks) =>
      Effect.result(
        webhooks.createEndpoint(ADMIN, { url, eventTags: [filter], headers: { [header]: value } }),
      ),
    );
    yield* world.out.set("registration", {
      tag: failureTag(outcome),
      reason:
        Result.isFailure(outcome) && outcome.failure._tag === "InvalidWebhookEndpoint"
          ? outcome.failure.reason
          : "",
    });
  };
  When(
    "the administrator tries to register {string} for {string} with the header {string} holding {string}",
    tryRegisterWithHeader,
  );
  When(
    "the administrator tries to register {string} for {string} with the header {string} holding a value split across two lines",
    function* (url: string, filter: string, header: string) {
      yield* tryRegisterWithHeader(url, filter, header, "first\r\nx-injected: 1");
    },
  );
  Then(
    "the stored headers of {string} do not contain {string}",
    function* (name: string, text: string) {
      const endpoint = yield* endpointNamed(name);
      const row = yield* run(
        Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
          records.findEndpoint(endpoint.id),
        ),
      );
      assert.ok(Option.isSome(row) && Option.isSome(row.value.headers));
      assert.ok(!row.value.headers.value.includes(text));
      assert.ok(!JSON.stringify(row.value).includes(text));
    },
  );
  Then(
    "reading endpoint {string} shows the header name {string} and never {string}",
    function* (name: string, header: string, text: string) {
      const endpoint = yield* endpointNamed(name);
      const read = yield* service((webhooks) => webhooks.getEndpoint(ADMIN, endpoint.id));
      assert.deepEqual(read.headerNames, [header]);
      assert.ok(!JSON.stringify(read).includes(text));
    },
  );
  Then(
    "the request to {string} carries the header {string} holding {string}",
    function* (name: string, header: string, value: string) {
      assert.equal((yield* lastRequestTo(name)).headers[header], value);
    },
  );

  // ---- BEH-EA-303: connection pinning ----

  Given(
    "the name {string} resolves to {string} and then to {string}",
    function* (host: string, first: string, second: string) {
      yield* (yield* app).resolver.script(host, [[first], [second]]);
    },
  );
  Then(
    "the transport was asked to connect to {string} for the host {string}",
    function* (address: string, hostname: string) {
      const requests = yield* (yield* app).receiver.transportRequests;
      const request = requests.at(-1);
      assert.ok(request !== undefined && isTransportRequest(request));
      assert.deepEqual(
        Option.map(request.pin, (pin) => [pin.address, pin.hostname]),
        Option.some([address, hostname]),
      );
    },
  );
  Then("the transport was asked to connect exactly {int} time(s)", function* (count: number) {
    assert.equal((yield* (yield* app).receiver.transportRequests).length, count);
  });
  Then("the name {string} was resolved {int} time(s)", function* (host: string, count: number) {
    assert.equal(yield* (yield* app).resolver.lookups(host), count);
  });
  Then("the transport was never asked to connect", function* () {
    assert.equal((yield* (yield* app).receiver.transportRequests).length, 0);
  });
  When(
    "a transport request for {string} is pinned to {string}",
    function* (url: string, address: string) {
      const world = yield* World;
      const options = WebhookTransport.pinnedRequestOptions({
        url,
        headers: {},
        body: "{}",
        pin: Option.some({
          hostname: new URL(url).hostname,
          address,
          family: address.includes(":") ? 6 : 4,
        }),
        allowPrivate: false,
        timeout: Duration.seconds(5),
      });
      yield* world.out.set("connectionOptions", typeof options === "string" ? options : "options");
    },
  );
  Then("the connection is refused as {word}", function* (failure: string) {
    const world = yield* World;
    assert.equal(yield* world.out.getAs("connectionOptions", isString), failure);
  });
  When(
    "a delivery for {string} is sent through the pinned transport to loopback",
    function* (name: string) {
      // A real receiver on loopback: only the pin can get the (unresolvable) registered name there.
      const world = yield* World;
      const seen: Array<string | undefined> = [];
      const server = Http.createServer((incoming, outgoing) => {
        seen.push(incoming.headers.host);
        incoming.resume();
        outgoing.writeHead(204).end();
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      ).pipe(Effect.provideService(Scope.Scope, world.scope));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const response = yield* Effect.flatMap(WebhookTransport.WebhookTransport, (transport) =>
        transport.send({
          url: `http://${name}:${port}/awthaq`,
          headers: { "content-type": "application/json" },
          body: "{}",
          pin: Option.some({ hostname: name, address: "127.0.0.1", family: 4 }),
          allowPrivate: true,
          timeout: Duration.seconds(5),
        }),
      ).pipe(Effect.provide(WebhookTransport.layerNodePinned));
      yield* world.out.set("loopbackStatus", response.status);
      yield* world.out.set("loopbackHost", seen[0] ?? "");
      yield* world.out.set("loopbackPort", String(port));
    },
  );
  Then(
    "the receiver was reached and saw the Host {string} with its port",
    function* (host: string) {
      const world = yield* World;
      assert.equal(yield* world.out.getAs("loopbackStatus", isNumber), 204);
      assert.equal(
        yield* world.out.getAs("loopbackHost", isString),
        `${host}:${yield* world.out.getAs("loopbackPort", isString)}`,
      );
    },
  );
});
