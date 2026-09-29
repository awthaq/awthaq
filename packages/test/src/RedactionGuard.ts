// @awthaq/test — RedactionGuard
//
// spec/behaviors/25-testing-harness.md, BEH-EA-199; EOTS-002/SMS-003
// (.issues/high, medium), wayfinder ticket 27 §5: the tracer/logger
// interceptor that makes "no `Redacted` value reaches a span, a log line or a
// published event" a mechanical check instead of a review discipline.
//
// One layer installs three recorders in the composition it is provided to:
//
// - a `Tracer` that wraps Effect's default tracer, so spans still work and
//   every attribute/event a span receives is inspected;
// - a `Logger`, merged with the existing loggers, that inspects every log
//   message, annotation and cause;
// - (`layerEvents`) a subscriber that inspects every event published on
//   `AuthEvents` — the same payloads the durable audit row stores.
//
// A value leaks when it is a `Redacted` instance anywhere in the inspected
// structure (BEH-EA-199's own statement: a `Redacted` must never reach these
// channels, wrapped or not), or when a string contains a **canary**: a known
// secret the test registered with `guard.watch(label, secret)` — the plaintext
// copy a `Redacted.value(...)` unwrapped into a span attribute or an
// interpolated log message. Canary matching is what catches the leak the
// `Redacted` wrapper cannot: the wrapper is only as good as the last `.value`.
//
// The guard never prints a secret: a `Leak` names the channel, the path inside
// the value and the canary's *label*.

import { Defects } from "@awthaq/ports";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { AuthEvents } from "@awthaq/core";

export type Channel =
  | "span attribute"
  | "span event"
  | "log message"
  | "log annotation"
  | "log cause"
  | "event";

export interface Leak {
  readonly channel: Channel;
  /** Where inside the inspected value, e.g. `password` or `[0].token`. */
  readonly path: string;
  /** What was found: a `Redacted` instance, or the label of the canary secret that appeared. */
  readonly found: string;
  /** The span/log/event it was in (a span name, a log level, an event tag) — never a value. */
  readonly source: string;
}

/** BEH-EA-199: a `Redacted` value or a watched secret reached a span, log line or event. */
export class RedactionLeak extends Data.TaggedError("RedactionLeak")<{
  readonly leaks: ReadonlyArray<Leak>;
  readonly message: string;
}> {}

export interface RedactionGuardShape {
  /** Registers a canary: from now on, any inspected string containing `secret` is a leak reported under `label`. */
  readonly watch: (label: string, secret: string) => Effect.Effect<void>;
  /** Inspects a published event's payload (what `layerEvents` calls per event; also usable directly). */
  readonly inspectEvent: (tag: string, payload: unknown) => Effect.Effect<void>;
  /** Everything found so far. */
  readonly leaks: Effect.Effect<ReadonlyArray<Leak>>;
  /** Fails with `RedactionLeak` when anything was found. */
  readonly assertNoLeaks: Effect.Effect<void, RedactionLeak>;
}

export class RedactionGuard extends Context.Service<RedactionGuard, RedactionGuardShape>()(
  "awthaq/test/RedactionGuard",
) {}

/** A canary shorter than this would match by accident (a two-letter password inside any word). */
const MIN_CANARY_LENGTH = 6;

const MAX_DEPTH = 8;

interface Recorder {
  readonly canaries: Map<string, string>;
  readonly found: Array<Leak>;
}

/** Walks `value`, reporting every `Redacted` instance and every string that contains a canary. */
const inspect = (
  recorder: Recorder,
  channel: Channel,
  source: string,
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  depth: number,
): void => {
  const report = (found: string) => recorder.found.push({ channel, path, found, source });
  if (Redacted.isRedacted(value)) {
    report("Redacted instance");
    return;
  }
  if (typeof value === "string") {
    for (const [label, secret] of recorder.canaries) {
      if (value.includes(secret)) report(`canary "${label}"`);
    }
    return;
  }
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Cause.isCause(value)) {
    inspect(recorder, channel, source, Cause.pretty(value), `${path}(cause)`, seen, depth + 1);
    return;
  }
  if (value instanceof Error) {
    inspect(recorder, channel, source, value.message, `${path}.message`, seen, depth + 1);
    inspect(recorder, channel, source, value.stack ?? "", `${path}.stack`, seen, depth + 1);
    inspect(recorder, channel, source, value.cause, `${path}.cause`, seen, depth + 1);
    // Fall through: an error's own data fields (a `TaggedError`'s payload) are inspected too.
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      inspect(recorder, channel, source, item, `${path}.${String(key)}`, seen, depth + 1);
    }
    return;
  }
  const entries: Iterable<readonly [string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [`[${index}]`, item] as const)
    : Object.entries(value).map(([key, item]) => [`.${key}`, item] as const);
  for (const [key, item] of entries) {
    inspect(recorder, channel, source, item, `${path}${key}`, seen, depth + 1);
  }
};

