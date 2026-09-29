// MW-001 (.issues/high), wayfinder ticket 27: business-logic spans, the field
// vocabulary and the metric taxonomy — asserted against a recording tracer, with the
// invariant that no span attribute ever carries a secret (BEH-EA-199).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as HookPoint from "../src/HookPoint.ts";
import * as Observability from "../src/Observability.ts";
import * as Sessions from "../src/Sessions.ts";
import { UserId } from "../src/Users.ts";

const userId = UserId("11111111-1111-1111-1111-111111111111");

/** A tracer that keeps every span it creates (delegating to the default one), so tests read them afterwards. */
const recordingTracer = () => {
  const spans: Array<Tracer.Span> = [];
  const base = Tracer.Tracer.defaultValue();
  const layer = Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span: (options) => {
        const span = base.span(options);
        spans.push(span);
        return span;
      },
    }),
  );
  const named = (name: string) => spans.filter((span) => span.name === name);
  return { layer, spans, named };
};

const attributeValues = (spans: ReadonlyArray<Tracer.Span>): ReadonlyArray<string> =>
  spans.flatMap((span) => [...span.attributes.values()].map((value) => String(value)));

const Live = Sessions.layerMemory.pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

describe("Observability (ticket 27)", () => {
  it.effect(
    "Sessions.verify emits one awthaq.session.verify span with the session id and no secret",
    () => {
      const tracer = recordingTracer();
      return Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { session, token } = yield* sessions.issue({ userId });
        yield* sessions.verify(token);
        const [span] = tracer.named(Observability.Span.sessionVerify);
        assert.strictEqual(tracer.named(Observability.Span.sessionVerify).length, 1);
        assert.strictEqual(span?.attributes.get(Observability.Field.sessionId), session.id);
        const secret = Redacted.value(token).slice(session.id.length + 1);
        assert.isFalse(attributeValues(tracer.spans).some((value) => value.includes(secret)));
        // The issue span exists too, with the same id.
        const [issued] = tracer.named(Observability.Span.sessionIssue);
        assert.strictEqual(issued?.attributes.get(Observability.Field.sessionId), session.id);
      }).pipe(Effect.provide(Live.pipe(Layer.provideMerge(tracer.layer))));
    },
  );

  it.effect(
    "a failed verify increments awthaq_session_verify_failed_total with a fixed reason",
    () => {
      const counter = Metric.withAttributes(Observability.sessionVerifyFailures, {
        reason: "not-found",
      });
      return Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const before = (yield* Metric.value(counter)).count;
        const { session } = yield* sessions.issue({ userId });
        yield* sessions.verify(Redacted.make(`${session.id}.wrong-secret`)).pipe(Effect.ignore);
        yield* sessions.verify(Redacted.make("not-even-shaped-like-a-token")).pipe(Effect.ignore);
        assert.strictEqual((yield* Metric.value(counter)).count - before, 2);
      }).pipe(Effect.provide(Live));
    },
  );

  it.effect("an attacker-supplied, oversized id never reaches a span attribute", () => {
    const tracer = recordingTracer();
    return Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const hostile = "x".repeat(500);
      yield* sessions.verify(Redacted.make(`${hostile}.secret`)).pipe(Effect.ignore);
      const [span] = tracer.named(Observability.Span.sessionVerify);
      assert.isFalse(span?.attributes.has(Observability.Field.sessionId) ?? true);
    }).pipe(Effect.provide(Live.pipe(Layer.provideMerge(tracer.layer))));
  });

  it.effect(
    "issuing a session counts awthaq_session_issued_total once, at the event choke point",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const before = (yield* Metric.value(Observability.sessionsIssued)).count;
        yield* sessions.issue({ userId });
        assert.strictEqual((yield* Metric.value(Observability.sessionsIssued)).count - before, 1);
      }).pipe(Effect.provide(Live)),
  );

  it.effect(
    "AuthEvents.publish is an awthaq.event.publish span naming the event tag, and a failed sign-in is counted",
    () => {
      const tracer = recordingTracer();
      const failures = Metric.withAttributes(Observability.loginFailures, { strategy: "password" });
      return Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        const before = (yield* Metric.value(failures)).count;
        yield* events.publish({
          _tag: "auth.user.signInFailed",
          strategy: "password",
          reason: "invalidCredentials",
        });
        const [span] = tracer.named(Observability.Span.eventPublish);
        assert.strictEqual(
          span?.attributes.get(Observability.Field.event),
          "auth.user.signInFailed",
        );
        assert.strictEqual((yield* Metric.value(failures)).count - before, 1);
      }).pipe(
        Effect.provide(
          AuthEvents.layer.pipe(
            Layer.provideMerge(AuditLog.layerMemory),
            Layer.provideMerge(tracer.layer),
          ),
        ),
      );
    },
  );

  it.effect("a hook dispatch is an awthaq.hook.dispatch span naming the hook", () => {
    class AfterThing extends HookPoint.observe<AfterThing>()("auth.test.thing", Schema.String) {}
    const tracer = recordingTracer();
    return Effect.gen(function* () {
      const point = yield* AfterThing;
      yield* point.run("x");
      const [span] = tracer.named(Observability.Span.hookDispatch);
      assert.strictEqual(
        span?.attributes.get(Observability.Field.hook),
        "awthaq/hook/auth.test.thing",
      );
    }).pipe(Effect.provide(AfterThing.layer.pipe(Layer.provideMerge(tracer.layer))));
  });
});
