// BEH-EA-279/280 (spec/behaviors/34-webhooks.md): `WebhookRecords`, one contract suite over both layers.
// `layerSql` is migrated through the plugin's own real `migrations` (and, under `pnpm run test:pg`,
// runs on Postgres), so the unique (endpoint, event) pair is a real database constraint.
import { Migrations } from "@awthaq/core";
import { SealedColumn, TenantScoped } from "@awthaq/sql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { type Encryption, Tenant } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { EncryptionLive, relay } from "./support.ts";
import * as WebhookRecords from "../src/WebhookRecords.ts";
import * as Webhooks from "../src/Webhooks.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("webhooks_WebhookRecords");

const Migrated = Layer.effectDiscard(Migrations.run(Webhooks.Webhooks.migrations)).pipe(
  Layer.provide(SqlLive),
);

// The records layers need `Encryption` (their sealed columns); the conformance suites provide a rotatable one themselves.
const SqlNeedsEncryption = WebhookRecords.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);
const SqlLayer = SqlNeedsEncryption.pipe(Layer.provide(EncryptionLive));
const MemoryLayer = WebhookRecords.layerMemory.pipe(Layer.provide(EncryptionLive));

/** What a sealed secret holds, opened through the substrate. */
const openSecret = (sealed: SealedColumn.Sealed<string>) =>
  Effect.map(SealedColumn.orDie(sealed.open), Redacted.value);

const at = (millis: number) => DateTime.makeUnsafe(millis);