const scan = (recorder: Recorder, channel: Channel, source: string, value: unknown, path = "") =>
  inspect(recorder, channel, source, value, path, new WeakSet(), 0);

/** A span that forwards to `inner` and inspects every attribute and event it receives. */
const recordingSpan = (recorder: Recorder, inner: Tracer.Span): Tracer.Span => ({
  _tag: "Span",
  name: inner.name,
  spanId: inner.spanId,
  traceId: inner.traceId,
  parent: inner.parent,
  annotations: inner.annotations,
  get status() {
    return inner.status;
  },
  get attributes() {
    return inner.attributes;
  },
  links: inner.links,
  sampled: inner.sampled,
  kind: inner.kind,
  end: (endTime, exit) => {
    // Attributes set at creation never pass through `attribute`, so look once more at the end.
    for (const [key, value] of inner.attributes) {
      scan(recorder, "span attribute", inner.name, value, key);
    }
    inner.end(endTime, exit);
  },
  attribute: (key, value) => {
    scan(recorder, "span attribute", inner.name, value, key);
    inner.attribute(key, value);
  },
  event: (name, startTime, attributes) => {
    scan(recorder, "span event", inner.name, attributes, name);
    inner.event(name, startTime, attributes);
  },
  addLinks: (links) => {
    inner.addLinks(links);
  },
});

const makeGuard = (recorder: Recorder): RedactionGuardShape => {
  const leaks = Effect.sync(() => [...recorder.found]);
  return {
    watch: (label, secret) =>
      secret.length < MIN_CANARY_LENGTH
        ? Defects.invalidConfiguration(
            "RedactionGuard.watch",
            `awthaq/test: canary "${label}" is shorter than ${MIN_CANARY_LENGTH} characters and would match by accident`,
          )
        : Effect.sync(() => {
            recorder.canaries.set(label, secret);
          }),
    inspectEvent: (tag, payload) => Effect.sync(() => scan(recorder, "event", tag, payload)),
    leaks,
    assertNoLeaks: Effect.flatMap(leaks, (found) =>
      found.length === 0
        ? Effect.void
        : Effect.fail(
            new RedactionLeak({
              leaks: found,
              message: `BEH-EA-199: ${found.length} value(s) reached an observability channel: ${found
                .map(
                  (leak) =>
                    `${leak.found} in ${leak.channel} of "${leak.source}"${leak.path === "" ? "" : ` at ${leak.path}`}`,
                )
                .join("; ")}`,
            }),
          ),
    ),
  };
};

/**
 * Provides `RedactionGuard` and installs its tracer and logger into the composition:
 * every span and log line the composition emits is inspected. Idempotent per build.
 */
export const layer = Layer.unwrap(
  Effect.sync(() => {
    const recorder: Recorder = { canaries: new Map(), found: [] };
    const base = Tracer.Tracer.defaultValue();
    const tracer = Tracer.make({
      span: (options) => recordingSpan(recorder, base.span(options)),
      ...(base.context === undefined ? {} : { context: base.context }),
    });
    const logger = Logger.make((options) => {
      const level = options.logLevel;
      scan(recorder, "log message", level, options.message);
      scan(
        recorder,
        "log annotation",
        level,
        options.fiber.getRef(References.CurrentLogAnnotations),
      );
      scan(recorder, "log cause", level, options.cause);
    });
    return Layer.mergeAll(
      Layer.succeed(RedactionGuard, RedactionGuard.of(makeGuard(recorder))),
      Layer.succeed(Tracer.Tracer, tracer),
      Logger.layer([logger], { mergeWithExisting: true }),
    );
  }),
);

/** Also inspects every event published on `AuthEvents` — the payload the durable audit row stores. */
export const layerEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const guard = yield* RedactionGuard;
    const events = yield* AuthEvents.AuthEvents;
    const stream = yield* events.subscribe;
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (event) =>
        guard.inspectEvent(event._tag, AuthEvents.payloadOf(event)),
      ),
    );
  }),
);
