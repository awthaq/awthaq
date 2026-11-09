// Plan 25 ticket 16 (ADR-EA-041 decision 9): `WebhookRecords`' contract, run on memory and SQL (Postgres under
// `pnpm test:pg`) from `Contract.test.ts`. BEH-EA-281: `maxEndpoints` (`createEndpoint`'s `within`) is decided with
// the insert, per tenant. Plan 24 C8: an administrator's edit and the worker's failure count are single-statement
// writes of their own columns, so neither loses the other's. C9: an endpoint and its delivery log go together, and an
// `enqueue` racing the endpoint's delete never leaves a delivery whose endpoint is gone (plan 25 Wave F's open gap).
import { Tenant } from "@awthaq/ports";
import { TenantScoped } from "@awthaq/sql";
import { RecordsContract, type TestAuth, TestSql } from "@awthaq/test";
import { assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { SealedColumn } from "@awthaq/sql";
import * as WebhookRecords from "../../src/WebhookRecords.ts";

/** The witness a case presents where the relay or the worker would. */
const relay = TenantScoped.crossTenant("webhooks contract: the relay serves every tenant");

/**
 * Racing fibers yield to the scheduler every few steps, so they interleave between the statements of one write.
 * (Effect 4.1.2 stalls with a budget below 4.)
 */
const fineGrained = Effect.provideService(Scheduler.MaxOpsBeforeYield, 4);

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** Two `createdAt`s that sort (the cases run under a `TestClock`). */
const tick = TestClock.adjust(Duration.millis(5));

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

/** What a sealed secret holds, opened through the substrate. */
const openSecret = (sealed: SealedColumn.Sealed<string>) =>
  Effect.map(SealedColumn.orDie(sealed.open), Redacted.value);

const openHeaders = (record: WebhookRecords.EndpointRecord) =>
  Option.match(record.headers, {
    onNone: () => Effect.succeed(Option.none<Readonly<Record<string, string>>>()),
    onSome: (sealed) =>
      Effect.map(SealedColumn.orDie(sealed.open), (opened) => Option.some(Redacted.value(opened))),
  });

const endpoint = (id: string) =>
  Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    Effect.map(records.findEndpoint(id), Option.getOrThrow),
  );

const delivery = (id: string) =>
  Effect.flatMap(WebhookRecords.WebhookRecords, (records) =>
    Effect.map(records.findDelivery(id), Option.getOrThrow),
  );

/** Races `writers` and returns every outcome. */
const raced = <A, E, R>(writers: ReadonlyArray<Effect.Effect<A, E, R>>) =>
  Effect.all(
    writers.map((writer) => Effect.exit(writer)),
    { concurrency: "unbounded" },
  ).pipe(fineGrained);

const many = <A>(make: (n: number) => A) =>
  Array.from({ length: RecordsContract.CONCURRENCY }, (_, n) => make(n));

/** Runs `self` after `3n` scheduler yields, so the n-th of several racing writers starts later than the one before. */
const staggered =
  (n: number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.andThen(
      Effect.forEach(Array.from({ length: 3 * n }), () => Effect.yieldNow, { discard: true }),
      self,
    );

// ---- BEH-EA-309 / plan 05: tenant isolation, once, by the store ------------------------------------
//
// `webhooks_endpoint` is Partitioned by "tenantId"; `webhooks_delivery` is Derived through its endpoint.

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
  const endpointId = `iso-ep-${sequence}`;
  const deliveryId = `iso-d-${sequence}`;
  const subject = `iso-user-${sequence}`;
  const tenant = yield* Tenant.TenantContext;
  yield* records.createEndpoint(endpointInput(endpointId));
  yield* records.enqueue([
    newDelivery(deliveryId, endpointId, `iso-e-${sequence}`, at(1_000), subject),
  ]);
  return { endpoint: endpointId, delivery: deliveryId, subject, tenant } satisfies Row;
});

/** Observes a row as its owner, whatever tenant the probe itself runs under. */
const asOwner = <A, E, R>(row: Row, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Tenant.TenantContext, row.tenant);

const found = <A, E, R>(effect: Effect.Effect<A, E | WebhookRecords.WebhookRecordNotFound, R>) =>
  effect.pipe(
    Effect.as(true),
    Effect.catchTag("WebhookRecordNotFound", () => Effect.succeed(false)),
  );