const endpointInput = (id: string, extra: { readonly tags?: ReadonlyArray<string> } = {}) => ({
  id,
  url: `https://${id}.example.com/hook`,
  description: `endpoint ${id}`,
  eventTags: extra.tags ?? ["*"],
  secret: Redacted.make(`secret-${id}`),
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

const openHeaders = (record: WebhookRecords.EndpointRecord) =>
  Option.match(record.headers, {
    onNone: () => Effect.succeed(Option.none<Readonly<Record<string, string>>>()),
    onSome: (sealed) =>
      Effect.map(SealedColumn.orDie(sealed.open), (opened) => Option.some(Redacted.value(opened))),
  });

const suite = (
  name: string,
  layer: Layer.Layer<WebhookRecords.WebhookRecords, unknown, never>,
): void => {
  describe(name, () => {
    it.effect("an endpoint round-trips, lists oldest first, and is edited in place", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        const created = yield* records.createEndpoint(
          endpointInput("a", { tags: ["auth.user.*", "auth.session.revoked"] }),
        );
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

    // BEH-EA-313: the sealed header object and its names are stored with the endpoint and replaced or cleared whole.
    it.effect(
      "custom headers round-trip, are replaced whole, cleared with null, and left alone when omitted",
      () =>
        Effect.gen(function* () {
          const records = yield* WebhookRecords.WebhookRecords;
          const created = yield* records.createEndpoint({
            ...endpointInput("h"),
            headers: { value: { authorization: "Bearer one" }, names: ["authorization"] },
          });
          assert.deepStrictEqual(
            yield* openHeaders(created),
            Option.some({ authorization: "Bearer one" }),
          );
          assert.deepStrictEqual(created.headerNames, ["authorization"]);
          const plain = yield* records.createEndpoint(endpointInput("n"));
          assert.deepStrictEqual(plain.headers, Option.none());
          assert.deepStrictEqual(plain.headerNames, []);
          const replaced = yield* records.updateEndpoint("h", {
            headers: { value: { "x-a": "1", "x-b": "2" }, names: ["x-a", "x-b"] },
          });
          assert.deepStrictEqual(
            yield* openHeaders(replaced),
            Option.some({ "x-a": "1", "x-b": "2" }),
          );
          assert.deepStrictEqual(replaced.headerNames, ["x-a", "x-b"]);
          const untouched = yield* records.updateEndpoint("h", {
            url: "https://moved.example.com/x",
          });
          assert.deepStrictEqual(
            yield* openHeaders(untouched),
            Option.some({ "x-a": "1", "x-b": "2" }),
          );
          const cleared = yield* records.updateEndpoint("h", { headers: null });
          assert.deepStrictEqual(cleared.headers, Option.none());
          assert.deepStrictEqual(cleared.headerNames, []);
        }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "secrets and the disabled flag are written whole; re-enabling resets the failure count",
      () =>
        Effect.gen(function* () {
          const records = yield* WebhookRecords.WebhookRecords;
          yield* records.createEndpoint(endpointInput("a"));
          const rotated = yield* records.setSecrets("a", {
            secret: Redacted.make("secret-new"),
            previousSecret: Redacted.make("secret-old"),
            previousSecretExpiresAt: at(5_000),
          });
          assert.strictEqual(yield* openSecret(rotated.secret), "secret-new");
          assert.strictEqual(
            yield* Effect.map(
              Option.match(rotated.previousSecret, {
                onNone: () => Effect.succeed("none"),
                onSome: openSecret,
              }),
              (value) => value,
            ),
            "secret-old",
          );
          assert.deepStrictEqual(rotated.previousSecretExpiresAt, Option.some(at(5_000)));
          const cleared = yield* records.setSecrets("a", {
            secret: Redacted.make("secret-new"),
            previousSecret: null,
            previousSecretExpiresAt: null,
          });
          assert.isTrue(Option.isNone(cleared.previousSecret));

          assert.strictEqual(yield* records.bumpDead(relay, "a"), 1);
          assert.strictEqual(yield* records.bumpDead(relay, "a"), 2);
          const off = yield* records.setDisabled("a", { at: at(2_000), reason: "failing" });
          assert.deepStrictEqual(off.disabledReason, Option.some("failing"));
          assert.strictEqual(off.consecutiveDead, 2);
          const on = yield* records.setDisabled("a", null);
          assert.isTrue(Option.isNone(on.disabledAt));
          assert.strictEqual(on.consecutiveDead, 0);
          yield* records.bumpDead(relay, "a");
          yield* records.clearDead(relay, "a");
          assert.strictEqual(
            (yield* records.findEndpoint("a")).pipe(
              Option.map((row) => row.consecutiveDead),
              Option.getOrElse(() => -1),
            ),
            0,
          );
        }).pipe(Effect.provide(layer)),
    );

    it.effect("enqueue is idempotent on (endpoint, event): a redelivered batch adds nothing", () =>
      Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.createEndpoint(endpointInput("b"));
        assert.strictEqual(
          yield* records.enqueue([newDelivery("d1", "a", "e1"), newDelivery("d2", "b", "e1")]),
          2,
        );
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

    it.effect(
      "claimDue leases: what is due is handed out once, oldest first, and skips disabled endpoints",
      () =>
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
          const first = yield* records.claimDue(relay, { now: at(2_000), limit: 10, lease });
          assert.deepStrictEqual(
            first.map((row) => row.id),
            ["d2", "d1"],
          );
          // A second worker finds nothing: the rows are leased.
          assert.deepStrictEqual(
            yield* records.claimDue(relay, { now: at(2_001), limit: 10, lease }),
            [],
          );
          // The lease lapses (a worker that died): the rows are due again.
          const again = yield* records.claimDue(relay, {
            now: at(2_000 + 60_000),
            limit: 10,
            lease,
          });
          assert.deepStrictEqual(
            again.map((row) => row.id),
            ["d1", "d2"],
          );
          // limit is honoured.
          const limited = yield* records.claimDue(relay, {
            now: at(2_000 + 200_000),
            limit: 1,
            lease,
          });
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
        yield* records.markSucceeded(relay, "ok", { at: at(2_000), statusCode: 204 });
        const ok = yield* records.findDelivery("ok");
        assert.isTrue(Option.isSome(ok));
        if (Option.isSome(ok)) {
          assert.strictEqual(ok.value.status, "succeeded");
          assert.strictEqual(ok.value.attempts, 1);
          assert.deepStrictEqual(ok.value.lastStatusCode, Option.some(204));
          assert.isTrue(Option.isSome(ok.value.completedAt));
        }

        yield* records.reschedule(relay, "retry", {
          at: at(2_000),
          nextAttemptAt: at(12_000),
          statusCode: 503,
          error: "status",
        });
        yield* records.defer(relay, "retry", at(13_000));
        const retry = yield* records.findDelivery("retry");
        if (Option.isSome(retry)) {
          assert.strictEqual(retry.value.status, "pending");
          // The deferral is not an attempt.
          assert.strictEqual(retry.value.attempts, 1);
          assert.deepStrictEqual(retry.value.nextAttemptAt, at(13_000));
          assert.deepStrictEqual(retry.value.lastError, Option.some("status"));
        }

        yield* records.markDead(relay, "dead", { at: at(3_000), error: "timeout" });
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
        yield* records.markDead(relay, "d2", { at: at(2_000), error: "status" });
        const page1 = yield* records.listDeliveries({ endpointId: "a", limit: 2 });
        assert.deepStrictEqual(
          page1.map((row) => row.id),
          ["d3", "d2"],
        );
        const page2 = yield* records.listDeliveries({ endpointId: "a", limit: 2, before: "d2" });
        assert.deepStrictEqual(
          page2.map((row) => row.id),
          ["d1"],
        );
        const dead = yield* records.listDeliveries({ endpointId: "a", status: "dead", limit: 10 });
        assert.deepStrictEqual(
          dead.map((row) => row.id),
          ["d2"],
        );
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
        yield* records.markSucceeded(relay, "old-ok", { at: at(1_000) });
        yield* records.markSucceeded(relay, "new-ok", { at: at(9_000) });
        yield* records.markDead(relay, "old-dead", { at: at(1_500) });
        assert.strictEqual(yield* records.pruneFinished(relay, at(5_000)), 2);
        assert.deepStrictEqual(
          (yield* records.listDeliveries({ endpointId: "a", limit: 10 }))
            .map((row) => row.id)
            .sort(),
          ["new-ok", "pending"],
        );
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "deleting an endpoint removes its deliveries; erasure removes a subject's rows only",
      () =>
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
            (yield* records.listBySubject(relay, "user-1")).map((row) => row.id).sort(),
            ["d1", "d2"],
          );
          yield* records.deleteBySubject(relay, "user-1");
          assert.deepStrictEqual(yield* records.listBySubject(relay, "user-1"), []);
          assert.strictEqual((yield* records.listBySubject(relay, "user-2")).length, 1);

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

suite("WebhookRecords (layerMemory)", MemoryLayer);
suite("WebhookRecords (layerSql)", SqlLayer);

// ---- BEH-EA-309 / plan 05: tenant isolation, once, by the store ------------------------------------
//
// Every records method is classified (the map is keyed by `keyof WebhookRecordsShape`, so a new method
// that is not classified does not compile). `webhooks_endpoint` is Partitioned by "tenantId";
// `webhooks_delivery` is Derived through its endpoint.

interface Row {
  readonly endpoint: string;
  readonly delivery: string;
  readonly subject: string;
  /** The tenant the row was inserted under, so a probe can observe it as its owner. */
  readonly tenant: Option.Option<string>;
}

let sequence = 0;

/** One endpoint with one pending delivery, under the ambient tenant. */
const insertRow = Effect.gen(function* () {
  const records = yield* WebhookRecords.WebhookRecords;
  sequence += 1;
  const endpoint = `iso-ep-${sequence}`;
  const delivery = `iso-d-${sequence}`;
  const subject = `iso-user-${sequence}`;
  const tenant = yield* Tenant.TenantContext;
  yield* records.createEndpoint(endpointInput(endpoint));
  yield* records.enqueue([
    newDelivery(delivery, endpoint, `iso-e-${sequence}`, at(1_000), subject),
  ]);
  return { endpoint, delivery, subject, tenant } satisfies Row;
});

/** Observes a row as its owner, whatever tenant the probe itself runs under. */
const asOwner = <A, E, R>(row: Row, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Tenant.TenantContext, row.tenant);

const witness = TenantScoped.crossTenant("webhooks isolation suite: relay and worker methods");

const found = <A, E, R>(effect: Effect.Effect<A, E | WebhookRecords.WebhookRecordNotFound, R>) =>
  effect.pipe(
    Effect.as(true),
    Effect.catchTag("WebhookRecordNotFound", () => Effect.succeed(false)),
  );

const withRecords = <A, E>(
  use: (records: WebhookRecords.WebhookRecordsShape) => Effect.Effect<A, E>,
) => Effect.flatMap(WebhookRecords.WebhookRecords, use);

const endpointOf = (row: Row) =>
  asOwner(
    row,
    withRecords((records) => records.findEndpoint(row.endpoint)),
  ).pipe(Effect.map(Option.getOrThrow));
const deliveryOf = (row: Row) =>
  asOwner(
    row,
    withRecords((records) => records.findDelivery(row.delivery)),
  ).pipe(Effect.map(Option.getOrThrow));

const otherTable = (table: string) => ({
  derived: `this method operates on ${table}; its case is classified there`,
});

const endpointMethods: TestAuth.TableCase<
  WebhookRecords.WebhookRecordsShape,
  Row,
  WebhookRecords.WebhookRecords
>["methods"] = {
  createEndpoint: { insert: true },
  enqueue: { insert: true },
  findEndpoint: {
    scoped: {
      run: (row) =>
        withRecords((r) => r.findEndpoint(row.endpoint)).pipe(Effect.map(Option.isSome)),
    },
  },
  listEndpoints: {
    scoped: {
      run: (row) =>
        withRecords((r) => r.listEndpoints).pipe(
          Effect.map((rows) => rows.some((endpoint) => endpoint.id === row.endpoint)),
        ),
    },
  },
  updateEndpoint: {
    scoped: {
      run: (row) =>
        found(
          withRecords((r) =>
            r.updateEndpoint(row.endpoint, { url: "https://moved.example.com/x" }),
          ),
        ),
    },
  },
  setSecrets: {
    scoped: {
      run: (row) =>
        found(
          withRecords((r) =>
            r.setSecrets(row.endpoint, {
              secret: Redacted.make("s"),
              previousSecret: null,
              previousSecretExpiresAt: null,
            }),
          ),
        ),
    },
  },
  setDisabled: {
    scoped: { run: (row) => found(withRecords((r) => r.setDisabled(row.endpoint, null))) },
  },
  deleteEndpoint: {
    scoped: { run: (row) => found(withRecords((r) => r.deleteEndpoint(row.endpoint))) },
  },
  listEnabledEndpoints: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.listEnabledEndpoints(witness)).pipe(
          Effect.map((rows) => rows.some((endpoint) => endpoint.id === row.endpoint)),
        ),
    },
  },
  findEndpointForDelivery: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.findEndpointForDelivery(witness, row.endpoint)).pipe(
          Effect.map(Option.isSome),
        ),
    },
  },
  disableFailing: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.disableFailing(witness, row.endpoint, at(5_000))).pipe(
          Effect.andThen(endpointOf(row)),
          Effect.map((endpoint) => Option.isSome(endpoint.disabledAt)),
        ),
    },
  },
  bumpDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.bumpDead(witness, row.endpoint)).pipe(Effect.map((n) => n > 0)),
    },
  },
  clearDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.bumpDead(witness, row.endpoint)).pipe(
          Effect.andThen(withRecords((r) => r.clearDead(witness, row.endpoint))),
          Effect.andThen(endpointOf(row)),
          Effect.map((endpoint) => endpoint.consecutiveDead === 0),
        ),
    },
  },
  claimDue: otherTable("webhooks_delivery"),
  findDelivery: otherTable("webhooks_delivery"),
  markSucceeded: otherTable("webhooks_delivery"),
  reschedule: otherTable("webhooks_delivery"),
  defer: otherTable("webhooks_delivery"),
  markDead: otherTable("webhooks_delivery"),
  redrive: otherTable("webhooks_delivery"),
  listDeliveries: otherTable("webhooks_delivery"),
  pruneFinished: otherTable("webhooks_delivery"),
  deleteBySubject: otherTable("webhooks_delivery"),
  listBySubject: otherTable("webhooks_delivery"),
};

