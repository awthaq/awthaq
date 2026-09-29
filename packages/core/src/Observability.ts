// @awthaq/core — Observability
//
// MW-001 (.issues/high), wayfinder ticket 27 (.scratch/resolve-ready-for-human-findings):
// the one place the library's own observability vocabulary lives — the
// fixed field names spans/logs are annotated with, the small metric
// taxonomy, and the one helper every observer-failure log site shares.
//
// The HTTP layer is *not* here: `HttpMiddleware.tracer`/`HttpMiddleware.logger`
// are re-exported from `@awthaq/server`'s `AuthHttp` (ticket 27 §1). What
// this module adds is what HTTP-layer tracing cannot see into — the plain
// `Effect`s below it (session verify, password verify, hook dispatch, event
// publish).
//
// Neutral on backends by design (ticket 27 §4, ADR-EA-027): the library
// ships metric *definitions* as plain `Metric` values, composable with
// `OtlpMetrics`/`PrometheusMetrics` by the host; it does not pick a sink.
//
// Nothing in this vocabulary may carry a credential: span attributes and
// log annotations hold ids, tags and outcomes only — never a `Redacted`
// value, a session secret, a token or a password (BEH-EA-199; the
// redaction-asserting Tracer/Logger in `@awthaq/test` checks exactly this).

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

/**
 * ADR-EA-027: the fixed annotation vocabulary for auth-domain spans and log
 * lines, mirroring the `http.*` convention `HttpMiddleware` already uses.
 * Applied through `Effect.annotateLogs`/`Effect.annotateCurrentSpan`, never
 * by interpolating into a message, so every field stays queryable.
 */
export const Field = Object.freeze({
  /** The event/operation name, e.g. `"session.issued"`, `"hook.observer.error"`. */
  event: "auth.event",
  /** The principal's opaque reference (a user/api-key id), never a name or email. */
  principalRef: "auth.principal.ref",
  principalType: "auth.principal.type",
  sessionId: "auth.session.id",
  /** `"success" | "failure"`. */
  outcome: "auth.outcome",
  /** Why an outcome was a failure — a fixed enum, never caller input. */
  reason: "auth.reason",
  correlationId: "auth.correlation_id",
  hook: "auth.hook",
  strategy: "auth.strategy",
});

/** Span names: `awthaq.<domain>.<operation>`. */
export const Span = Object.freeze({
  sessionVerify: "awthaq.session.verify",
  sessionIssue: "awthaq.session.issue",
  passwordVerify: "awthaq.password.verify",
  hookDispatch: "awthaq.hook.dispatch",
  eventPublish: "awthaq.event.publish",
  eventHandle: "awthaq.event.handle",
  principalResolve: "awthaq.principal.resolve",
});

/** JH-002: an observe tap failed (caught and logged; never seen by the operation it observes). */
export const hookObserverErrors = Metric.counter("awthaq_hook_observer_error_total", {
  description: "Observe-tap failures swallowed by HookPoint.observe",
  incremental: true,
});

/** EOTS-005: a subscriber's handler failed (caught and logged; never seen by the publisher). */
export const eventObserverErrors = Metric.counter("awthaq_event_observer_error_total", {
  description: "AuthEvents subscriber handler failures",
  incremental: true,
});

/** ticket 02: AuthEvents publishes the bounded bus dropped (the AuditLog row is never dropped). */
export const eventsDropped = Metric.counter("awthaq_event_dropped_total", {
  description: "AuthEvents publishes dropped from the in-process bus because it was at capacity",
  incremental: true,
});

/** ECF-010: how many `AuthEvents.on`/`onBatch` subscriptions currently have a live drain fiber. */
export const eventSubscriptionsActive = Metric.gauge("awthaq_event_subscriptions_active", {
  description: "Live AuthEvents subscription drain fibers",
});

/** ticket 27 §4: sessions minted, by `Sessions.issue` itself (every strategy). */
export const sessionsIssued = Metric.counter("awthaq_session_issued_total", {
  description: "Sessions issued",
  incremental: true,
});

