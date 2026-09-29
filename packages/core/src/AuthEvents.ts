// @awthaq/core — AuthEvents
//
// spec/behaviors/13-events.md, BEH-EA-097 through BEH-EA-104.
//
// The registry (BEH-EA-101) is `./AuthEventSchemas.ts` — every event is a
// `Schema` there (ESA-007), re-exported from here so callers keep writing
// `AuthEvents.AuthEvent`/`AuthEvents.Published`. This module is the service:
// `publish`, the two read paths, and the subscription sugar.
//
// **Delivery semantics.** The bus is an in-process, bounded, *dropping*
// PubSub: at-most-once observation, single process. It is not the record of
// record — `AuditLog` is (BEH-EA-100): `publish` writes the durable row inline,
// before the event reaches the bus, and never drops it. The pattern for anything
// that must not lose events (a projection, an export, another service) is
// therefore: keep a checkpoint (an `eventId`), `AuditLog.replay({ after })` to
// backfill, then tail; or run the `EventRelay` (outbox) over the audit table for
// cross-process fan-out. See spec/behaviors/13-events.md.
//
// **Stream privilege.** Subscribing (`stream`/`subscribe`/`on`/`onBatch`)
// delivers full event payloads — the same content as the audit table — so it is
// an audit-read-level privilege, not a public tap. Payloads are identifiers-only
// by design (ESA-005): no email, no free text about a person, except the fields
// named in `PII_FIELDS`.

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { AuditLog } from "./AuditLog.ts";
import {
  type AuthEvent,
  type AuthEventTag,
  type EventOf,
  type Published,
} from "./AuthEventSchemas.ts";
import { AuthRequestContext } from "./AuthRequestContext.ts";
import * as Observability from "./Observability.ts";

export * from "./AuthEventSchemas.ts";

export interface AuthEventsShape {
  /**
   * BEH-EA-098: returns once the event is durably recorded and offered to the
   * bus — never suspends on a subscriber, or on the bus's own capacity: at
   * capacity the *bus* copy is dropped (counted by `droppedCount`, logged),
   * never the `AuditLog` row. Stamps the envelope (`eventId`, `occurredAt`,
   * request context, trace ids) once, shared by the row and the bus event.
   */
  readonly publish: (event: AuthEvent) => Effect.Effect<void>;
  /**
   * BEH-EA-102: raw stream access for a consumer that needs custom
   * filtering/multiplexing. **Lazy**: the subscription registers when a
   * fiber first pulls, so an event published before that is not seen — use
   * `subscribe` when "everything from now on" matters. Every consumer of this
   * is a full subscriber of the one bus (it pulls every event), so prefer one
   * multi-tag `on([...], ...)` over many single-tag subscriptions.
   */
  readonly stream: Stream.Stream<Published>;
  /**
   * ALF-007: registers the subscription *now*, in the caller's `Scope`, and
   * returns a stream that yields every event published from this point on. The
   * race-free way to attach; `on`/`onBatch` are built on it.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<Published>, never, Scope.Scope>;
  /**
   * ALF-002/ESS-001/TMS-002/TRBS-003: how many `publish` calls have been
   * silently dropped from the bus (it was at capacity) since this `AuthEvents`
   * instance was built — the observable cost of `publish` never suspending, so
   * loss is visible rather than merely possible.
   */
  readonly droppedCount: Effect.Effect<number>;
}

export class AuthEvents extends Context.Service<AuthEvents, AuthEventsShape>()(
  "awthaq/core/AuthEvents",
) {}

/**
 * MA-004/ADR-EA-028: what `publish` does when the durable audit row cannot be written because
 * the store is unavailable. `"bestEffort"` (default): the failure is logged and counted
 * (`awthaq_audit_write_failed_total`), the operation that published the event still succeeds and
 * the bus still delivers it, so an audit-table outage degrades the trail instead of taking down
 * sign-in. `"required"`: the publishing operation dies with the `StoreUnavailable`, so no
 * security-relevant operation completes without its row (the pre-MA-004 behaviour, for a
 * deployment whose audit obligation outranks availability). Provide with
 * `AuthEvents.auditWritePolicy("required")`.
 */
export type AuditWritePolicy = "bestEffort" | "required";

export const AuditWritePolicy = Context.Reference<AuditWritePolicy>("awthaq/core/AuditWritePolicy", {
  defaultValue: () => "bestEffort",
});

