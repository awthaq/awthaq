// CSG-008: `SecuritySignals`, the opt-in detector over the security event tags. Windows slide over
// the envelope's `occurredAt`, so `TestClock` drives them and nothing here waits.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as SecuritySignals from "../src/SecuritySignals.ts";
import * as Sessions from "../src/Sessions.ts";
import * as Users from "../src/Users.ts";

const alice = Users.UserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const bob = Users.UserId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

/** Lets the subscription drain what was just published. */
const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });

/** A sink that records every incident it is handed. */
const recordingSink = Effect.gen(function* () {
  const incidents = yield* Ref.make<ReadonlyArray<SecuritySignals.Incident>>([]);
  const sink: SecuritySignals.IncidentSinkShape = {
    report: (incident) => Ref.update(incidents, (all) => [...all, incident]),
  };
  return { incidents: Ref.get(incidents), sink };
});

const run = <A, E>(
  body: (
    events: AuthEvents.AuthEventsShape,
    incidents: Effect.Effect<ReadonlyArray<SecuritySignals.Incident>>,
  ) => Effect.Effect<A, E>,
  options?: {
    readonly settings?: Partial<SecuritySignals.SecuritySignalsConfigShape>;
    readonly sink?: SecuritySignals.IncidentSinkShape;
  },
) =>
  Effect.gen(function* () {
    const recorder = yield* recordingSink;
    const incidents = recorder.incidents;
    const sinkLayer = Layer.succeed(SecuritySignals.IncidentSink, options?.sink ?? recorder.sink);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        yield* Layer.build(
          SecuritySignals.layer.pipe(
            Layer.provide(SecuritySignals.config(options?.settings ?? {})),
            Layer.provide(sinkLayer),
          ),
        );
        return yield* body(events, incidents);
      }).pipe(Effect.provide(AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory)))),
    );
  });