/** ticket 27 §4: a presented session credential failed verification, tagged by a fixed `reason`. */
export const sessionVerifyFailures = Metric.counter("awthaq_session_verify_failed_total", {
  description: "Session verifications that failed, tagged by reason",
  incremental: true,
});

/** ticket 27 §4: a failed sign-in, tagged by `strategy`. */
export const loginFailures = Metric.counter("awthaq_login_failed_total", {
  description: "Failed sign-in attempts, tagged by strategy",
  incremental: true,
});

/** ticket 27 §4: how long `Sessions.verify` took (seconds), success or failure. */
export const sessionVerifyDuration = Metric.histogram("awthaq_session_verify_duration_seconds", {
  description: "Session verification latency in seconds",
  boundaries: Metric.exponentialBoundaries({ start: 0.001, factor: 2, count: 16 }),
});

/** CWM-004: events an `EventRelay` handed to its transport, tagged by relay name. */
export const relayDelivered = Metric.counter("awthaq_relay_delivered_total", {
  description: "Audit events delivered to an EventTransport by an EventRelay, tagged by relay",
  incremental: true,
});

/** CWM-004: a relay delivery attempt the transport failed (it is retried), tagged by relay name. */
export const relayFailures = Metric.counter("awthaq_relay_failures_total", {
  description: "EventRelay delivery attempts the transport failed, tagged by relay",
  incremental: true,
});

/** CSG-008: an incident raised by `SecuritySignals`, tagged by rule. */
export const securityIncidents = Metric.counter("awthaq_security_incident_total", {
  description: "Security incidents raised by SecuritySignals, tagged by rule",
  incremental: true,
});

/**
 * ticket 27 §2: a business-logic span. Attributes are restricted to
 * `string | number | boolean` on purpose — a `Redacted` value or a token
 * object does not type-check as an attribute, so a secret cannot reach a span
 * through this helper by accident (BEH-EA-199).
 */
export const authSpan = (
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.withSpan(name, { attributes }));

/**
 * ticket 27 §2/§4: what wraps `Sessions.verify` — its span, its latency histogram
 * and (per failure) `awthaq_session_verify_failed_total{reason}`. `reasonOf` maps
 * the caller's own error type to a fixed reason label (never caller input).
 */
export const observeSessionVerify =
  <E>(reasonOf: (error: E) => string) =>
  <A, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.tapError((error) =>
          Metric.update(
            Metric.withAttributes(sessionVerifyFailures, { reason: reasonOf(error) }),
            1,
          ),
        ),
        Effect.ensuring(
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            Metric.update(sessionVerifyDuration, (endedAt - startedAt) / 1000),
          ),
        ),
      );
    }).pipe(Effect.withSpan(Span.sessionVerify));

const MESSAGE_LIMIT = 200;

/**
 * EOTS-005: a sanitized one-line description of a failure — its tag and a
 * truncated message, never the error's data fields (which is where a token
 * or an identifier would ride). What an error-level log line may carry.
 */
export const describeFailure = (
  cause: Cause.Cause<unknown>,
): { readonly errorTag: string; readonly message: string } => {
  const error = Cause.squash(cause);
  const errorTag =
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : error instanceof Error
        ? error.name
        : "unknown";
  const message = error instanceof Error ? error.message.slice(0, MESSAGE_LIMIT) : "";
  return { errorTag, message };
};

/**
 * EOTS-005: the one shared log site for a failed observer (hook tap or event
 * subscriber). The stable `name` (BEH-EA-104) is logged at error level with
 * the sanitized summary and `context`; the full `Cause` is logged only at
 * debug level, where an operator has opted in to seeing raw payloads.
 */
export const logObserverFailure = (
  name: string,
  context: Readonly<Record<string, string>>,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logError(name, { ...context, ...describeFailure(cause) }).pipe(
    Effect.andThen(Effect.logDebug(name, { ...context, cause })),
  );