const deliveryMethods: TestAuth.TableCase<
  WebhookRecords.WebhookRecordsShape,
  Row,
  WebhookRecords.WebhookRecords
>["methods"] = {
  createEndpoint: { insert: true },
  enqueue: { insert: true },
  findEndpoint: otherTable("webhooks_endpoint"),
  listEndpoints: otherTable("webhooks_endpoint"),
  updateEndpoint: otherTable("webhooks_endpoint"),
  setSecrets: otherTable("webhooks_endpoint"),
  setDisabled: otherTable("webhooks_endpoint"),
  deleteEndpoint: otherTable("webhooks_endpoint"),
  listEnabledEndpoints: otherTable("webhooks_endpoint"),
  findEndpointForDelivery: otherTable("webhooks_endpoint"),
  disableFailing: otherTable("webhooks_endpoint"),
  bumpDead: otherTable("webhooks_endpoint"),
  clearDead: otherTable("webhooks_endpoint"),
  // Derived through the endpoint: the join confines them to the ambient tenant.
  findDelivery: {
    scoped: {
      run: (row) =>
        withRecords((r) => r.findDelivery(row.delivery)).pipe(Effect.map(Option.isSome)),
    },
  },
  listDeliveries: {
    scoped: {
      run: (row) =>
        withRecords((r) => r.listDeliveries({ endpointId: row.endpoint, limit: 10 })).pipe(
          Effect.map((rows) => rows.length > 0),
        ),
    },
  },
  redrive: {
    scoped: {
      run: (row) =>
        // Only a dead delivery can be redriven, so the probe kills it first (as the worker would).
        withRecords((r) =>
          r.markDead(witness, row.delivery, { at: at(2_000), error: "status" }),
        ).pipe(Effect.andThen(found(withRecords((r) => r.redrive(row.delivery, at(3_000)))))),
    },
  },
  claimDue: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.claimDue(witness, { now: at(10_000), limit: 100, lease: Duration.seconds(60) }),
        ).pipe(Effect.map((rows) => rows.some((delivery) => delivery.id === row.delivery))),
    },
  },
  markSucceeded: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.markSucceeded(witness, row.delivery, { at: at(2_000), statusCode: 204 }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((delivery) => delivery.status === "succeeded"),
        ),
    },
  },
  reschedule: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.reschedule(witness, row.delivery, {
            at: at(2_000),
            nextAttemptAt: at(9_000),
            error: "status",
          }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((delivery) => delivery.attempts === 1),
        ),
    },
  },
  defer: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.defer(witness, row.delivery, at(7_000))).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((delivery) => DateTime.toEpochMillis(delivery.nextAttemptAt) === 7_000),
        ),
    },
  },
  markDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.markDead(witness, row.delivery, { at: at(2_000), error: "status" }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((delivery) => delivery.status === "dead"),
        ),
    },
  },
  pruneFinished: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.markSucceeded(witness, row.delivery, { at: at(1_000) })).pipe(
          Effect.andThen(withRecords((r) => r.pruneFinished(witness, at(5_000)))),
          Effect.map((pruned) => pruned >= 1),
        ),
    },
  },
  listBySubject: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.listBySubject(witness, row.subject)).pipe(
          Effect.map((rows) => rows.some((delivery) => delivery.id === row.delivery)),
        ),
    },
  },
  deleteBySubject: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.deleteBySubject(witness, row.subject)).pipe(
          Effect.andThen(
            asOwner(
              row,
              withRecords((r) => r.findDelivery(row.delivery)),
            ),
          ),
          Effect.map(Option.isNone),
        ),
    },
  },
};

