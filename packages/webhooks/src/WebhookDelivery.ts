// @awthaq/webhooks — WebhookDelivery
//
// CWM-004 (ADR-EA-030 Decision 7): the two halves that turn the event relay into signed HTTP.
//
//   1. `transportLayer` is the `EventTransport` the relay hands each batch to. It does no network I/O:
//      for every event and every enabled endpoint whose filter matches it *enqueues* a delivery row
//      (unique per endpoint and event, so the relay's at-least-once re-hand-off adds nothing) and
//      returns. The relay's cursor therefore advances as soon as the batch is durably queued, and one
//      slow or dead receiver can never hold back the others or the relay itself.
//   2. `drainDue` / `workerLayer` is the delivery worker: it claims due rows with a lease, signs and
//      POSTs each, and either records the success, schedules the next attempt with capped exponential
//      backoff, or dead-letters the row once `maxAttempts` is spent. Consecutive dead-letters switch
//      the endpoint off (`disableAfterConsecutiveDead`) so a receiver that is gone stops costing work.
//
// What an attempt never does: follow a redirect (a 3xx is a failed attempt — a redirect is the classic
// way past an SSRF check), read or store the receiver's response body (untrusted text), or send to an
// address the URL check refuses. The URL is re-checked at every attempt: the host is resolved ONCE
// (`HostResolver.pin`), every address it answered must be public, and the request connects to that
// address with the original Host/SNI (`WebhookTransport`, BEH-EA-303), so a name that flips between
// the check and the connect has nothing to flip: DNS is not asked again.
//
// Routing is per tenant (BEH-EA-300): an event reaches only the endpoints of the tenant it happened in.
//
// Delivery is at-least-once: a worker that dies between the POST and the row update leaves the lease
// to lapse and the delivery is sent again, with the same `webhook-id`. Receivers deduplicate on it.

import { type AuditLog, EventRelay } from "@awthaq/core";
import { Encryption, HostResolver, OutboundUrl, RateLimiter } from "@awthaq/ports";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import * as WebhookPayload from "./WebhookPayload.ts";
import * as WebhookRecords from "./WebhookRecords.ts";
import * as WebhookSecrets from "./WebhookSecrets.ts";
import * as WebhookSignature from "./WebhookSignature.ts";
import * as WebhookTransport from "./WebhookTransport.ts";
import * as WebhooksConfig from "./WebhooksConfig.ts";

export const RELAY_NAME = "webhooks";

/** CWM-004: one delivery attempt's outcome, tagged `succeeded`, `retry`, `dead` or `deferred`. */
export const deliveries = Metric.counter("awthaq_webhook_deliveries_total", {
  description: "Webhook delivery attempts by outcome (succeeded, retry, dead, deferred)",
  incremental: true,
});

// ---- enqueue: the EventTransport ---------------------------------------------------------------

/** Turns a relayed batch into queued deliveries. Requires the records, `Crypto` (ids) and the plugin config. */
export const enqueue = (events: ReadonlyArray<Parameters<typeof WebhookPayload.toBody>[0]>) =>
  Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* WebhooksConfig.WebhooksConfig;
    const endpoints = (yield* records.listEndpoints).filter((row) => Option.isNone(row.disabledAt));
    if (endpoints.length === 0 || events.length === 0) return 0;
    const now = yield* DateTime.now;
    const rows: Array<WebhookRecords.NewDelivery> = [];
    for (const event of events) {
      const body = JSON.stringify(
        WebhookPayload.toBody(event, { includeClientContext: settings.includeClientContext }),
      );
      const subjectUserId = WebhookPayload.subjectUserId(event);
      for (const endpoint of endpoints) {
        if (!WebhookPayload.matchesAny(endpoint.eventTags, event._tag)) continue;
        // BEH-EA-300: a tenant's events reach that tenant's endpoints only.
        if (
          !WebhookPayload.tenantRoutes(
            endpoint.tenantId,
            event.tenantId,
            settings.platformEndpointsHearAllTenants,
          )
        ) {
          continue;
        }
        // An endpoint hears what happened after it was registered, not the log's history.
        if (DateTime.toEpochMillis(event.occurredAt) < DateTime.toEpochMillis(endpoint.createdAt))
          continue;
        rows.push({
          id: yield* crypto.randomUUIDv7.pipe(Effect.orDie),
          endpointId: endpoint.id,
          eventId: event.eventId,
          eventTag: event._tag,
          subjectUserId,
          body,
          nextAttemptAt: now,
        });
      }
    }
    return rows.length === 0 ? 0 : yield* records.enqueue(rows);
  });

/** The `EventTransport` the relay delivers to: enqueue and return (never network I/O). */
export const transportLayer = Layer.effect(
  EventRelay.EventTransport,
  Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* WebhooksConfig.WebhooksConfig;
    return EventRelay.EventTransport.of({
      deliver: (events) =>
        enqueue(events).pipe(
          Effect.provideService(WebhookRecords.WebhookRecords, records),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(WebhooksConfig.WebhooksConfig, settings),
          Effect.asVoid,
        ),
    });
  }),
);

