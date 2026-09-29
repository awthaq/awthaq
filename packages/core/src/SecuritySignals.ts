// @awthaq/core — SecuritySignals
//
// CSG-008: the library publishes its breach-detection signals (a refresh-token
// reuse, a signature-counter regression, a burst of token replays, repeated
// failed sign-ins, denied impersonation attempts) and persists them, but nothing
// *detected* on them — a signal without a pipeline is a log nobody reads. This is
// that pipeline, opt-in (`SecuritySignals.layer`, like `Retention.layerScheduled`):
// one subscription over the security tags, a sliding-window counter per
// (rule, key), and an incident when a rule's threshold is reached inside its window.
//
// An incident is reported three ways, none of which can fail the operation that
// caused it: a `warning` log named `auth.security.incident`, the counter
// `awthaq_security_incident_total{rule}`, and the `IncidentSink` port — a
// `Context.Reference` defaulting to a no-op that an application backs with a table,
// a pager or a SIEM. A sink that fails is logged, never fatal: detection outlives
// its outlet.
//
// Windows slide over the envelope's own `occurredAt`, so a `TestClock` controls
// them; after an incident a bucket restarts, so a sustained attack raises one
// incident per `threshold` events rather than one per event. The bucket table is
// bounded (`maxBuckets`): expired buckets go first, then the least recently seen.
//
// Incidents carry ids and counts, never a credential: the subject is a user id, a
// credential id, an admin id, a keyed identifier digest or the source address — and
// `token.replay` omits it altogether (its identifier can be a mailbox).
//
// Delivery is the bus's at-most-once: a burst dropped at capacity is not counted, so
// this is a detector, not an audit (the durable trail is `AuditLog`).

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AuthEventTag, Published } from "./AuthEventSchemas.ts";
import * as AuthEvents from "./AuthEvents.ts";
import * as Observability from "./Observability.ts";

export type Severity = "medium" | "high";

/** One detection rule: `tags` are counted under `key(event)` and an incident is raised at `threshold` events inside `window`. */
export interface SignalRule {
  /** Stable id: the metric's `rule` label and the incident's `rule`. */
  readonly id: string;
  readonly severity: Severity;
  readonly tags: ReadonlyArray<AuthEventTag>;
  /** The bucket an event counts under (`None`: this event does not count for the rule). Also the incident's `subject` when `reportSubject`. */
  readonly key: (event: Published) => Option.Option<string>;
  /** Whether the incident names the bucket key. `false` when the key may be personal data (a mailbox). */
  readonly reportSubject: boolean;
  readonly threshold: number;
  readonly window: Duration.Duration;
}

/** What an `IncidentSink` receives. */
export interface Incident {
  readonly rule: string;
  readonly severity: Severity;
  /** How many events the rule counted inside its window. */
  readonly count: number;
  readonly windowMillis: number;
  readonly detectedAt: DateTime.Utc;
  /** The user, credential, admin, digest or address the incident is about; absent when the rule does not report one. */
  readonly subject?: string;
  /** The event that tipped the threshold, so a sink can link back to the audit row (`AuditLog` id === `eventId`). */
  readonly eventId: string;
}

export interface IncidentSinkShape {
  readonly report: (incident: Incident) => Effect.Effect<void, unknown>;
}

/** The outlet an application backs (a table, a pager, a SIEM). Defaults to nothing: the log line and the metric are always emitted. */
export const IncidentSink = Context.Reference<IncidentSinkShape>("awthaq/core/IncidentSink", {
  defaultValue: () => ({ report: () => Effect.void }),
});

export interface SecuritySignalsConfigShape {
  readonly rules: ReadonlyArray<SignalRule>;
  /** Upper bound on live (rule, key) buckets; expired ones go first, then the least recently seen. */
  readonly maxBuckets: number;
}

/** A rule over one event tag, keyed by a field of that event: no assertion, the selector is typed to the tag. */
export const rule = <const Tag extends AuthEventTag>(input: {
  readonly id: string;
  readonly severity: Severity;
  readonly tag: Tag;
  readonly key: (event: Extract<Published, { readonly _tag: Tag }>) => Option.Option<string>;
  readonly reportSubject?: boolean;
  readonly threshold: number;
  readonly window: Duration.Duration;
}): SignalRule => {
  const isTag = (event: Published): event is Extract<Published, { readonly _tag: Tag }> =>
    event._tag === input.tag;
  return {
    id: input.id,
    severity: input.severity,
    tags: [input.tag],
    key: (event) => (isTag(event) ? input.key(event) : Option.none()),
    reportSubject: input.reportSubject ?? true,
    threshold: input.threshold,
    window: input.window,
  };
};

/**
 * The documented defaults. The numbers are a starting policy, not a universal truth; replace
 * the list with `SecuritySignals.config({ rules })` (or extend `defaultRules`).
 */