export const auditWritePolicy = (policy: AuditWritePolicy) => Layer.succeed(AuditWritePolicy, policy);

/**
 * BEH-EA-097: a bounded capacity, so a slow or absent subscriber cannot
 * cause unbounded memory growth in the publishing process. No spec'd number
 * exists for this — 1024 is chosen as a generous, arbitrary default; an
 * application with a genuinely different tolerance can still swap this
 * `Layer` entirely, the same way any other capability is swapped.
 */
export const CAPACITY = 1024;

const hex = (value: number, width: number): string => value.toString(16).padStart(width, "0");

/**
 * ESA-002: uuidv7-shaped ids (48-bit millisecond timestamp, version 7, variant
 * 10, random tail), monotonic *within this process*: two ids minted in the same
 * millisecond are ordered by a 12-bit counter (RFC 9562 §6.2, method 1), so the
 * ids sort in publish order — which `AuditLog.list`'s tiebreak and
 * `AuditLog.replay`'s cursor rely on. Across processes the order is
 * millisecond-granular. Not a secret, so the built-in `Random` (no `Crypto`
 * requirement in every composition) is enough.
 */
const makeEventIds = Effect.gen(function* () {
  const last = yield* Ref.make({ ms: 0, counter: 0 });
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stamp = yield* Ref.modify(last, (previous) => {
      if (now > previous.ms) {
        const fresh = { ms: now, counter: 0 };
        return [fresh, fresh];
      }
      const next = previous.counter + 1;
      const state = next > 0xfff ? { ms: previous.ms + 1, counter: 0 } : { ms: previous.ms, counter: next };
      return [state, state];
    });
    const variant = yield* Random.nextIntBetween(0, 3);
    const rest = yield* Random.nextIntBetween(0, 0xfff);
    const tailHigh = yield* Random.nextIntBetween(0, 0xffffff);
    const tailLow = yield* Random.nextIntBetween(0, 0xffffff);
    const time = hex(stamp.ms, 12);
    return [
      time.slice(0, 8),
      time.slice(8),
      `7${hex(stamp.counter, 3)}`,
      `${hex(8 + variant, 1)}${hex(rest, 3)}`,
      `${hex(tailHigh, 6)}${hex(tailLow, 6)}`,
    ].join("-");
  });
});

/**
 * ticket 27 §4: the two counters that are exactly "an event happened" are kept
 * here, at the one choke point every strategy's event passes through, rather
 * than at every publisher.
 */
const countEvent = (event: AuthEvent) => {
  switch (event._tag) {
    case "auth.session.issued":
      return Metric.update(Observability.sessionsIssued, 1);
    case "auth.user.signInFailed":
      return Metric.update(
        Metric.withAttributes(Observability.loginFailures, { strategy: event.strategy }),
        1,
      );
    default:
      return Effect.void;
  }
};

/**
 * BEH-EA-100: `AuditLog` is a hard dependency — `publish` writes the
 * durable row inline, before the event ever reaches the `PubSub`. This is
 * what actually satisfies "MUST NOT depend on any `AuthEvents` subscriber":
 * durability lives structurally inside `publish` itself, not in something
 * optional a caller composes alongside it.
 */