/**
 * The relay for the webhooks consumer: tails the audit log from its own persisted position
 * (`name: "webhooks"`) into `transportLayer`. Requires what `EventRelay.layer` does (`AuditLog`, a
 * `RelayCursorStore`) plus the records and `Crypto`.
 */
export const relayLayer = (
  options?: Partial<Omit<EventRelay.EventRelayOptions, "name">>,
  // The explicit type is the narrow exception `@awthaq/password` and `@awthaq/oauth` document: declaration
  // emit cannot name `AuditLog` through the relay's own inferred requirement (TS2883).
): Layer.Layer<
  never,
  never,
  AuditLog.AuditLog | EventRelay.RelayCursorStore | WebhookRecords.WebhookRecords | Crypto.Crypto
> => EventRelay.layer({ name: RELAY_NAME, ...options }).pipe(Layer.provide(transportLayer));

// ---- one attempt -------------------------------------------------------------------------------

type Outcome = "succeeded" | "retry" | "dead" | "deferred";

const failureClass = (error: unknown): string => {
  if (Cause.isTimeoutError(error)) return "timeout";
  return error instanceof WebhookTransport.WebhookTransportError ? error.failure : "connect";
};

/** Sends one claimed delivery and records what happened. Never fails: every problem is an outcome. */
export const attempt = (delivery: WebhookRecords.DeliveryRecord) =>
  Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    const encryption = yield* Encryption.Encryption;
    const limiter = yield* RateLimiter.RateLimiter;
    const transport = yield* WebhookTransport.WebhookTransport;
    const settings = yield* WebhooksConfig.WebhooksConfig;
    const now = yield* DateTime.now;

    const endpointOpt = yield* records.findEndpoint(delivery.endpointId);
    if (Option.isNone(endpointOpt)) {
      yield* records.markDead(delivery.id, { at: now, error: "endpointGone" });
      return "dead" satisfies Outcome;
    }
    const endpoint = endpointOpt.value;

    // Outbound budget per endpoint: over it, the delivery waits — this is not an attempt.
    const budget = yield* limiter
      .consume({
        key: `webhooks:deliver:${endpoint.id}`,
        limit: settings.deliveryRate.limit,
        window: settings.deliveryRate.window,
      })
      .pipe(
        Effect.as(Option.none<number>()),
        Effect.catchTag("RateLimitExceeded", (exceeded) =>
          Effect.succeed(Option.some(exceeded.retryAfterMillis)),
        ),
      );
    if (Option.isSome(budget)) {
      yield* records.defer(delivery.id, DateTime.addDuration(now, Duration.millis(budget.value)));
      return "deferred" satisfies Outcome;
    }

    const failed = (info: { readonly statusCode?: number; readonly error: string }) =>
      Effect.gen(function* () {
        const made = delivery.attempts + 1;
        // BEH-EA-301: a test ping is one attempt, and a receiver that is down is not evidence against the endpoint.
        if (delivery.eventTag === WebhookPayload.TEST_EVENT_TAG) {
          yield* records.markDead(delivery.id, { at: now, ...info });
          return "dead" satisfies Outcome;
        }
        if (made >= settings.maxAttempts) {
          yield* records.markDead(delivery.id, { at: now, ...info });
          const consecutive = yield* records.bumpDead(endpoint.id);
          if (
            settings.disableAfterConsecutiveDead > 0 &&
            consecutive >= settings.disableAfterConsecutiveDead
          ) {
            yield* records
              .setDisabled(endpoint.id, { at: now, reason: "failing" })
              .pipe(Effect.ignore);
            yield* Effect.logWarning(
              `awthaq/webhooks: endpoint ${endpoint.id} disabled after ${consecutive} consecutive dead-lettered deliveries`,
            );
          }
          return "dead" satisfies Outcome;
        }
        yield* records.reschedule(delivery.id, {
          at: now,
          nextAttemptAt: DateTime.addDuration(now, WebhooksConfig.retryDelay(settings, made)),
          ...info,
        });
        return "retry" satisfies Outcome;
      });

    // The URL is judged again at every attempt: registration was a point in time. The host is resolved ONCE here
    // and the attempt connects to that address (BEH-EA-303); development mode (`allowPrivateTargets`) has no pin.
    const syntactic = OutboundUrl.problem("url", endpoint.url, {
      allowPrivate: settings.allowPrivateTargets,
    });
    if (Option.isSome(syntactic)) return yield* failed({ error: "blocked" });
    const pin = settings.allowPrivateTargets
      ? Result.succeed(Option.none<HostResolver.PinnedTarget>())
      : Result.map(yield* HostResolver.pin(endpoint.url), Option.some);
    if (Result.isFailure(pin)) return yield* failed({ error: "blocked" });

    const secrets = yield* WebhookSecrets.open(encryption, endpoint, now);
    if (Option.isNone(secrets)) return yield* failed({ error: "secret" });
    // BEH-EA-304: the endpoint's custom headers, opened like the secret (a value that does not open fails as `secret`).
    const custom = yield* WebhookSecrets.openHeaders(encryption, endpoint);
    if (Option.isNone(custom)) return yield* failed({ error: "secret" });

    const timestamp = Math.floor(DateTime.toEpochMillis(now) / 1000);
    const headers = yield* WebhookSignature.headersFor(secrets.value, {
      id: delivery.eventId,
      timestamp,
      body: delivery.body,
    });
    const sent = yield* transport
      .send({
        url: endpoint.url,
        headers: {
          ...custom.value,
          ...headers,
          "content-type": "application/json",
          "user-agent": settings.userAgent,
        },
        body: delivery.body,
        pin: pin.success,
        allowPrivate: settings.allowPrivateTargets,
        timeout: settings.requestTimeout,
      })
      .pipe(
        Effect.timeout(settings.requestTimeout),
        Effect.map((response) => ({ _tag: "responded" as const, status: response.status })),
        Effect.catch((error) =>
          Effect.succeed({ _tag: "failed" as const, error: failureClass(error) }),
        ),
      );
    if (sent._tag === "failed") return yield* failed({ error: sent.error });
    const status = sent.status;
    if (status >= 200 && status < 300) {
      yield* records.markSucceeded(delivery.id, { at: now, statusCode: status });
      yield* records.clearDead(endpoint.id);
      return "succeeded" satisfies Outcome;
    }
    return yield* failed({ statusCode: status, error: "status" });
  });