const withRecords = <A, E>(
  use: (records: WebhookRecords.WebhookRecordsShape) => Effect.Effect<A, E>,
) => Effect.flatMap(WebhookRecords.WebhookRecords, use);

const endpointOf = (row: Row) => asOwner(row, endpoint(row.endpoint));
const deliveryOf = (row: Row) => asOwner(row, delivery(row.delivery));

const otherTable = (table: string) => ({
  derived: `this method operates on ${table}; its case is classified there`,
});

type Methods = TestAuth.TableCase<
  WebhookRecords.WebhookRecordsShape,
  Row,
  WebhookRecords.WebhookRecords
>["methods"];

const endpointMethods: Methods = {
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
          Effect.map((rows) => rows.some((candidate) => candidate.id === row.endpoint)),
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
        withRecords((r) => r.listEnabledEndpoints(relay)).pipe(
          Effect.map((rows) => rows.some((candidate) => candidate.id === row.endpoint)),
        ),
    },
  },
  findEndpointForDelivery: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.findEndpointForDelivery(relay, row.endpoint)).pipe(
          Effect.map(Option.isSome),
        ),
    },
  },
  disableFailing: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.disableFailing(relay, row.endpoint, at(5_000))).pipe(
          Effect.andThen(endpointOf(row)),
          Effect.map((stored) => Option.isSome(stored.disabledAt)),
        ),
    },
  },
  bumpDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.bumpDead(relay, row.endpoint)).pipe(Effect.map((n) => n > 0)),
    },
  },
  clearDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.bumpDead(relay, row.endpoint)).pipe(
          Effect.andThen(withRecords((r) => r.clearDead(relay, row.endpoint))),
          Effect.andThen(endpointOf(row)),
          Effect.map((stored) => stored.consecutiveDead === 0),
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

const deliveryMethods: Methods = {
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
          r.markDead(relay, row.delivery, { at: at(2_000), error: "status" }),
        ).pipe(Effect.andThen(found(withRecords((r) => r.redrive(row.delivery, at(3_000)))))),
    },
  },
  claimDue: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.claimDue(relay, { now: at(10_000), limit: 100, lease: Duration.seconds(60) }),
        ).pipe(Effect.map((rows) => rows.some((candidate) => candidate.id === row.delivery))),
    },
  },
  markSucceeded: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.markSucceeded(relay, row.delivery, { at: at(2_000), statusCode: 204 }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((stored) => stored.status === "succeeded"),
        ),
    },
  },
  reschedule: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.reschedule(relay, row.delivery, {
            at: at(2_000),
            nextAttemptAt: at(9_000),
            error: "status",
          }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((stored) => stored.attempts === 1),
        ),
    },
  },
  defer: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.defer(relay, row.delivery, at(7_000))).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((stored) => DateTime.toEpochMillis(stored.nextAttemptAt) === 7_000),
        ),
    },
  },
  markDead: {
    crossTenant: {
      run: (row) =>
        withRecords((r) =>
          r.markDead(relay, row.delivery, { at: at(2_000), error: "status" }),
        ).pipe(
          Effect.andThen(deliveryOf(row)),
          Effect.map((stored) => stored.status === "dead"),
        ),
    },
  },
  pruneFinished: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.markSucceeded(relay, row.delivery, { at: at(1_000) })).pipe(
          Effect.andThen(withRecords((r) => r.pruneFinished(relay, at(5_000)))),
          Effect.map((pruned) => pruned >= 1),
        ),
    },
  },
  listBySubject: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.listBySubject(relay, row.subject)).pipe(
          Effect.map((rows) => rows.some((candidate) => candidate.id === row.delivery)),
        ),
    },
  },
  deleteBySubject: {
    crossTenant: {
      run: (row) =>
        withRecords((r) => r.deleteBySubject(relay, row.subject)).pipe(
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

export const webhookRecords = RecordsContract.suite(WebhookRecords.WebhookRecords, {
  operations: {
    createEndpoint: {
      atomic: [
        {
          name: "an endpoint round-trips, stamped with the ambient tenant",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            const created = yield* records.createEndpoint(
              endpointInput("a", { tags: ["auth.user.*", "auth.session.revoked"] }),
            );
            assert.deepStrictEqual(created.eventTags, ["auth.user.*", "auth.session.revoked"]);
            assert.deepStrictEqual(created.description, Option.some("endpoint a"));
            assert.isTrue(Option.isNone(created.disabledAt));
            assert.isTrue(Option.isNone(created.tenantId));
            assert.strictEqual(yield* openSecret(created.secret), "secret-a");
            const tenanted = yield* records
              .createEndpoint(endpointInput("t"))
              .pipe(Tenant.withTenant("org-a"));
            assert.deepStrictEqual(tenanted.tenantId, Option.some("org-a"));
          }),
        },
        {
          name: "BEH-EA-313: custom headers are sealed with the endpoint, and absent when none are given",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "BEH-EA-281: within refuses at the limit, counted per tenant",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"), { within: 2 });
            yield* records.createEndpoint(endpointInput("b"), { within: 2 });
            const over = yield* records
              .createEndpoint(endpointInput("c"), { within: 2 })
              .pipe(Effect.flip);
            assert.strictEqual(over._tag, "WebhookRecords/LimitReached");
            assert.deepStrictEqual(
              over,
              new WebhookRecords.WebhookRecordLimitReached({ limit: 2 }),
            );
            // Another tenant's endpoints do not count, and the platform's do not count for it.
            yield* records
              .createEndpoint(endpointInput("org-a-1"), { within: 1 })
              .pipe(Tenant.withTenant("org-a"));
            const tenantOver = yield* records
              .createEndpoint(endpointInput("org-a-2"), { within: 1 })
              .pipe(Tenant.withTenant("org-a"), Effect.flip);
            assert.strictEqual(tenantOver._tag, "WebhookRecords/LimitReached");
            // Without within there is no bound.
            yield* records.createEndpoint(endpointInput("d"));
            assert.strictEqual((yield* records.listEndpoints).length, 3);
          }),
        },
      ],
      race: [
        {
          name: "8 creates at maxEndpoints - 1 store one",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("first"));
            yield* records.createEndpoint(endpointInput("second"));
            const outcomes = yield* raced(
              many((n) => records.createEndpoint(endpointInput(`racing-${n}`), { within: 3 })),
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.strictEqual((yield* records.listEndpoints).length, 3);
          }),
        },
        {
          name: "8 creates in two tenants at within 1 store one each",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            const outcomes = yield* raced(
              many((n) =>
                records
                  .createEndpoint(endpointInput(`tenant-${n}`), { within: 1 })
                  .pipe(Tenant.withTenant(n % 2 === 0 ? "org-a" : "org-b")),
              ),
            );
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 2);
            for (const tenant of ["org-a", "org-b"]) {
              assert.strictEqual(
                (yield* records.listEndpoints.pipe(Tenant.withTenant(tenant))).length,
                1,
              );
            }
          }),
        },
      ],
    },
    findEndpoint: {
      read: [
        {
          name: "None for an unknown id and for another tenant's endpoint",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            assert.isTrue(Option.isNone(yield* records.findEndpoint("nope")));
            yield* records.createEndpoint(endpointInput("a")).pipe(Tenant.withTenant("org-a"));
            assert.isTrue(Option.isNone(yield* records.findEndpoint("a")));
            assert.isTrue(
              Option.isSome(yield* records.findEndpoint("a").pipe(Tenant.withTenant("org-a"))),
            );
          }),
        },
      ],
    },
    listEndpoints: {
      read: [
        {
          name: "the ambient tenant's endpoints, oldest first",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* tick;
            yield* records.createEndpoint(endpointInput("b"));
            yield* records.createEndpoint(endpointInput("other")).pipe(Tenant.withTenant("org-a"));
            assert.deepStrictEqual(
              (yield* records.listEndpoints).map((row) => row.id),
              ["a", "b"],
            );
          }),
        },
      ],
    },
    listEnabledEndpoints: {
      read: [
        {
          name: "every tenant's enabled endpoints, oldest first",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* tick;
            yield* records.createEndpoint(endpointInput("b")).pipe(Tenant.withTenant("org-a"));
            yield* tick;
            yield* records.createEndpoint(endpointInput("off"));
            yield* records.setDisabled("off", { at: at(0), reason: "manual" });
            assert.deepStrictEqual(
              (yield* records.listEnabledEndpoints(relay)).map((row) => row.id),
              ["a", "b"],
            );
          }),
        },
      ],
    },
    findEndpointForDelivery: {
      read: [
        {
          name: "any tenant's endpoint by id, None for an unknown one",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a")).pipe(Tenant.withTenant("org-a"));
            assert.isTrue(Option.isSome(yield* records.findEndpointForDelivery(relay, "a")));
            assert.isTrue(Option.isNone(yield* records.findEndpointForDelivery(relay, "nope")));
          }),
        },
      ],
    },
    updateEndpoint: {
      atomic: [
        {
          name: "edits in place; fields left out are untouched; an unknown id is not found",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const edited = yield* records.updateEndpoint("a", {
              url: "https://moved.example.com/hook",
              description: null,
              eventTags: ["*"],
            });
            assert.strictEqual(edited.url, "https://moved.example.com/hook");
            assert.isTrue(Option.isNone(edited.description));
            assert.deepStrictEqual(edited.eventTags, ["*"]);
            const untouched = yield* records.updateEndpoint("a", {});
            assert.strictEqual(untouched.url, "https://moved.example.com/hook");
            assert.strictEqual(yield* openSecret(untouched.secret), "secret-a");
            const missing = yield* records.updateEndpoint("nope", {}).pipe(Effect.flip);
            assert.strictEqual(missing._tag, "WebhookRecordNotFound");
          }),
        },
        {
          name: "BEH-EA-313: custom headers are replaced whole, cleared with null, and left alone when omitted",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint({
              ...endpointInput("h"),
              headers: { value: { authorization: "Bearer one" }, names: ["authorization"] },
            });
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
          }),
        },
      ],
      race: [
        {
          name: "admin PATCH racing bumpDead keeps both: patches of different fields and every bump survive",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const urls = many((n) => `https://moved-${n}.example.com/hook`);
            const descriptions = many((n) => `described ${n}`);
            yield* raced([
              ...many((n) =>
                Effect.asVoid(
                  n % 2 === 0
                    ? records.updateEndpoint("a", { url: urls[n] })
                    : records.updateEndpoint("a", { description: descriptions[n] }),
                ),
              ),
              ...many(() => Effect.asVoid(records.bumpDead(relay, "a"))),
            ]);
            const stored = yield* endpoint("a");
            assert.strictEqual(stored.consecutiveDead, RecordsContract.CONCURRENCY);
            assert.include(
              urls.filter((_, n) => n % 2 === 0),
              stored.url,
            );
            assert.include(
              descriptions.filter((_, n) => n % 2 === 1),
              Option.getOrElse(stored.description, () => "none"),
            );
          }),
        },
      ],
    },
    setSecrets: {
      write: [
        {
          name: "the secret and the previous one are written whole, and cleared with null",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const rotated = yield* records.setSecrets("a", {
              secret: Redacted.make("secret-new"),
              previousSecret: Redacted.make("secret-old"),
              previousSecretExpiresAt: at(5_000),
            });
            assert.strictEqual(yield* openSecret(rotated.secret), "secret-new");
            assert.strictEqual(
              yield* Option.match(rotated.previousSecret, {
                onNone: () => Effect.succeed("none"),
                onSome: openSecret,
              }),
              "secret-old",
            );
            assert.deepStrictEqual(rotated.previousSecretExpiresAt, Option.some(at(5_000)));
            const cleared = yield* records.setSecrets("a", {
              secret: Redacted.make("secret-new"),
              previousSecret: null,
              previousSecretExpiresAt: null,
            });
            assert.isTrue(Option.isNone(cleared.previousSecret));
            assert.isTrue(Option.isNone(cleared.previousSecretExpiresAt));
            const missing = yield* records
              .setSecrets("nope", {
                secret: Redacted.make("s"),
                previousSecret: null,
                previousSecretExpiresAt: null,
              })
              .pipe(Effect.flip);
            assert.strictEqual(missing._tag, "WebhookRecordNotFound");
          }),
        },
      ],
    },
    setDisabled: {
      atomic: [
        {
          name: "disabling keeps the failure count; re-enabling resets it; an unknown id is not found",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.bumpDead(relay, "a");
            yield* records.bumpDead(relay, "a");
            const off = yield* records.setDisabled("a", { at: at(2_000), reason: "failing" });
            assert.deepStrictEqual(off.disabledAt, Option.some(at(2_000)));
            assert.deepStrictEqual(off.disabledReason, Option.some("failing"));
            assert.strictEqual(off.consecutiveDead, 2);
            const on = yield* records.setDisabled("a", null);
            assert.isTrue(Option.isNone(on.disabledAt));
            assert.isTrue(Option.isNone(on.disabledReason));
            assert.strictEqual(on.consecutiveDead, 0);
            const missing = yield* records.setDisabled("nope", null).pipe(Effect.flip);
            assert.strictEqual(missing._tag, "WebhookRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "an administrator disabling racing 8 bumpDead keeps every bump",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* raced([
              ...many(() => Effect.asVoid(records.bumpDead(relay, "a"))),
              Effect.asVoid(records.setDisabled("a", { at: at(2_000), reason: "manual" })),
            ]);
            const stored = yield* endpoint("a");
            assert.strictEqual(stored.consecutiveDead, RecordsContract.CONCURRENCY);
            assert.deepStrictEqual(stored.disabledReason, Option.some("manual"));
          }),
        },
      ],
    },
    disableFailing: {
      write: [
        {
          name: "switches any tenant's endpoint off as failing; an unknown id is a no-op",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a")).pipe(Tenant.withTenant("org-a"));
            yield* records.disableFailing(relay, "a", at(3_000));
            yield* records.disableFailing(relay, "nope", at(3_000));
            const stored = yield* endpoint("a").pipe(Tenant.withTenant("org-a"));
            assert.deepStrictEqual(stored.disabledAt, Option.some(at(3_000)));
            assert.deepStrictEqual(stored.disabledReason, Option.some("failing"));
          }),
        },
      ],
    },
    bumpDead: {
      atomic: [
        {
          name: "adds one and answers the new count; an unknown id answers 0",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            assert.strictEqual(yield* records.bumpDead(relay, "a"), 1);
            assert.strictEqual(yield* records.bumpDead(relay, "a"), 2);
            assert.strictEqual(yield* records.bumpDead(relay, "nope"), 0);
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent bumps count 8, each answering a distinct count",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const counts = yield* Effect.all(
              many(() => records.bumpDead(relay, "a")),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            assert.deepStrictEqual(
              [...counts].sort((x, y) => x - y),
              many((n) => n + 1),
            );
            assert.strictEqual((yield* endpoint("a")).consecutiveDead, RecordsContract.CONCURRENCY);
          }),
        },
      ],
    },
    clearDead: {
      write: [
        {
          name: "resets the failure count",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.bumpDead(relay, "a");
            yield* records.clearDead(relay, "a");
            assert.strictEqual((yield* endpoint("a")).consecutiveDead, 0);
          }),
        },
      ],
    },
    deleteEndpoint: {
      atomic: [
        {
          name: "removes the endpoint and its deliveries; a second delete is not found",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.createEndpoint(endpointInput("b"));
            yield* records.enqueue([newDelivery("d1", "a", "e1"), newDelivery("d2", "b", "e1")]);
            yield* records.deleteEndpoint("b");
            assert.deepStrictEqual(
              yield* records.listDeliveries({ endpointId: "b", limit: 10 }),
              [],
            );
            assert.isTrue(Option.isNone(yield* records.findEndpoint("b")));
            assert.isTrue(Option.isNone(yield* records.findDelivery("d2")));
            assert.isTrue(Option.isSome(yield* records.findDelivery("d1")));
            const again = yield* records.deleteEndpoint("b").pipe(Effect.flip);
            assert.strictEqual(again._tag, "WebhookRecordNotFound");
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent deletes: one removes it, the rest are not found, no delivery is left",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([
              newDelivery("d1", "a", "e1", at(1_000), "user-1"),
              newDelivery("d2", "a", "e2", at(1_000), "user-1"),
            ]);
            const outcomes = yield* raced(many(() => records.deleteEndpoint("a")));
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.isTrue(Option.isNone(yield* records.findEndpoint("a")));
            assert.deepStrictEqual(yield* records.listBySubject(relay, "user-1"), []);
          }),
        },
        {
          name: "bumpDead and an administrator's edit racing the delete never fail it or resurrect the endpoint",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("d1", "a", "e1")]);
            const outcomes = yield* raced([
              Effect.asVoid(records.deleteEndpoint("a")),
              ...many((n) =>
                n % 2 === 0
                  ? Effect.asVoid(records.bumpDead(relay, "a"))
                  : Effect.asVoid(
                      records.updateEndpoint("a", { url: `https://x${n}.example.com/` }),
                    ),
              ),
            ]);
            assert.strictEqual(outcomes[0]?._tag, "Success");
            assert.isTrue(Option.isNone(yield* records.findEndpoint("a")));
            assert.isTrue(Option.isNone(yield* records.findEndpointForDelivery(relay, "a")));
          }),
        },
      ],
    },
    enqueue: {
      atomic: [
        {
          name: "idempotent on (endpoint, event): a redelivered batch adds nothing",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "a row whose endpoint is gone is not stored (the relay listed it before the delete)",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.createEndpoint(endpointInput("b"));
            yield* records.deleteEndpoint("b");
            assert.strictEqual(
              yield* records.enqueue([
                newDelivery("d1", "a", "e1", at(1_000), "user-1"),
                newDelivery("d2", "b", "e1", at(1_000), "user-1"),
                newDelivery("d3", "nope", "e1", at(1_000), "user-1"),
              ]),
              1,
            );
            assert.deepStrictEqual(
              (yield* records.listBySubject(relay, "user-1")).map((row) => row.id),
              ["d1"],
            );
          }),
        },
      ],
      race: [
        {
          name: "enqueues racing the endpoint's delete leave no delivery whose endpoint is gone",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const outcomes = yield* raced([
              Effect.asVoid(records.deleteEndpoint("a")),
              // Staggered, so the relays' writes land before, during and after the delete.
              ...many((n) =>
                Effect.asVoid(
                  records.enqueue([newDelivery(`d${n}`, "a", `e${n}`, at(1_000), "user-1")]),
                ).pipe(staggered(n)),
              ),
            ]);
            assert.isTrue(outcomes.every((exit) => exit._tag === "Success"));
            assert.isTrue(Option.isNone(yield* records.findEndpoint("a")));
            assert.deepStrictEqual(yield* records.listBySubject(relay, "user-1"), []);
          }),
        },
        {
          name: "8 relays enqueueing the same event store it once",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            const added = yield* Effect.all(
              many((n) => records.enqueue([newDelivery(`d${n}`, "a", "e1")])),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            assert.strictEqual(
              added.reduce((sum, n) => sum + n, 0),
              1,
            );
            assert.strictEqual(
              (yield* records.listDeliveries({ endpointId: "a", limit: 10 })).length,
              1,
            );
          }),
        },
      ],
    },
    claimDue: {
      atomic: [
        {
          name: "leases: what is due is handed out once, oldest first, skipping disabled endpoints",
          run: Effect.gen(function* () {
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
          }),
        },
        {
          name: "plan 24 W-1: a claimed row is handed out as leased (nextAttemptAt is the lease's end)",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("d1", "a", "e1", at(1_000))]);
            const [claimed] = yield* records.claimDue(relay, {
              now: at(2_000),
              limit: 10,
              lease: Duration.seconds(60),
            });
            assert.deepStrictEqual(claimed?.nextAttemptAt, at(62_000));
            assert.deepStrictEqual((yield* delivery("d1")).nextAttemptAt, at(62_000));
          }),
        },
      ],
      race: [
        {
          name: "8 workers claiming at once never hand a due row out twice",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue(many((n) => newDelivery(`d${n}`, "a", `e${n}`, at(1_000 + n))));
            const claims = yield* Effect.all(
              many(() =>
                records.claimDue(relay, { now: at(5_000), limit: 3, lease: Duration.seconds(60) }),
              ),
              { concurrency: "unbounded" },
            ).pipe(fineGrained);
            // A worker that loses every row it picked hands out nothing this round; none is handed out twice.
            const ids = claims.flat().map((row) => row.id);
            assert.isAtLeast(ids.length, 3);
            assert.strictEqual(new Set(ids).size, ids.length);
          }),
        },
      ],
    },
    findDelivery: {
      read: [
        {
          name: "a delivery of the ambient tenant's endpoint; None for another tenant's or an unknown id",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a")).pipe(Tenant.withTenant("org-a"));
            yield* records.enqueue([newDelivery("d1", "a", "e1")]);
            assert.isTrue(Option.isNone(yield* records.findDelivery("d1")));
            assert.isTrue(Option.isNone(yield* records.findDelivery("nope")));
            const stored = yield* delivery("d1").pipe(Tenant.withTenant("org-a"));
            assert.strictEqual(stored.status, "pending");
            assert.strictEqual(stored.attempts, 0);
            assert.strictEqual(stored.body, '{"id":"e1"}');
          }),
        },
      ],
    },
    markSucceeded: {
      write: [
        {
          name: "a success counts the attempt and completes the delivery",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("ok", "a", "e1")]);
            yield* records.markSucceeded(relay, "ok", { at: at(2_000), statusCode: 204 });
            const ok = yield* delivery("ok");
            assert.strictEqual(ok.status, "succeeded");
            assert.strictEqual(ok.attempts, 1);
            assert.deepStrictEqual(ok.lastStatusCode, Option.some(204));
            assert.deepStrictEqual(ok.completedAt, Option.some(at(2_000)));
          }),
        },
      ],
    },
    reschedule: {
      write: [
        {
          name: "a failed attempt is counted and scheduled again",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("retry", "a", "e1")]);
            yield* records.reschedule(relay, "retry", {
              at: at(2_000),
              nextAttemptAt: at(12_000),
              statusCode: 503,
              error: "status",
            });
            const retry = yield* delivery("retry");
            assert.strictEqual(retry.status, "pending");
            assert.strictEqual(retry.attempts, 1);
            assert.deepStrictEqual(retry.nextAttemptAt, at(12_000));
            assert.deepStrictEqual(retry.lastStatusCode, Option.some(503));
            assert.deepStrictEqual(retry.lastError, Option.some("status"));
          }),
        },
      ],
    },
    defer: {
      write: [
        {
          name: "a deferral moves nextAttemptAt and is not an attempt",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("d1", "a", "e1")]);
            yield* records.defer(relay, "d1", at(13_000));
            const deferred = yield* delivery("d1");
            assert.strictEqual(deferred.attempts, 0);
            assert.deepStrictEqual(deferred.nextAttemptAt, at(13_000));
          }),
        },
      ],
    },
    markDead: {
      write: [
        {
          name: "a dead letter counts the attempt and completes the delivery",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("dead", "a", "e1")]);
            yield* records.markDead(relay, "dead", { at: at(3_000), error: "timeout" });
            const dead = yield* delivery("dead");
            assert.strictEqual(dead.status, "dead");
            assert.strictEqual(dead.attempts, 1);
            assert.deepStrictEqual(dead.lastError, Option.some("timeout"));
            assert.deepStrictEqual(dead.completedAt, Option.some(at(3_000)));
          }),
        },
      ],
    },
    redrive: {
      atomic: [
        {
          name: "only a dead delivery goes back to pending, due now, with its attempts reset",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([
              newDelivery("retry", "a", "e1"),
              newDelivery("dead", "a", "e2"),
            ]);
            yield* records.markDead(relay, "dead", { at: at(3_000), error: "timeout" });
            const notDead = yield* records.redrive("retry", at(4_000)).pipe(Effect.flip);
            assert.strictEqual(notDead._tag, "WebhookRecordNotFound");
            const revived = yield* records.redrive("dead", at(4_000));
            assert.strictEqual(revived.status, "pending");
            assert.strictEqual(revived.attempts, 0);
            assert.isTrue(Option.isNone(revived.completedAt));
            assert.deepStrictEqual(revived.nextAttemptAt, at(4_000));
          }),
        },
      ],
      race: [
        {
          name: "8 concurrent redrives of one dead delivery: exactly one revives it",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.enqueue([newDelivery("dead", "a", "e1")]);
            yield* records.markDead(relay, "dead", { at: at(3_000), error: "timeout" });
            const outcomes = yield* raced(many(() => records.redrive("dead", at(4_000))));
            assert.strictEqual(outcomes.filter((exit) => exit._tag === "Success").length, 1);
            assert.strictEqual((yield* delivery("dead")).status, "pending");
          }),
        },
      ],
    },
    listDeliveries: {
      read: [
        {
          name: "pages newest first by id and filters on status",
          run: Effect.gen(function* () {
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
            const page2 = yield* records.listDeliveries({
              endpointId: "a",
              limit: 2,
              before: "d2",
            });
            assert.deepStrictEqual(
              page2.map((row) => row.id),
              ["d1"],
            );
            const dead = yield* records.listDeliveries({
              endpointId: "a",
              status: "dead",
              limit: 10,
            });
            assert.deepStrictEqual(
              dead.map((row) => row.id),
              ["d2"],
            );
            // Another endpoint's rows never leak in.
            assert.deepStrictEqual(
              (yield* records.listDeliveries({ endpointId: "b", limit: 10 })).map((row) => row.id),
              ["d4"],
            );
          }),
        },
      ],
    },
    pruneFinished: {
      write: [
        {
          name: "prunes finished rows past the cutoff, never pending ones",
          run: Effect.gen(function* () {
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
          }),
        },
      ],
    },
    listBySubject: {
      read: [
        {
          name: "every tenant's deliveries about one user",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.createEndpoint(endpointInput("b")).pipe(Tenant.withTenant("org-a"));
            yield* records.enqueue([
              newDelivery("d1", "a", "e1", at(1_000), "user-1"),
              newDelivery("d2", "b", "e1", at(1_000), "user-1"),
              newDelivery("d3", "b", "e2", at(1_000), "user-2"),
            ]);
            assert.deepStrictEqual(
              (yield* records.listBySubject(relay, "user-1")).map((row) => row.id).sort(),
              ["d1", "d2"],
            );
          }),
        },
      ],
    },
    deleteBySubject: {
      write: [
        {
          name: "erasure removes a subject's rows only",
          run: Effect.gen(function* () {
            const records = yield* WebhookRecords.WebhookRecords;
            yield* records.createEndpoint(endpointInput("a"));
            yield* records.createEndpoint(endpointInput("b"));
            yield* records.enqueue([
              newDelivery("d1", "a", "e1", at(1_000), "user-1"),
              newDelivery("d2", "b", "e1", at(1_000), "user-1"),
              newDelivery("d3", "b", "e2", at(1_000), "user-2"),
            ]);
            yield* records.deleteBySubject(relay, "user-1");
            assert.deepStrictEqual(yield* records.listBySubject(relay, "user-1"), []);
            assert.strictEqual((yield* records.listBySubject(relay, "user-2")).length, 1);
          }),
        },
      ],
    },
  },
  sql: [
    {
      name: "plan 24 C9: a failure deleting the deliveries rolls the endpoint's removal back",
      run: Effect.gen(function* () {
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* records.enqueue([newDelivery("d1", "a", "e1")]);
        yield* TestSql.injectFailure({
          name: "webhooks_fail_delivery_delete",
          table: "webhooks_delivery",
          event: "DELETE",
        });
        const failure = yield* records.deleteEndpoint("a").pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");
        assert.isTrue(Option.isSome(yield* records.findEndpoint("a")));
        assert.isTrue(Option.isSome(yield* records.findDelivery("d1")));
      }),
    },
    {
      name: "plan 24 C8: an edit writes only its own columns (a raw write of another column survives)",
      run: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const records = yield* WebhookRecords.WebhookRecords;
        yield* records.createEndpoint(endpointInput("a"));
        yield* sql`UPDATE webhooks_endpoint SET "consecutiveDead" = 5 WHERE id = 'a'`;
        const edited = yield* records.updateEndpoint("a", { url: "https://moved.example.com/" });
        assert.strictEqual(edited.consecutiveDead, 5);
        const off = yield* records.setDisabled("a", { at: at(1_000), reason: "manual" });
        assert.strictEqual(off.consecutiveDead, 5);
        assert.strictEqual(off.url, "https://moved.example.com/");
      }),
    },
  ],
  tenancy: {
    covers: ["webhooks_endpoint", "webhooks_delivery"],
    cases: [
      { table: "webhooks_endpoint", insert: insertRow, methods: endpointMethods },
      { table: "webhooks_delivery", insert: insertRow, methods: deliveryMethods },
    ],
  },
});