describe("SecuritySignals", () => {
  it.effect(
    "a single passkey counter anomaly raises a high-severity incident naming the credential",
    () =>
      run((events, incidents) =>
        Effect.gen(function* () {
          yield* events.publish({
            _tag: "auth.passkey.counterAnomaly",
            userId: alice,
            credentialId: "cred-1",
          });
          yield* settle;
          const [incident, ...rest] = yield* incidents;
          assert.strictEqual(rest.length, 0);
          assert.strictEqual(incident?.rule, "passkey.counterAnomaly");
          assert.strictEqual(incident?.severity, "high");
          assert.strictEqual(incident?.subject, "cred-1");
          assert.strictEqual(incident?.count, 1);
        }),
      ),
  );

  it.effect("a session reuse raises an incident for that user", () =>
    run((events, incidents) =>
      Effect.gen(function* () {
        yield* events.publish({
          _tag: "auth.session.reuse",
          sessionId: Sessions.SessionId("s-1"),
          familyId: "fam",
          userId: alice,
        });
        yield* settle;
        assert.deepStrictEqual(
          (yield* incidents).map((i) => [i.rule, i.subject]),
          [["session.reuse", alice]],
        );
      }),
    ),
  );

  it.effect(
    "N token replays for one identifier inside the window raise one incident, N-1 do not, and it never names the identifier",
    () =>
      run((events, incidents) =>
        Effect.gen(function* () {
          const replay = events.publish({
            _tag: "auth.token.replay",
            identifier: "reset:me@example.com",
          });
          for (let i = 0; i < 4; i += 1) yield* replay;
          yield* settle;
          assert.strictEqual((yield* incidents).length, 0);

          yield* replay;
          yield* settle;
          const raised = yield* incidents;
          assert.strictEqual(raised.length, 1);
          assert.strictEqual(raised[0]?.rule, "token.replay");
          assert.strictEqual(raised[0]?.count, 5);
          assert.isUndefined(raised[0]?.subject);
          assert.notInclude(JSON.stringify(raised), "me@example.com");
        }),
      ),
  );

  it.effect("events spread past the window do not add up; a different key is its own bucket", () =>
    run((events, incidents) =>
      Effect.gen(function* () {
        const replay = (identifier: string) =>
          events.publish({ _tag: "auth.token.replay", identifier });
        for (let i = 0; i < 4; i += 1) {
          yield* replay("a");
          yield* TestClock.adjust(Duration.minutes(4));
        }
        // 4 events, but only ~2 fit any 10-minute window; and 4 more for another identifier stay below N
        for (let i = 0; i < 4; i += 1) yield* replay("b");
        yield* settle;
        assert.strictEqual((yield* incidents).length, 0);
      }),
    ),
  );

  it.effect("a sustained attack raises an incident per threshold events, not one per event", () =>
    run((events, incidents) =>
      Effect.gen(function* () {
        for (let i = 0; i < 10; i += 1) {
          yield* events.publish({ _tag: "auth.token.replay", identifier: "x" });
        }
        yield* settle;
        assert.strictEqual((yield* incidents).length, 2);
      }),
    ),
  );

  it.effect(
    "failed sign-ins are counted per source address and per identifier digest, independently",
    () =>
      run((events, incidents) =>
        Effect.gen(function* () {
          const fail = (clientIp: string, identifierDigest: string) =>
            events.publish({
              _tag: "auth.user.signInFailed",
              strategy: "password",
              reason: "invalidCredentials",
              clientIp,
              identifierDigest,
            });
          // 5 attempts against one identifier from 5 different addresses: the digest rule fires, the address rule does not
          for (let i = 0; i < 5; i += 1) yield* fail(`198.51.100.${i}`, "digest-1");
          yield* settle;
          assert.deepStrictEqual(
            (yield* incidents).map((i) => [i.rule, i.subject]),
            [["signIn.failedByIdentifier", "digest-1"]],
          );
          // 10 attempts from one address against 10 identifiers: the address rule fires
          for (let i = 0; i < 10; i += 1) yield* fail("203.0.113.7", `digest-other-${i}`);
          yield* settle;
          assert.deepStrictEqual(
            (yield* incidents).map((i) => i.rule),
            ["signIn.failedByIdentifier", "signIn.failedByAddress"],
          );
        }),
      ),
  );

  it.effect("impersonation denials are counted per admin", () =>
    run((events, incidents) =>
      Effect.gen(function* () {
        const deny = (adminUserId: Users.UserId) =>
          events.publish({
            _tag: "auth.admin.impersonationDenied",
            adminUserId,
            operation: "impersonate",
          });
        yield* deny(alice);
        yield* deny(bob);
        yield* deny(alice);
        yield* deny(bob);
        yield* settle;
        assert.strictEqual((yield* incidents).length, 0);
        yield* deny(alice);
        yield* settle;
        assert.deepStrictEqual(
          (yield* incidents).map((i) => [i.rule, i.subject, i.severity]),
          [["admin.impersonationDenied", alice, "high"]],
        );
      }),
    ),
  );

  it.effect("rules are configurable: a custom rule replaces the defaults", () =>
    run(
      (events, incidents) =>
        Effect.gen(function* () {
          // the default rules are gone: a reuse no longer raises anything
          yield* events.publish({
            _tag: "auth.session.reuse",
            sessionId: Sessions.SessionId("s-1"),
            familyId: "f",
            userId: alice,
          });
          yield* events.publish({ _tag: "auth.token.replay", identifier: "one" });
          yield* events.publish({ _tag: "auth.token.replay", identifier: "one" });
          yield* settle;
          assert.deepStrictEqual(
            (yield* incidents).map((i) => [i.rule, i.count]),
            [["quick", 2]],
          );
        }),
      {
        settings: {
          rules: [
            SecuritySignals.rule({
              id: "quick",
              severity: "medium",
              tag: "auth.token.replay",
              key: (event) => Option.some(event.identifier),
              threshold: 2,
              window: Duration.minutes(1),
            }),
          ],
        },
      },
    ),
  );

  it.effect(
    "an incident is logged and counted even with no sink, and a failing sink never stops detection",
    () => {
      const logged: Array<string> = [];
      const capture = Logger.layer([
        Logger.make((options) => {
          logged.push(String(options.message));
        }),
      ]);
      return run(
        (events, incidents) =>
          Effect.gen(function* () {
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: alice,
              credentialId: "c-1",
            });
            yield* settle;
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: alice,
              credentialId: "c-2",
            });
            yield* settle;
            // the sink threw both times, yet both incidents were logged
            assert.strictEqual(
              logged.filter((m) => m.includes("auth.security.incident")).length,
              2,
            );
            assert.strictEqual((yield* incidents).length, 0);
          }),
        { sink: { report: () => Effect.die(new Error("pager is down")) } },
      ).pipe(Effect.provide(capture));
    },
  );

  it.effect(
    "the bucket table is bounded: the least recently seen bucket is dropped past maxBuckets",
    () => {
      const sequence = (events: AuthEvents.AuthEventsShape) =>
        Effect.gen(function* () {
          const replay = (identifier: string) =>
            Effect.andThen(
              events.publish({ _tag: "auth.token.replay", identifier }),
              TestClock.adjust(Duration.millis(1)),
            );
          // `a` once, then two other identifiers, then `a` four more times: five in all
          yield* replay("a");
          yield* replay("b");
          yield* replay("c");
          for (let i = 0; i < 4; i += 1) yield* replay("a");
          yield* settle;
        });
      return Effect.gen(function* () {
        const capped = yield* run(
          (events, incidents) => Effect.andThen(sequence(events), incidents),
          { settings: { maxBuckets: 2 } },
        );
        const uncapped = yield* run((events, incidents) =>
          Effect.andThen(sequence(events), incidents),
        );
        // with room for every bucket the five `a` events add up; with two slots the first was evicted
        assert.strictEqual(uncapped.length, 1);
        assert.strictEqual(capped.length, 0);
      });
    },
  );
});