export const defaultRules: ReadonlyArray<SignalRule> = [
  // A superseded refresh token presented again: the family is already revoked, and someone holds a stolen copy.
  rule({
    id: "session.reuse",
    severity: "high",
    tag: "auth.session.reuse",
    key: (event) => Option.some(event.userId),
    threshold: 1,
    window: Duration.hours(1),
  }),
  // A passkey's signature counter went backwards: a possibly cloned authenticator.
  rule({
    id: "passkey.counterAnomaly",
    severity: "high",
    tag: "auth.passkey.counterAnomaly",
    key: (event) => Option.some(event.credentialId),
    threshold: 1,
    window: Duration.hours(1),
  }),
  // Repeated replays of one verification identifier: token guessing or a leaked link being hammered.
  rule({
    id: "token.replay",
    severity: "medium",
    tag: "auth.token.replay",
    key: (event) => Option.some(event.identifier),
    reportSubject: false,
    threshold: 5,
    window: Duration.minutes(10),
  }),
  // Many failures from one address: credential stuffing.
  rule({
    id: "signIn.failedByAddress",
    severity: "medium",
    tag: "auth.user.signInFailed",
    key: (event) => Option.fromNullishOr(event.clientIp),
    threshold: 10,
    window: Duration.minutes(10),
  }),
  // Many failures against one identifier (keyed digest, no oracle): brute force on one account.
  rule({
    id: "signIn.failedByIdentifier",
    severity: "medium",
    tag: "auth.user.signInFailed",
    key: (event) => Option.fromNullishOr(event.identifierDigest),
    threshold: 5,
    window: Duration.minutes(10),
  }),
  // An admin repeatedly refused impersonation: a compromised or curious admin account.
  rule({
    id: "admin.impersonationDenied",
    severity: "high",
    tag: "auth.admin.impersonationDenied",
    key: (event) => Option.some(event.adminUserId),
    threshold: 3,
    window: Duration.minutes(10),
  }),
];

export const SecuritySignalsConfig = Context.Reference<SecuritySignalsConfigShape>(
  "awthaq/core/SecuritySignalsConfig",
  { defaultValue: () => ({ rules: defaultRules, maxBuckets: 10_000 }) },
);

export const config = (partial: Partial<SecuritySignalsConfigShape>) =>
  Layer.succeed(SecuritySignalsConfig, { rules: defaultRules, maxBuckets: 10_000, ...partial });

interface Bucket {
  /** Epoch millis of the events still inside the window. */
  readonly times: ReadonlyArray<number>;
  readonly lastSeen: number;
}

const bucketKey = (ruleId: string, key: string): string => `${ruleId}\u0000${key}`;

/** Drops buckets whose newest event is older than `windowMillis`, then the least recently seen, until at most `max` remain. */
const bounded = (
  buckets: ReadonlyMap<string, Bucket>,
  now: number,
  windowFor: (bucket: string) => number,
  max: number,
): ReadonlyMap<string, Bucket> => {
  if (buckets.size <= max) return buckets;
  const live = [...buckets].filter(([name, bucket]) => now - bucket.lastSeen <= windowFor(name));
  const kept =
    live.length <= max
      ? live
      : live.toSorted((a, b) => b[1].lastSeen - a[1].lastSeen).slice(0, max);
  return new Map(kept);
};

/**
 * Opt-in: subscribes (race-free, while the layer builds) to every tag a configured rule names and
 * raises incidents. Requires only `AuthEvents`; provide `SecuritySignals.config` to change the
 * rules and an `IncidentSink` to receive incidents.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* SecuritySignalsConfig;
    const sink = yield* IncidentSink;
    const buckets = yield* Ref.make<ReadonlyMap<string, Bucket>>(new Map());
    const byId = new Map(settings.rules.map((r) => [r.id, r] as const));
    const tags = [...new Set(settings.rules.flatMap((r) => r.tags))];
    const windowFor = (name: string): number => {
      const found = byId.get(name.split("\u0000")[0] ?? "");
      return found === undefined ? 0 : Duration.toMillis(found.window);
    };

    const raise = (rule: SignalRule, incident: Incident) =>
      Effect.all(
        [
          Effect.logWarning("auth.security.incident", {
            rule: incident.rule,
            severity: incident.severity,
            count: incident.count,
            windowMillis: incident.windowMillis,
            eventId: incident.eventId,
            ...(incident.subject === undefined ? {} : { subject: incident.subject }),
          }),
          Metric.update(
            Metric.withAttributes(Observability.securityIncidents, { rule: rule.id }),
            1,
          ),
          sink
            .report(incident)
            .pipe(
              Effect.catchCause((cause) =>
                Observability.logObserverFailure(
                  "auth.security.sink.error",
                  { rule: rule.id },
                  cause,
                ),
              ),
            ),
        ],
        { discard: true },
      );

    const observe = (event: Published) =>
      Effect.forEach(
        settings.rules.filter((r) => r.tags.some((tag) => tag === event._tag)),
        (r) =>
          Option.match(r.key(event), {
            onNone: () => Effect.void,
            onSome: (key) =>
              Effect.gen(function* () {
                const now = DateTime.toEpochMillis(event.occurredAt);
                const windowMillis = Duration.toMillis(r.window);
                const name = bucketKey(r.id, key);
                const count = yield* Ref.modify(buckets, (current) => {
                  const previous = current.get(name)?.times ?? [];
                  const times = [...previous.filter((at) => now - at < windowMillis), now];
                  const next = new Map(current);
                  if (times.length >= r.threshold) {
                    // The incident consumes the bucket: a sustained attack re-raises per `threshold` events.
                    next.delete(name);
                    return [times.length, next] as const;
                  }
                  next.set(name, { times, lastSeen: now });
                  return [0, bounded(next, now, windowFor, settings.maxBuckets)] as const;
                });
                if (count === 0) return;
                yield* raise(r, {
                  rule: r.id,
                  severity: r.severity,
                  count,
                  windowMillis,
                  detectedAt: event.occurredAt,
                  eventId: event.eventId,
                  ...(r.reportSubject ? { subject: key } : {}),
                });
              }),
          }),
        { discard: true },
      );

    return AuthEvents.on(tags, observe);
  }),
);
