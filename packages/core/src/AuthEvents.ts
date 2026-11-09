// @awthaq/core — AuthEvents
//
// spec/behaviors/13-events.md, BEH-EA-097 through BEH-EA-104.
//
// Core's registry (BEH-EA-101) is `./AuthEventSchemas.ts` — every core event is
// a `Schema` there (ESA-007), re-exported from here so callers keep writing
// `AuthEvents.AuthEvent`/`AuthEvents.Published`. This module is the service:
// `publish` (core's events), `emit` (any event, through its definition:
// ADR-EA-049), the two read paths, the validating guards and the subscription
// sugar. The bus carries every event of the composition, so it is typed open
// (`PublishedAny`) and narrowed by `is(...)`, which validates rather than trusts.
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
// an event declares as `pii` (`AuthEvents.piiFieldsOf`).

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import { Defects, SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { AuditLog } from "./AuditLog.ts";
import {
  type AnyEvent,
  type AuthEvent,
  type AuthEventTag,
  CoreRegistry,
  type EventOf,
  EventRegistry,
  type Published,
  type PublishedAny,
} from "./AuthEventSchemas.ts";
import * as EventDefinition from "./EventDefinition.ts";
import { Api } from "@awthaq/api";
import * as Observability from "./Observability.ts";
import { TenantContext } from "./Tenant.ts";

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
   * ADR-EA-049: publishes any declared event through its definition:
   * `events.emit(TwoFactorEvents.TwoFactorEnabledEvent, { userId })` (`_tag` is
   * filled in). The same guarantees as `publish`: one envelope, the audit row
   * (actor column, declared personal data recorded with the row), the lane the
   * definition declares (ADR-EA-037), then the bus. A definition the
   * composition does not declare is handled per `UndeclaredEventPolicy`.
   */
  readonly emit: <D extends EventDefinition.Any>(
    definition: D,
    input: EventDefinition.Input<D>,
  ) => Effect.Effect<void>;
  /**
   * BEH-EA-102: raw stream access for a consumer that needs custom
   * filtering/multiplexing. **Lazy**: the subscription registers when a
   * fiber first pulls, so an event published before that is not seen — use
   * `subscribe` when "everything from now on" matters. Every consumer of this
   * is a full subscriber of the one bus (it pulls every event), so prefer one
   * multi-tag `on([...], ...)` over many single-tag subscriptions.
   */
  readonly stream: Stream.Stream<PublishedAny>;
  /**
   * ALF-007: registers the subscription *now*, in the caller's `Scope`, and
   * returns a stream that yields every event published from this point on. The
   * race-free way to attach; `on`/`onBatch` are built on it. Like `stream`, it
   * carries every event of the composition, typed open: narrow with
   * `Stream.filter(AuthEvents.is("auth.session.issued"))`.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<PublishedAny>, never, Scope.Scope>;
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

export const AuditWritePolicy = Context.Reference<AuditWritePolicy>(
  "awthaq/core/AuditWritePolicy",
  {
    defaultValue: () => "bestEffort",
  },
);

export const auditWritePolicy = (policy: AuditWritePolicy) =>
  Layer.succeed(AuditWritePolicy, policy);

/**
 * ADR-EA-049: what `emit` does with a definition whose tag the composed `EventRegistry` does not
 * hold (its plugin did not list it in `events`). `"warn"` (default): the event is still recorded and
 * delivered (its definition was in hand), and `auth.event.undeclared` is logged and counted. `"die"`:
 * the publishing operation dies with `UndeclaredEvent`; `TestAuth.layer` sets it, so a plugin's own
 * tests catch the slip. Nothing is checked against core's default registry, which knows no plugin.
 */
export const UndeclaredEventPolicy = Context.Reference<"warn" | "die">(
  "awthaq/core/UndeclaredEventPolicy",
  { defaultValue: () => "warn" },
);

/** ADR-EA-049: `emit` was given a definition the composition does not declare, under `UndeclaredEventPolicy` `"die"`. */
export class UndeclaredEvent extends Data.TaggedError("AuthEvents/UndeclaredEvent")<{
  readonly tag: string;
  readonly message: string;
}> {}

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
 * millisecond-granular. Not a secret, so the built-in `Random` (no `SecureRandom`
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
      const state =
        next > 0xfff ? { ms: previous.ms + 1, counter: 0 } : { ms: previous.ms, counter: next };
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
    // ADR-EA-049: read once, where the composition builds this service (`auth.eventsLayer` below it).
    const registry = yield* EventRegistry;
    const undeclaredPolicy = yield* UndeclaredEventPolicy;
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
    const pubsub = yield* PubSub.dropping<PublishedAny>(CAPACITY);
    const dropped = yield* Ref.make(0);
    const nextEventId = yield* makeEventIds;

    // One delivery for `publish` and `emit`: the definition supplies the encoding, the actor column,
    // the declared personal data and the lane (ADR-EA-049).
    const deliver = (
      event: AnyEvent,
      definition: EventDefinition.Any,
      parent: Option.Option<Tracer.Span>,
    ) =>
      Effect.gen(function* () {
        // ADR-EA-047: an optional read. Events are enrichment, so a job or the relay publishes with no request.
        const request = Option.filter(
          yield* Effect.serviceOption(Api.AuthRequestContext),
          Api.isRequest,
        );
        const tenantId = yield* TenantContext;
        const eventId = yield* nextEventId;
        const occurredAt = yield* DateTime.now;
        const published: PublishedAny = {
          ...event,
          eventId,
          occurredAt,
          correlationId: Option.map(request, (facts) => facts.correlationId),
          traceId: Option.map(parent, (span) => span.traceId),
          spanId: Option.map(parent, (span) => span.spanId),
          ip: Option.flatMap(request, (facts) => facts.ip),
          userAgent: Option.flatMap(request, (facts) => facts.userAgent),
          tenantId,
        };
        const record = auditLog
          .record(published, definition)
          .pipe(
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
        const toBus = Effect.gen(function* () {
          if (CoreRegistry.is(event)) yield* countEvent(event);
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
        // ADR-EA-037: an attempt event is recorded and delivered once the enclosing unit of work
        // has ended, committed or not (a rollback must not erase the forensic record). A state
        // change keeps its audit row inside the transaction, atomic with the change (the
        // ADR-EA-030 relay tails only committed rows), and tells live subscribers on commit.
        if (definition[EventDefinition.MetaKey].attempt) {
          yield* SqlTransaction.afterUnit(Effect.andThen(record, toBus));
        } else {
          yield* record;
          yield* SqlTransaction.onCommit(toBus);
        }
      });

    // The parent is read *outside* the publish span, so the envelope names the
    // span the operation ran under (the request), not `awthaq.event.publish` itself.
    const traced = (event: AnyEvent, definition: EventDefinition.Any) =>
      Effect.flatMap(Effect.option(Effect.currentSpan), (parent) =>
        deliver(event, definition, parent).pipe(
          Effect.withSpan(Observability.Span.eventPublish, {
            attributes: { [Observability.Field.event]: event._tag },
          }),
        ),
      );

    // `event` is typed `AuthEvent`, so core's registry always holds its definition.
    const publish: AuthEventsShape["publish"] = (event) =>
      Option.match(CoreRegistry.definitionOf(event._tag), {
        onNone: () =>
          Defects.invariantViolation(
            "AuthEvents.publish",
            `awthaq: "${event._tag}" is not one of core's events; publish a plugin's event with emit`,
          ),
        onSome: (definition) => traced(event, definition),
      });

    /** ADR-EA-049: a composed registry that does not hold `tag` means its plugin did not declare it. */
    const checkDeclared = (tag: string) => {
      if (registry.origin !== "composition" || registry.isTag(tag)) return Effect.void;
      const message = `awthaq: event "${tag}" is emitted but no composed plugin declares it in its events`;
      return undeclaredPolicy === "die"
        ? Effect.die(new UndeclaredEvent({ tag, message }))
        : Metric.update(Metric.withAttributes(Observability.eventsUndeclared, { tag }), 1).pipe(
            Effect.andThen(Effect.logWarning("auth.event.undeclared", { tag })),
          );
    };

    const emit: AuthEventsShape["emit"] = (definition, input) =>
      Effect.gen(function* () {
        // The same defect policy as an unencodable core event: a malformed input is a bug at the call site.
        const event = yield* Effect.orDie(definition.makeEffect(input));
        yield* checkDeclared(event._tag);
        yield* traced(event, definition);
      });

    return AuthEvents.of({
      publish,
      emit,
      stream: Stream.fromPubSub(pubsub),
      subscribe: PubSub.subscribe(pubsub).pipe(Effect.map(Stream.fromSubscription)),
      droppedCount: Ref.get(dropped),
    });
  }),
);

// ---- guards and subscriptions --------------------------------------------------

/** One selector: a core tag, or an event definition (a plugin's, or core's). */
type Selector = AuthEventTag | EventDefinition.Any;
/** One selector or several, mixed. */
type Select = Selector | ReadonlyArray<Selector>;
type One<S extends Select> = S extends ReadonlyArray<infer Item> ? Item : S;
type EventOfSelector<S> = S extends AuthEventTag
  ? EventOf<S>
  : S extends EventDefinition.Any
    ? EventDefinition.TypeOf<S>
    : never;

/** What a handler or guard for `S` receives: the selected events with their envelope. */
export type Handled<S extends Select> = Published<EventOfSelector<One<S>>>;

const isList = (select: Select): select is ReadonlyArray<Selector> => Array.isArray(select);

const selectorsOf = (select: Select): ReadonlyArray<Selector> =>
  isList(select) ? select : [select];

const tagOf = (selector: Selector) =>
  typeof selector === "string" ? selector : selector[EventDefinition.MetaKey].tag;

const labelOf = (select: Select) => selectorsOf(select).map(tagOf).join(",");

/**
 * ADR-EA-049: a guard over the open stream, by core tag(s) and/or event definition(s). A core tag
 * matches by tag (`Auth.make` refuses any other declaration of a core tag); a definition matches when
 * the tag is its own AND its schema accepts the event, so it validates rather than trusts:
 * `Stream.filter(AuthEvents.is(TwoFactorEvents.TwoFactorEnabledEvent))`.
 */
export const is = <const S extends Select>(select: S) => {
  const tags = new Set<string>();
  const definitions = new Map<string, EventDefinition.Any>();
  for (const selector of selectorsOf(select)) {
    if (typeof selector === "string") tags.add(selector);
    else definitions.set(selector[EventDefinition.MetaKey].tag, selector);
  }
  return (event: PublishedAny): event is Handled<S> => {
    if (tags.has(event._tag)) return true;
    const definition = definitions.get(event._tag);
    return definition !== undefined && Schema.is(definition)(event);
  };
};

/** ALF-006/EOTS-009: the link back to the span the event was published under, when it had one. */
const originLinks = (event: PublishedAny): ReadonlyArray<Tracer.SpanLink> =>
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
const isolate = (label: string, event: PublishedAny, run: Effect.Effect<void, unknown>) =>
  run.pipe(
    Effect.catchCause((cause) =>
      Observability.logObserverFailure(
        "auth.event.observer.error",
        // BEH-EA-104 (P20a, REQ-EA-275): the entry names the subscription as well as the event.
        { tag: event._tag, subscription: label },
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
  drain: (stream: Stream.Stream<PublishedAny>) => Effect.Effect<void>,
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
 * exactly this `Layer`'s own. `select` is one selector or an array (ESS-007): core
 * tags and/or event definitions (ADR-EA-049), mixed; one subscription, the handler
 * narrowed to the union of the selected events.
 */
export const on = <const S extends Select>(
  select: S,
  handler: (event: Handled<S>) => Effect.Effect<void, unknown>,
): Layer.Layer<never, never, AuthEvents> => {
  const isSelected = is(select);
  const label = labelOf(select);
  return Layer.effectDiscard(
    supervise(label, (stream) =>
      stream.pipe(
        Stream.filter(isSelected),
        Stream.runForEach((event) => isolate(label, event, handler(event))),
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
export const onBatch = <const S extends Select>(
  select: S,
  options: { readonly size: number; readonly within: Duration.Input },
  handler: (batch: ReadonlyArray<Handled<S>>) => Effect.Effect<void, unknown>,
): Layer.Layer<never, never, AuthEvents> => {
  const isSelected = is(select);
  const label = `batch:${labelOf(select)}`;
  return Layer.effectDiscard(
    supervise(label, (stream) =>
      stream.pipe(
        Stream.filter(isSelected),
        Stream.groupedWithin(options.size, options.within),
        Stream.runForEach((batch) => {
          const events = [...batch];
          const [head] = events;
          return head === undefined ? Effect.void : isolate(label, head, handler(events));
        }),
      ),
    ),
  );
};