const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => {
    throw new Error(message);
  },
};

TestAuth.runTenantIsolationTests(vitestFramework, {
  plugin: Webhooks.Webhooks,
  adapters: [
    { name: "layerMemory", layer: MemoryLayer },
    { name: "layerSql", layer: SqlLayer },
  ],
  cases: [
    { table: "webhooks_endpoint", insert: insertRow, methods: endpointMethods },
    { table: "webhooks_delivery", insert: insertRow, methods: deliveryMethods },
  ],
  rls: { layer: SqlLayer },
});

// ---- the three sealed columns: the substrate's wiring suite over both adapters --------------------------------

type SealedField = "secret" | "previousSecret" | "headers";

const sampleEndpoint = (id: string) => ({
  id,
  url: `https://${id}.example.com/hook`,
  eventTags: ["*"],
  createdBy: "admin-1",
});

const storedEndpoint = (id: string) =>
  Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    Effect.map(records.findEndpoint(id), Option.getOrThrow),
  );
const secretOf = (id: string) => Effect.map(storedEndpoint(id), (endpoint) => endpoint.secret);
const previousSecretOf = (id: string) =>
  Effect.map(storedEndpoint(id), (endpoint) => Option.getOrThrow(endpoint.previousSecret));
const headersOf = (id: string) =>
  Effect.map(storedEndpoint(id), (endpoint) => Option.getOrThrow(endpoint.headers));

