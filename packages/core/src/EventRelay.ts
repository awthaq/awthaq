// @awthaq/core — EventRelay
//
// CWM-004/MAPS-010 (decision D2, ADR-EA-030): cross-process event delivery. `AuthEvents` is an
// in-process, bounded, at-most-once bus (BEH-EA-097/098): it is right for a subscriber in the same
// process (`AuthEvents.on`), and wrong for another service, a webhook fan-out, a SIEM or a cache
// that must hear about a revoked session. The reliable source for those is the durable audit
// table, which every event already reaches inside the publishing operation (BEH-EA-100). This
// module tails it — a transactional outbox with no extra table on the write path.
//
// `EventRelay.layer({ name })` is an opt-in background fiber that reads `AuditLog` from a
// persisted position, hands the events to an application-provided `EventTransport` (Redis, Kafka,
// SQS, an HTTP call — the seam a first-party webhooks plugin sits on), and advances the position
// only after the transport accepted the batch. So:
//
//   - **At-least-once.** A transport failure leaves the position where it was and the same batch
//     is retried (with backoff); a crash between delivery and the position write redelivers that
//     batch on restart. A consumer deduplicates on `eventId` (the audit row's own id).
//   - **Ordered by id**, which is publish order within a process and millisecond-granular across
//     processes. To avoid skipping a row a slower process commits *behind* the position, an event
//     is only relayed once it is `settleDelay` old (default 2 s): delivery lags the bus by that
//     much, in exchange for not missing late-committing rows. Raise it if your processes' clocks
//     or commit latencies differ by more.
//   - **Resumable.** The position lives in a `RelayCursorStore` (SQL: `auth_relay_cursor`, core
//     migration 22; memory for tests), one row per relay `name`. Several relays with different
//     names (one per consumer) each keep their own.
//   - **One writer per name.** Two processes running the same name both deliver: that is safe
//     (at-least-once) but wasteful, so run one per name, or accept the duplicates.
//
// A row that no longer decodes (`AuditLogDecodeError`) stops the relay at that row, loudly, rather
// than skipping an event silently; the failure is logged and counted on every retry.
//
// What crosses the transport is exactly what a live subscriber sees: the typed event plus its
// envelope (ids, timestamps, correlation id, client address and user agent) — identifiers only,
// never a secret or an email (ADR-EA-029), so an external consumer inherits that posture.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Repositories as SqlRepositories } from "@awthaq/sql";
import * as AuditLog from "./AuditLog.ts";
import type { AuthEventTag, Published } from "./AuthEventSchemas.ts";
import * as Observability from "./Observability.ts";

/**
 * The application's outlet for relayed events. `deliver` receives one batch, in id order, and
 * must resolve only once the batch is durably handed off; a failure (any error or defect) makes the
 * relay retry the same batch. It must be idempotent on `eventId`.
 */
export interface EventTransportShape {
  readonly deliver: (events: ReadonlyArray<Published>) => Effect.Effect<void, unknown>;
}

export class EventTransport extends Context.Service<EventTransport, EventTransportShape>()(
  "awthaq/core/EventTransport",
) {}

/** Where a relay stopped: the id of the last audit event its transport accepted. */
export interface RelayCursorStoreShape {
  readonly get: (name: string) => Effect.Effect<Option.Option<string>>;
  readonly set: (name: string, lastEventId: string) => Effect.Effect<void>;
}

export class RelayCursorStore extends Context.Service<RelayCursorStore, RelayCursorStoreShape>()(
  "awthaq/core/RelayCursorStore",
) {}

/** In-process positions: lost on restart (a restarted relay begins again), for tests and single-process demos. */
export const layerCursorMemory = Layer.effect(
  RelayCursorStore,
  Effect.gen(function* () {
    const positions = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    return RelayCursorStore.of({
      get: (name) =>
        Ref.get(positions).pipe(Effect.map((all) => Option.fromNullishOr(all.get(name)))),
      set: (name, lastEventId) =>
        Ref.update(positions, (all) => new Map(all).set(name, lastEventId)),
    });
  }),
);

/** Durable positions in `auth_relay_cursor` (run core migrations, including 22). */
export const layerCursorSql = Layer.effect(
  RelayCursorStore,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.RelayCursorRepository;
    return RelayCursorStore.of({
      get: (name) => repo.get(name).pipe(Effect.orDie),
      set: (name, lastEventId) =>
        Effect.flatMap(DateTime.now, (now) => repo.set(name, lastEventId, now)).pipe(Effect.orDie),
    });
  }),
);