export const layer = Layer.effect(
  AuthEvents,
  Effect.gen(function* () {
    const auditLog = yield* AuditLog;
    const policy = yield* AuditWritePolicy;
    // ALF-002/ESS-001/TMS-002/TRBS-003: `PubSub.bounded` applies
    // backpressure — its own publish suspends the calling fiber once the
    // buffer is full, directly contradicting this shape's own "never
    // suspends on a subscriber" contract (BEH-EA-098) and coupling the
    // auth hot path (every Password.signIn/signUp,
    // Verification.consume's replay/failure paths, OAuth's callback, …
    // publishes inline) to whatever subscriber happens to be installed —
    // a lagging or entirely absent one turns into a denial of service on
    // sign-in itself. `PubSub.dropping` keeps the identical bounded-memory
    // guarantee (BEH-EA-097) but never suspends the publisher: a full
    // buffer drops the newest event instead, which `droppedCount` below
    // makes observable rather than silent.
    const pubsub = yield* PubSub.dropping<Published>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const nextEventId = yield* makeEventIds;

    const deliver = (event: AuthEvent, parent: Option.Option<Tracer.Span>) =>
      Effect.gen(function* () {
        const request = yield* AuthRequestContext;
        const eventId = yield* nextEventId;
        const occurredAt = yield* DateTime.now;
        const published: Published = {
          ...event,
          eventId,
          occurredAt,
          correlationId: request.correlationId,
          traceId: Option.map(parent, (span) => span.traceId),
          spanId: Option.map(parent, (span) => span.spanId),
          ip: request.ip,
          userAgent: request.userAgent,
        };
        yield* auditLog.record(published).pipe(
          Effect.catchTag("StoreUnavailable", (unavailable) =>
            policy === "required"
              ? Effect.die(unavailable)
              : Metric.update(
                  Metric.withAttributes(Observability.auditWriteFailures, { tag: event._tag }),
                  1,
                ).pipe(
                  Effect.andThen(
                    Effect.logError(
                      `awthaq: the audit row for a "${event._tag}" event could not be written (${published.eventId})`,
                    ),
                  ),
                ),
          ),
        );
        yield* countEvent(event);
        const accepted = yield* PubSub.publish(pubsub, published);
        if (!accepted) {
          yield* Ref.update(dropped, (n) => n + 1);
          yield* Metric.update(
            Metric.withAttributes(Observability.eventsDropped, { tag: event._tag }),
            1,
          );
          yield* Effect.logWarning(
            `awthaq: AuthEvents dropped a "${event._tag}" event — subscriber(s) not keeping up`,
          );
        }
      });

    // The parent is read *outside* the publish span, so the envelope names the
    // span the operation ran under (the request), not `awthaq.event.publish` itself.
    const publish: AuthEventsShape["publish"] = (event) =>
      Effect.flatMap(Effect.option(Effect.currentSpan), (parent) =>
        deliver(event, parent).pipe(
          Effect.withSpan(Observability.Span.eventPublish, {
            attributes: { [Observability.Field.event]: event._tag },
          }),
        ),
      );

    return AuthEvents.of({
      publish,
      stream: Stream.fromPubSub(pubsub),
      subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      droppedCount: Ref.get(dropped),
    });
  }),
);

// ---- subscriptions ------------------------------------------------------------

type TagSelect = AuthEventTag | ReadonlyArray<AuthEventTag>;
type TagOf<Select extends TagSelect> =
  Select extends ReadonlyArray<infer Tag extends AuthEventTag>
    ? Tag
    : Select extends AuthEventTag
      ? Select
      : never;

/** What a handler for `Select` receives: the matching event(s) with their envelope. */
export type Handled<Select extends TagSelect> = Published<EventOf<TagOf<Select>>>;

/** A membership check that narrows: a type guard over the union, no assertion. */
const matching = <const Select extends TagSelect>(select: Select) => {
  const wanted = new Set<string>(typeof select === "string" ? [select] : select);
  return (event: Published): event is Handled<Select> => wanted.has(event._tag);
};

/** ALF-006/EOTS-009: the link back to the span the event was published under, when it had one. */
const originLinks = (event: Published): ReadonlyArray<Tracer.SpanLink> =>
  Option.match(Option.all({ traceId: event.traceId, spanId: event.spanId }), {
    onNone: () => [],
    onSome: ({ traceId, spanId }) => [
      { span: Tracer.externalSpan({ traceId, spanId }), attributes: {} },
    ],
  });

/**
 * BEH-EA-099/104 + EOTS-005/EOTS-009: one handler run, isolated. A failing
 * handler is logged under the stable name `auth.event.observer.error` — a
 * sanitized summary at error level, the raw cause only at debug — counted, and
 * never propagates to the publisher or another subscriber. Runs under its own
 * root span *linked* to the publishing span, with the correlation id annotated
 * on every log line it writes.
 */
const isolate = (event: Published, run: Effect.Effect<void, unknown>) =>
  run.pipe(
    Effect.catchCause((cause) =>
      Observability.logObserverFailure(
        "auth.event.observer.error",
        { tag: event._tag },
        cause,
      ).pipe(
        Effect.andThen(
          Metric.update(
            Metric.withAttributes(Observability.eventObserverErrors, { tag: event._tag }),
            1,
          ),
        ),
      ),
    ),
    Effect.annotateLogs(
      Option.match(event.correlationId, {
        onNone: () => ({}),
        onSome: (correlationId) => ({ [Observability.Field.correlationId]: correlationId }),
      }),
    ),
    Effect.withSpan(Observability.Span.eventHandle, {
      root: true,
      links: originLinks(event),
      attributes: {
        [Observability.Field.event]: event._tag,
        ...Option.match(event.correlationId, {
          onNone: () => ({}),
          onSome: (correlationId) => ({ [Observability.Field.correlationId]: correlationId }),
        }),
      },
    }),
  );