/** One records adapter's storage: how the suite looks at, and plants, what is at rest. */
type Storage<R> = {
  readonly name: string;
  readonly layer: Layer.Layer<R, unknown, Encryption.Encryption>;
  readonly raw: (id: string, column: SealedField) => Effect.Effect<string, unknown, R>;
  readonly plant: (
    id: string,
    column: SealedField,
    stored: string,
  ) => Effect.Effect<void, unknown, R>;
};

const memoryStorage: Storage<WebhookRecords.WebhookRecords | WebhookRecords.MemoryEnvelopes> = {
  name: "layerMemory",
  layer: WebhookRecords.layerMemory,
  raw: (id, column) =>
    Effect.flatMap(WebhookRecords.MemoryEnvelopes, (rows) => rows.stored(id, column)),
  plant: (id, column, stored) =>
    Effect.flatMap(WebhookRecords.MemoryEnvelopes, (rows) => rows.plant(id, column, stored)),
};

const sqlStorage: Storage<WebhookRecords.WebhookRecords | SqlClient.SqlClient> = {
  name: "layerSql",
  layer: SqlNeedsEncryption,
  raw: (id, column) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly value: string;
      }>`SELECT ${sql(column)} AS value FROM webhooks_endpoint WHERE id = ${id}`;
      return rows[0]?.value ?? "";
    }),
  plant: (id, column, stored) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE webhooks_endpoint SET ${sql(column)} = ${stored} WHERE id = ${id}`;
    }),
};

const sealedSuites = <Extra>(storage: Storage<WebhookRecords.WebhookRecords | Extra>) => {
  const forColumn = <A>(
    column: SealedColumn.Column<A>,
    field: SealedField,
    sample: A,
    write: (id: string, value: A) => Effect.Effect<unknown, unknown, WebhookRecords.WebhookRecords>,
    read: (
      id: string,
    ) => Effect.Effect<SealedColumn.Sealed<A>, unknown, WebhookRecords.WebhookRecords>,
  ) =>
    TestAuth.runSealedColumnTests<A, WebhookRecords.WebhookRecords | Extra>(vitestFramework, {
      column,
      sample,
      adapters: [
        {
          name: storage.name,
          layer: storage.layer,
          raw: (id) => storage.raw(id, field),
          plant: (id, stored) => storage.plant(id, field, stored),
        },
      ],
      write: (id, value) => Effect.asVoid(write(id, value)),
      read,
    });
  forColumn(
    WebhookRecords.secretColumn,
    "secret",
    "whsec_sample",
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        records.createEndpoint({ ...sampleEndpoint(id), secret: Redacted.make(value) }),
      ),
    secretOf,
  );
  forColumn(
    WebhookRecords.previousSecretColumn,
    "previousSecret",
    "whsec_previous",
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        Effect.andThen(
          records.createEndpoint({ ...sampleEndpoint(id), secret: Redacted.make("whsec_current") }),
          records.setSecrets(id, {
            secret: Redacted.make("whsec_current"),
            previousSecret: Redacted.make(value),
            previousSecretExpiresAt: at(5_000),
          }),
        ),
      ),
    previousSecretOf,
  );
  forColumn(
    WebhookRecords.headersColumn,
    "headers",
    { authorization: "Bearer very-secret-token" },
    (id, value) =>
      Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
        records.createEndpoint({
          ...sampleEndpoint(id),
          secret: Redacted.make("whsec_current"),
          headers: { value, names: Object.keys(value) },
        }),
      ),
    headersOf,
  );
};

sealedSuites(memoryStorage);
sealedSuites(sqlStorage);