export interface EventRelayOptions {
  /** Identifies this relay's position (and its metric label). One per consumer. */
  readonly name: string;
  /** Events per delivery. Default 100. */
  readonly batchSize?: number;
  /** How long to wait when caught up. Default 1 second. */
  readonly pollInterval?: Duration.Input;
  /** An event is relayed once it is this old (see the module header). Default 2 seconds. */
  readonly settleDelay?: Duration.Input;
  /** Relay only this event tag. Default: every event. */
  readonly eventTag?: AuthEventTag;
  /** Where a relay with no stored position starts, after this event id. Default: the beginning of the log. */
  readonly startAfter?: string;
}

const DEFAULTS = {
  batchSize: 100,
  pollInterval: Duration.seconds(1),
  settleDelay: Duration.seconds(2),
} as const;

/** The longest wait between attempts after consecutive failures. */
const MAX_BACKOFF = Duration.seconds(30);

/**
 * One tick: reads the next batch after the stored position, drops the not-yet-settled tail,
 * hands the rest to the transport and, only if it accepted, advances the position. Resolves to how
 * many events were delivered (0 when caught up). Fails with the transport's error (position
 * unchanged, the batch is retried by the next tick) or an `AuditLogDecodeError`.
 */
export const drainOnce = (options: EventRelayOptions) =>
  Effect.gen(function* () {
    const auditLog = yield* AuditLog.AuditLog;
    const transport = yield* EventTransport;
    const store = yield* RelayCursorStore;
    const batchSize = options.batchSize ?? DEFAULTS.batchSize;
    const settleMillis = Duration.toMillis(
      Duration.fromInputUnsafe(options.settleDelay ?? DEFAULTS.settleDelay),
    );

    const stored = yield* store.get(options.name);
    const after = Option.isSome(stored)
      ? Option.some(stored.value)
      : Option.fromNullishOr(options.startAfter);
    const now = yield* DateTime.now;
    const settledBefore = DateTime.toEpochMillis(now) - settleMillis;

    const page = yield* auditLog
      .replay({
        ...(Option.isSome(after) ? { after: after.value } : {}),
        ...(options.eventTag === undefined ? {} : { eventTag: options.eventTag }),
        batchSize,
      })
      .pipe(Stream.take(batchSize), Stream.runCollect);

    // ids are time-ordered: the settled rows are a prefix, and the first unsettled one ends it.
    const settled: Array<AuditLog.AuditLogRecord> = [];
    for (const record of page) {
      if (DateTime.toEpochMillis(record.occurredAt) > settledBefore) break;
      settled.push(record);
    }
    const last = settled.at(-1);
    if (last === undefined) return 0;

    yield* transport.deliver(settled.map(AuditLog.toPublished));
    yield* store.set(options.name, last.id);
    yield* Metric.update(
      Metric.withAttributes(Observability.relayDelivered, { relay: options.name }),
      settled.length,
    );
    return settled.length;
  });

/**
 * Opt-in: a scoped background fiber running `drainOnce` until caught up, then every `pollInterval`.
 * A failing tick is logged as `auth.relay.failed`, counted, and retried with exponential backoff
 * (capped at 30 s) from the same position; it never stops the relay and never affects the
 * operations that publish. Requires `AuditLog`, an `EventTransport` and a `RelayCursorStore`.
 */
export const layer = (options: EventRelayOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const batchSize = options.batchSize ?? DEFAULTS.batchSize;
      const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? DEFAULTS.pollInterval);
      const failures = yield* Ref.make(0);
      const tick = drainOnce(options).pipe(
        Effect.tap(() => Ref.set(failures, 0)),
        Effect.map((delivered): "more" | "caughtUp" =>
          delivered >= batchSize ? "more" : "caughtUp",
        ),
        Effect.catchCause((cause) =>
          Effect.all(
            [
              Ref.update(failures, (n) => n + 1),
              Observability.logObserverFailure("auth.relay.failed", { relay: options.name }, cause),
              Metric.update(
                Metric.withAttributes(Observability.relayFailures, { relay: options.name }),
                1,
              ),
            ],
            { discard: true },
          ).pipe(Effect.as("failed" as const)),
        ),
      );
      const loop = Effect.forever(
        Effect.gen(function* () {
          const outcome = yield* tick;
          if (outcome === "more") return;
          const failed = yield* Ref.get(failures);
          const wait =
            outcome === "failed"
              ? Duration.min(Duration.times(pollInterval, 2 ** Math.min(failed, 10)), MAX_BACKOFF)
              : pollInterval;
          yield* Effect.sleep(wait);
        }),
      );
      yield* Effect.forkScoped(loop);
    }),
  );