const RESTART_BACKOFF = Schedule.min([
  Schedule.exponential("100 millis"),
  Schedule.spaced("30 seconds"),
]);

/**
 * ALF-007/ECF-010: the shared subscription lifecycle behind `on`/`onBatch`.
 * The subscription is registered synchronously while the Layer builds (so an
 * event published right after the Layer is up is not lost), then the drain is
 * forked over that already-registered stream. If the drain ever ends for any
 * reason other than the Layer's scope closing — a defect outside the handler,
 * the stream completing — it is logged as `auth.event.subscription.died` and
 * resubscribed with bounded backoff (events published in that gap are the
 * bus's at-most-once loss; `AuditLog.replay` is the recovery path).
 */
const supervise = (
  label: string,
  drain: (stream: Stream.Stream<Published>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const events = yield* AuthEvents;
    const first = yield* events.subscribe;
    const restart = Effect.scoped(Effect.flatMap(events.subscribe, drain));
    const surviving = (attempt: Effect.Effect<void>) =>
      attempt.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Observability.logObserverFailure(
                "auth.event.subscription.died",
                { subscription: label },
                cause,
              ),
        ),
        Effect.andThen(Effect.logWarning("auth.event.subscription.ended", { subscription: label })),
      );
    yield* Metric.modify(Observability.eventSubscriptionsActive, 1);
    yield* Effect.forkScoped(
      Effect.ensuring(
        surviving(drain(first)).pipe(
          Effect.andThen(surviving(restart).pipe(Effect.repeat(RESTART_BACKOFF))),
        ),
        Metric.modify(Observability.eventSubscriptionsActive, -1),
      ),
    );
  });

/**
 * BEH-EA-103: sugar producing a subscription `Layer` — a caller never writes
 * its own `Stream.runForEach`/`Effect.forkScoped` to get BEH-EA-099's
 * isolation. `Layer.effectDiscard` is what supplies and then strips the
 * `Scope.Scope` the forked fiber needs, so the subscription's lifetime is
 * exactly this `Layer`'s own. `select` is one tag or an array of tags (ESS-007):
 * one subscription, the handler narrowed to the union of the selected events.
 */
export const on = <const Select extends TagSelect>(
  select: Select,
  handler: (event: Handled<Select>) => Effect.Effect<void, unknown>,
): Layer.Layer<never, never, AuthEvents> => {
  const isSelected = matching(select);
  const label = typeof select === "string" ? select : select.join(",");
  return Layer.effectDiscard(
    supervise(label, (stream) =>
      stream.pipe(
        Stream.filter(isSelected),
        Stream.runForEach((event) => isolate(event, handler(event))),
      ),
    ),
  );
};

/**
 * ESS-004: `on`'s batching twin, the pattern for a secondary sink (a SIEM
 * export, a warehouse loader) that wants one round trip per batch rather than
 * per event: the handler receives up to `size` events, or whatever arrived
 * within `within` of the first one. Same isolation and supervision as `on`; a
 * failed batch is logged and dropped, so a sink that must not lose events
 * checkpoints on `eventId` and backfills with `AuditLog.replay`.
 */
export const onBatch = <const Select extends TagSelect>(
  select: Select,
  options: { readonly size: number; readonly within: Duration.Input },
  handler: (batch: ReadonlyArray<Handled<Select>>) => Effect.Effect<void, unknown>,
): Layer.Layer<never, never, AuthEvents> => {
  const isSelected = matching(select);
  const label = `batch:${typeof select === "string" ? select : select.join(",")}`;
  return Layer.effectDiscard(
    supervise(label, (stream) =>
      stream.pipe(
        Stream.filter(isSelected),
        Stream.groupedWithin(options.size, options.within),
        Stream.runForEach((batch) => {
          const events = [...batch];
          const [head] = events;
          return head === undefined ? Effect.void : isolate(head, handler(events));
        }),
      ),
    ),
  );
};