/** Runs `attempt` and counts its outcome; a defect in one delivery is logged and never stops the batch. */
const attemptCounted = (delivery: WebhookRecords.DeliveryRecord) =>
  attempt(delivery).pipe(
    Effect.tap((outcome) => Metric.update(Metric.withAttributes(deliveries, { outcome }), 1)),
    Effect.catchCause((cause) =>
      Effect.logError("awthaq/webhooks: delivery attempt defect", Cause.pretty(cause)).pipe(
        Effect.as("retry" satisfies Outcome),
      ),
    ),
  );

// ---- the worker --------------------------------------------------------------------------------

/**
 * Claims what is due and attempts it, `concurrency` at a time. Resolves to how many deliveries were
 * attempted (0 when nothing is due) — what a test steps and what the loop uses to decide whether to sleep.
 */
export const drainDue = Effect.gen(function* () {
  const records = yield* WebhookRecords.WebhookRecords;
  const settings = yield* WebhooksConfig.WebhooksConfig;
  const now = yield* DateTime.now;
  const claimed = yield* records.claimDue({
    now,
    limit: settings.batchSize,
    lease: settings.lease,
  });
  yield* Effect.forEach(claimed, attemptCounted, {
    concurrency: settings.concurrency,
    discard: true,
  });
  return claimed.length;
});

/** Deletes finished rows older than `deliveryRetention`. */
export const pruneOnce = Effect.gen(function* () {
  const records = yield* WebhookRecords.WebhookRecords;
  const settings = yield* WebhooksConfig.WebhooksConfig;
  const now = yield* DateTime.now;
  return yield* records.pruneFinished(DateTime.subtractDuration(now, settings.deliveryRetention));
});

/**
 * Opt-in: a scoped background fiber draining due deliveries, sleeping `pollInterval` when idle, plus an
 * hourly retention prune. A failing tick is logged and retried; it never stops the worker.
 */
export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* WebhooksConfig.WebhooksConfig;
    const failures = yield* Ref.make(0);
    const tick = drainDue.pipe(
      Effect.tap(() => Ref.set(failures, 0)),
      Effect.catchCause((cause) =>
        Ref.update(failures, (n) => n + 1).pipe(
          Effect.andThen(
            Effect.logError("awthaq/webhooks: worker tick failed", Cause.pretty(cause)),
          ),
          Effect.as(0),
        ),
      ),
    );
    const loop = Effect.forever(
      Effect.gen(function* () {
        const attempted = yield* tick;
        if (attempted >= settings.batchSize) return;
        const failed = yield* Ref.get(failures);
        yield* Effect.sleep(
          failed === 0
            ? settings.pollInterval
            : Duration.min(
                Duration.times(settings.pollInterval, 2 ** Math.min(failed, 6)),
                Duration.seconds(30),
              ),
        );
      }),
    );
    yield* Effect.forkScoped(loop);
    yield* Effect.forkScoped(
      pruneOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("awthaq/webhooks: prune failed", Cause.pretty(cause)),
        ),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
      ),
    );
  }),
);

/** Relay plus worker: everything `Webhooks.background` installs. Requires a `WebhookTransport` (`layerNodePinned` in Node). */
export const backgroundLayer = (options?: Partial<Omit<EventRelay.EventRelayOptions, "name">>) =>
  Layer.merge(relayLayer(options), workerLayer);
