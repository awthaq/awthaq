// ESS-008: the steps of 13-events.feature (BEH-EA-097 through BEH-EA-104), against the real
// `AuthEvents`/`AuditLog` in `EventsWorld.ts`. Every Then asserts something the bus would fail
// to deliver if the guarantee broke. The mutation check for what ESS-001 exists to catch
// (`PubSub.dropping` reverted to `PubSub.bounded`) is that the publisher-never-awaits
// scenarios park their publisher at event CAPACITY + 1 and fail on the poll below.
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  errorLogsNamed,
  getProbe,
  letSubscribersRun,
  publish,
  releaseAndDrain,
  signIn,
  signUpUser,
  subscribe,
  subscribeStalled,
  userIdOf,
  World,
  capturedLogs,
} from "./EventsWorld.ts";

/** The registry's declared tags, read off the closed union the schema is built from (BEH-EA-101). */
const registryTags = AuthEvents.AuthEventSchema.members.map((member) => {
  const literal = member.fields._tag.ast.literal;
  if (typeof literal !== "string") throw new Error("an event's _tag is not a string literal");
  return literal;
});

const isRegistryTag = (tag: string): tag is AuthEvents.AuthEventTag =>
  registryTags.some((declared) => declared === tag);

/** A Gherkin-named tag must be one the registry declares; anything else is a typo in the scenario, not a reason to pass. */
const tagNamed = (tag: string): AuthEvents.AuthEventTag => {
  if (!isRegistryTag(tag)) throw new Error(`"${tag}" is not a declared AuthEvents tag`);
  return tag;
};

const replay = (identifier: string): AuthEvents.AuthEvent => ({
  _tag: "auth.token.replay",
  identifier,
});

/** Fixed ids for events a scenario publishes directly (the bus does not care whose they are). */
const someUser = Users.UserId("00000000-0000-4000-8000-000000000001");

const auditRows = Effect.gen(function* () {
  const { host } = yield* World;
  return yield* host.run(Effect.flatMap(AuditLog.AuditLog, (log) => log.list()).pipe(Effect.orDie));
});

const CAPACITY = AuthEvents.CAPACITY;

export const eventsSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-097: a bounded PubSub ----

  Given("the {string} service", function* (name: string) {
    assert.equal(name, "AuthEvents", `unknown service "${name}"`);
    const { host } = yield* World;
    yield* host.run(AuthEvents.AuthEvents);
  });

  When("its underlying {string} is inspected", function* (what: string) {
    assert.equal(what, "PubSub", `unknown thing to inspect: "${what}"`);
    // The bus's capacity is not a property the service exposes; it is observable as the point at
    // which a stalled subscriber's backlog stops growing and `publish` starts dropping. So probe
    // it: stall one subscriber, then publish until the first drop (bounded at twice the
    // configured capacity, so an unbounded bus ends the probe instead of hanging it).
    const { host, capacity } = yield* World;
    yield* subscribeStalled("probe");
    const outcome = yield* host.run(
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        let published = 0;
        while (published < CAPACITY * 2 && (yield* events.droppedCount) === 0) {
          yield* events.publish(replay(`probe:${published}`));
          published++;
        }
        return { published, dropped: yield* events.droppedCount };
      }),
    );
    yield* capacity.set(outcome);
  });

  Then("it has a finite configured capacity", function* () {
    const { capacity } = yield* World;
    const probe = yield* capacity.get;
    assert.ok(Number.isFinite(CAPACITY) && CAPACITY > 0);
    // The bus refused its first event only after holding CAPACITY of them plus the one the
    // stalled subscriber had already taken: the configured capacity is the real one.
    assert.equal(probe.dropped, 1, "the bus never dropped, so it has no bound");
    assert.equal(probe.published, CAPACITY + 2, "the first drop came at the wrong event");
  });

  Then("it is not {string}", function* (kind: string) {
    assert.equal(kind, "PubSub.unbounded", `unknown bus kind "${kind}"`);
    const { capacity } = yield* World;
    // An unbounded PubSub never drops: reaching a drop within twice the capacity rules it out.
    assert.ok((yield* capacity.get).dropped > 0);
  });

  Given(
    "a subscriber to {string} that never catches up with published events",
    function* (name: string) {
      assert.equal(name, "AuthEvents");
      yield* subscribeStalled("lagging");
    },
  );

  When("events continue to be published while that subscriber lags", function* () {
    const { host, counts } = yield* World;
    const total = CAPACITY * 3;
    // Every publish must return: a bus that applied backpressure would hang this step at the
    // (CAPACITY + 1)th event (ESS-001's defect), which the test timeout reports.
    yield* host.run(
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        for (let i = 0; i < total; i++) yield* events.publish(replay(`lag:${i}`));
      }),
    );
    yield* counts.set({ published: total, handled: 0 });
  });

  Then("the backlog held for that subscriber is bounded by the PubSub's fixed capacity", function* () {
    const { counts } = yield* World;
    const lagging = yield* getProbe("lagging");
    const handled = yield* releaseAndDrain(lagging);
    // Released, the subscriber sees only what the bus held: at most its capacity plus the one
    // event it was already handling — not the 3 x CAPACITY that were published.
    assert.ok(handled <= CAPACITY + 1, `the subscriber's backlog was ${handled}`);
    assert.ok(handled >= CAPACITY, `the bus held only ${handled} events`);
    yield* counts.set({ ...(yield* counts.get), handled });
  });

  Then("the publishing process's memory does not grow without bound", function* () {
    const { host, counts } = yield* World;
    const { published, handled } = yield* counts.get;
    const dropped = yield* host.run(
      Effect.flatMap(AuthEvents.AuthEvents, (events) => events.droppedCount),
    );
    // Every published event is accounted for: it reached the subscriber, or the bus counted it
    // as dropped. Nothing is buffered beyond the bound in between.
    assert.equal(handled + dropped, published);
    assert.ok(dropped > 0);
  });

  // ---- BEH-EA-098: a publisher never awaits its subscribers ----

  Given(
    "a subscriber to {string} that takes a long time to handle each event",
    function* (name: string) {
      assert.equal(name, "AuthEvents");
      yield* subscribeStalled("slow");
    },
  );

  When(
    "an event is published while that subscriber is still processing a previous event",
    function* () {
      const { host, publisher } = yield* World;
      // The first event is taken by the slow subscriber and held at its gate; the publisher then
      // keeps going well past the bus's capacity, on its own fiber so the step can look at it.
      yield* publish(replay("slow:first"));
      yield* letSubscribersRun;
      const fiber = yield* host
        .run(
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            for (let i = 0; i < CAPACITY + 10; i++) yield* events.publish(replay(`slow:${i}`));
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      // Give it every scheduler turn it needs (1000+ publishes, each a few turns): a publisher
      // that is merely busy finishes; one parked on a full bus never does, and is reported below.
      for (let turn = 0; turn < 200_000 && fiber.pollUnsafe() === undefined; turn++) {
        yield* Effect.yieldNow;
      }
      yield* publisher.set(fiber);
    },
  );

  Then(
    "{string} returns as soon as the event is recorded and offered to the bounded bus, whether or not the bus accepted it",
    function* (operation: string) {
      assert.equal(operation, "publish");
      const { publisher } = yield* World;
      // Done: it did not wait on the slow subscriber or on the bus filling up. (With
      // `PubSub.bounded` it would be parked at event CAPACITY + 1 forever.)
      const exit = (yield* publisher.get).pollUnsafe();
      assert.ok(exit !== undefined, "the publishing fiber is still suspended");
      assert.equal(exit._tag, "Success");
      // Recorded: all CAPACITY + 11 events reached the durable log, whether or not the bus took them.
      assert.equal((yield* auditRows).length, CAPACITY + 11);
    },
  );

  Then(
    "the publishing fiber is not suspended waiting on the subscriber or on the bus's capacity",
    function* () {
      const { publisher } = yield* World;
      assert.notEqual((yield* publisher.get).pollUnsafe(), undefined);
      // ...while the subscriber it did not wait on is still at its gate, mid-event.
      const slow = yield* getProbe("slow");
      assert.equal(yield* Ref.get(slow.completed), 0);
      assert.equal((yield* Ref.get(slow.handled)).length, 1);
    },
  );

  Given(
    "a signed-in user {string} whose sign-in publishes {string} to a slow analytics subscriber",
    function* (name: string, tag: string) {
      yield* signUpUser(name);
      yield* subscribe("analytics", tagNamed(tag), { gated: true });
    },
  );

  When("{string} signs in", function* (name: string) {
    yield* signIn(name);
  });

  Then("the sign-in operation completes without waiting on the analytics subscriber", function* () {
    const { signIns } = yield* World;
    const outcomes = yield* Ref.get(signIns);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.succeeded, true);
    // The subscriber really was handed the event, and is still holding it: the sign-in returned
    // without it.
    const analytics = yield* getProbe("analytics");
    assert.equal((yield* Ref.get(analytics.handled)).length, 1);
    assert.equal(yield* Ref.get(analytics.completed), 0);
  });

  Then("its latency is unaffected by how long that subscriber takes to run", function* () {
    // A subscriber that never finishes is the longest run there is; a second sign-in behind it
    // returns just the same, so the sign-in's duration is independent of the subscriber's.
    yield* signIn("alice");
    const { signIns } = yield* World;
    const outcomes = yield* Ref.get(signIns);
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((outcome) => outcome.succeeded));
    const analytics = yield* getProbe("analytics");
    assert.equal(yield* Ref.get(analytics.completed), 0);
  });

  // ---- BEH-EA-099: isolated, forked subscribers ----

  Given(
    "two independent subscriptions to {string}, {string} and {string}",
    function* (bus: string, first: string, second: string) {
      assert.equal(bus, "AuthEvents");
      yield* subscribe(first, "auth.token.replay");
      yield* subscribe(second, "auth.token.replay");
    },
  );

  When("an event is published", function* () {
    const { host, publisherFiberId } = yield* World;
    const fiber = yield* host.run(
      Effect.gen(function* () {
        const events = yield* AuthEvents.AuthEvents;
        yield* events.publish(replay("fork-per-subscriber"));
        return yield* Effect.fiberId;
      }),
    );
    yield* letSubscribersRun;
    yield* publisherFiberId.set(fiber);
  });

  Then(
    "{string} and {string} each handle the event on their own forked fiber",
    function* (first: string, second: string) {
      const { publisherFiberId } = yield* World;
      const publisher = yield* publisherFiberId.get;
      const aFibers = yield* Ref.get((yield* getProbe(first)).fibers);
      const bFibers = yield* Ref.get((yield* getProbe(second)).fibers);
      assert.equal(aFibers.length, 1);
      assert.equal(bFibers.length, 1);
      assert.notEqual(aFibers[0], bFibers[0]);
      assert.notEqual(aFibers[0], publisher);
      assert.notEqual(bFibers[0], publisher);
    },
  );

  Given(
    "a signed-in user {string} whose sign-in publishes {string}",
    function* (name: string, tag: string) {
      tagNamed(tag);
      yield* signUpUser(name);
    },
  );

  Given("a subscriber {string} that fails while handling that event", function* (name: string) {
    yield* subscribe(name, "auth.user.signedIn", { failing: true });
  });

  Then("{string}'s failure is caught and logged", function* (name: string) {
    const probe = yield* getProbe(name);
    assert.equal((yield* Ref.get(probe.handled)).length, 1);
    assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 1);
  });

  Then("the sign-in operation that published the event is unaffected", function* () {
    const { signIns } = yield* World;
    const outcomes = yield* Ref.get(signIns);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.succeeded, true);
  });

  Given(
    "two subscribers, {string} and {string}, both handling {string}",
    function* (first: string, second: string, tag: string) {
      const { lagging } = yield* World;
      yield* subscribe(first, tagNamed(tag));
      yield* subscribe(second, tagNamed(tag));
      yield* lagging.set(first);
    },
  );

  When("{string} fails while handling an event", function* (name: string) {
    yield* Ref.set((yield* getProbe(name)).failing, true);
    yield* publish({ _tag: "auth.user.signedIn", userId: someUser, strategy: "password" });
    yield* letSubscribersRun;
  });

  Then("{string} still receives and handles that same event", function* (name: string) {
    const { lagging } = yield* World;
    const failing = yield* getProbe(yield* lagging.get);
    const healthy = yield* getProbe(name);
    const seenByFailing = yield* Ref.get(failing.handled);
    const seenByHealthy = yield* Ref.get(healthy.handled);
    assert.equal(seenByHealthy.length, 1);
    assert.equal(seenByHealthy[0]?.eventId, seenByFailing[0]?.eventId);
    assert.equal(yield* Ref.get(healthy.completed), 1);
  });

  Then(
    "{string}'s handling is unaffected by {string}'s failure",
    function* (healthy: string, failing: string) {
      assert.equal(yield* Ref.get((yield* getProbe(healthy)).completed), 1);
      assert.equal(yield* Ref.get((yield* getProbe(failing)).completed), 0);
      // The failure is the failing subscriber's own, logged once; the healthy one wrote none.
      assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 1);
    },
  );

  // ---- BEH-EA-100: the audit table is the record of record ----

  Given(
    "a signed-in user {string} who signs in, a security-relevant, audited operation",
    function* (name: string) {
      yield* signUpUser(name);
    },
  );

  Then(
    "an audit record for the sign-in is written durably to persistence as part of that same operation",
    function* () {
      const userId = yield* userIdOf("alice");
      const rows = (yield* auditRows).filter((row) => row.eventTag === "auth.user.signedIn");
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.ok(row?.payload._tag === "auth.user.signedIn");
      assert.equal(row.payload.userId, userId);
    },
  );

  Given(
    "no subscriber is registered on {string}, or the only registered subscriber fails",
    function* (bus: string) {
      assert.equal(bus, "AuthEvents");
      // The no-subscriber branch is what every other scenario here already runs under (an
      // unsubscribed bus, and an audit row anyway — REQ-EA-266); this one arranges the other
      // branch: the only subscriber there is fails on everything.
      yield* subscribe("only", ["auth.user.created", "auth.user.signedIn", "auth.session.issued"], {
        failing: true,
      });
    },
  );

  When("a security-relevant operation is performed", function* () {
    yield* signUpUser("carol");
    yield* signIn("carol");
  });

  Then("the audit record for that operation is still written durably", function* () {
    const rows = yield* auditRows;
    assert.ok(rows.some((row) => row.eventTag === "auth.user.signedIn"));
    assert.ok(rows.some((row) => row.eventTag === "auth.user.created"));
  });

  Then("the absence or failure of an event subscriber causes no audit gap", function* () {
    const only = yield* getProbe("only");
    const seen = yield* Ref.get(only.handled);
    assert.ok(seen.length > 0, "the failing subscriber was never handed an event");
    const recorded = new Set((yield* auditRows).map((row) => row.id));
    // Every event the failing subscriber was handed is in the durable log under the same id.
    for (const event of seen) assert.ok(recorded.has(event.eventId), `no audit row for ${event._tag}`);
    assert.equal(yield* Ref.get(only.completed), 0);
    assert.ok((yield* errorLogsNamed("auth.event.observer.error")).length > 0);
  });

  // ---- BEH-EA-101: typed, tagged events forming a registry ----

  Given(
    "the event registry declares {string}, {string}, {string}, and {string}",
    function* (a: string, b: string, c: string, d: string) {
      for (const tag of [a, b, c, d]) {
        assert.ok(isRegistryTag(tag), `"${tag}" is not declared by the event registry`);
      }
      yield* subscribe("watcher", [tagNamed(a), tagNamed(b), tagNamed(c), tagNamed(d)]);
    },
  );

  When("an event is published to {string}", function* (bus: string) {
    assert.equal(bus, "AuthEvents");
    yield* publish({ _tag: "auth.user.signedIn", userId: someUser, strategy: "password" });
    yield* publish({ _tag: "auth.user.created", userId: someUser });
    yield* letSubscribersRun;
  });

  Then("the event's tag is one of the registry's declared tags", function* () {
    const seen = yield* Ref.get((yield* getProbe("watcher")).handled);
    assert.equal(seen.length, 2);
    for (const event of seen) assert.ok(isRegistryTag(event._tag), `${event._tag} is not declared`);
    // The audit log holds the same tags, and a value outside the union does not decode.
    assert.ok((yield* auditRows).every((row) => isRegistryTag(row.eventTag)));
    assert.equal(Schema.is(AuthEvents.AuthEventSchema)({ _tag: "auth.not.declared" }), false);
  });

  Given("a subscriber handling events tagged {string}", function* (tag: string) {
    yield* subscribe("handler", tagNamed(tag));
    yield* signUpUser("alice");
  });

  When(
    "it destructures the event payload's {string} and {string} fields",
    function* (first: string, second: string) {
      assert.deepEqual([first, second], ["userId", "strategy"]);
      // The event comes from a real sign-in, not a hand-built value, so the shape asserted next
      // is what a real publisher produces.
      yield* signIn("alice");
    },
  );

  Then("those fields are present, shaped exactly as the registry declares for that tag", function* () {
    const [event] = yield* Ref.get((yield* getProbe("handler")).handled);
    assert.ok(event !== undefined && event._tag === "auth.user.signedIn");
    const { userId, strategy } = event;
    assert.equal(userId, yield* userIdOf("alice"));
    assert.equal(strategy, "password");
    // Exactly the registry's shape: it decodes under that tag's schema, whose fields are these.
    assert.equal(Schema.is(AuthEvents.UserSignedInEvent)({ _tag: event._tag, userId, strategy }), true);
    assert.deepEqual(Object.keys(AuthEvents.UserSignedInEvent.fields).sort(), [
      "_tag",
      "strategy",
      "userId",
    ]);
  });

  Given("an existing subscriber filtering only on {string}", function* (tag: string) {
    yield* subscribe("existing", tagNamed(tag));
  });

  When("a new event tag is added to the registry", function* () {
    // The registry is a closed union fixed at build time, so a tag cannot appear at runtime;
    // what a subscriber experiences when one is added is events of a tag it does not name. So:
    // the bus carries events of other tags (a rate-limit breach, a token replay) ahead of, and
    // between, the events it filters on.
    yield* publish({
      _tag: "auth.rateLimit.exceeded",
      group: "password",
      endpoint: "signIn",
      rule: "signIn",
      dimension: "identity",
      retryAfterMillis: 1000,
    });
    yield* publish({ _tag: "auth.user.created", userId: someUser });
    yield* publish(replay("a-tag-the-subscriber-does-not-name"));
    yield* publish({ _tag: "auth.user.created", userId: someUser });
    yield* letSubscribersRun;
  });

  Then(
    "the existing subscriber continues to receive and handle {string} events unaffected",
    function* (tag: string) {
      const existing = yield* getProbe("existing");
      const seen = yield* Ref.get(existing.handled);
      assert.deepEqual(
        seen.map((event) => event._tag),
        [tag, tag],
      );
      assert.equal(yield* Ref.get(existing.completed), 2);
      assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 0);
    },
  );

  // ---- BEH-EA-102: the raw stream ----

  When(
    "a consumer accesses {string} directly instead of using {string}",
    function* (access: string, sugar: string) {
      assert.equal(access, "ev.stream");
      assert.equal(sugar, "AuthEvents.on");
      const { host, consumer } = yield* World;
      // `startImmediately`: the raw stream is lazy — it registers when a fiber first pulls — so
      // the consumer must be pulling before anything is published.
      const fiber = yield* host
        .run(
          Effect.gen(function* () {
            const events = yield* AuthEvents.AuthEvents;
            return yield* events.stream.pipe(
              Stream.map((event) => event._tag),
              Stream.take(2),
              Stream.runCollect,
            );
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* publish(replay("raw-1"));
      yield* publish({ _tag: "auth.user.created", userId: someUser });
      yield* consumer.set(fiber);
    },
  );

  Then(
    "the raw event stream is available for that consumer to pipe through its own operators",
    function* () {
      const { consumer } = yield* World;
      const tags = yield* Fiber.join(yield* consumer.get);
      assert.deepEqual(tags, ["auth.token.replay", "auth.user.created"]);
    },
  );

  Given(
    "a consumer that wants to alert on {string} using a custom predicate over the raw stream",
    function* (tag: string) {
      tagNamed(tag);
    },
  );

  When(
    "it filters {string} with that predicate and runs it on a forked, scoped fiber",
    function* (stream: string) {
      assert.equal(stream, "ev.stream");
      const { host, alerts } = yield* World;
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      // One predicate across several tags — replays and reuse detections — which a one-tag `on`
      // handler cannot express.
      yield* host.run(
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          yield* events.stream.pipe(
            Stream.filter(
              (event) => event._tag === "auth.token.replay" || event._tag === "auth.session.reuse",
            ),
            Stream.runForEach((event) => Ref.update(seen, (existing) => [...existing, event._tag])),
            Effect.forkIn(host.scope, { startImmediately: true }),
          );
        }),
      );
      yield* publish(replay("alert-1"));
      yield* publish({ _tag: "auth.user.created", userId: someUser });
      yield* publish({
        _tag: "auth.session.reuse",
        sessionId: Sessions.SessionId("s-1"),
        familyId: "family-1",
        userId: someUser,
      });
      yield* letSubscribersRun;
      yield* alerts.set(seen);
    },
  );

  Then(
    "it can do so without being restricted to registering one handler per single tag via {string}",
    function* (sugar: string) {
      assert.equal(sugar, "AuthEvents.on");
      const { alerts } = yield* World;
      // Both tags reached one consumer through one custom predicate; the unrelated event did not.
      assert.deepEqual(yield* Ref.get(yield* alerts.get), ["auth.token.replay", "auth.session.reuse"]);
    },
  );

  // ---- BEH-EA-103: on(tag, handler) is sugar over a subscription Layer ----

  Given("a plugin author writes {string}", function* (expression: string) {
    const tag = /^AuthEvents\.on\("([^"]+)", handler\)$/.exec(expression)?.[1];
    assert.ok(tag !== undefined, `not an AuthEvents.on(tag, handler) expression: ${expression}`);
    tagNamed(tag);
  });

  When("the resulting {string} is provided into the application", function* (kind: string) {
    assert.equal(kind, "Layer");
    // The author's handler records the fiber it runs on, then fails — exactly what the
    // isolation the next Then checks is for.
    yield* subscribe("author", "auth.user.created", { failing: true });
  });

  Then(
    "a subscription satisfying the same fork-per-subscriber isolation as BEH-EA-099 is established",
    function* () {
      const { host } = yield* World;
      const publisher = yield* host.run(
        Effect.gen(function* () {
          const events = yield* AuthEvents.AuthEvents;
          yield* events.publish({ _tag: "auth.user.created", userId: someUser });
          return yield* Effect.fiberId;
        }),
      );
      yield* letSubscribersRun;
      const author = yield* getProbe("author");
      const fibers = yield* Ref.get(author.fibers);
      assert.equal(fibers.length, 1);
      assert.notEqual(fibers[0], publisher);
      // Its failure stayed inside it: the publish above returned, one error was logged, and a
      // second event is still delivered to the same subscription.
      assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 1);
      yield* publish({ _tag: "auth.user.created", userId: someUser });
      yield* letSubscribersRun;
      assert.equal((yield* Ref.get(author.handled)).length, 2);
    },
  );

  Given("a plugin author using {string}", function* (expression: string) {
    assert.equal(expression, "AuthEvents.on(tag, handler)");
  });

  When("they compose their subscription", function* () {
    // The composition is `AuthEvents.on` and nothing else — no stream, no fork, no scope of the
    // author's own — built over a context holding only the bus (and the log sink).
    yield* subscribe("composed", "auth.token.replay", { failing: true });
  });

  Then(
    "they do not write {string} or {string} themselves",
    function* (runForEach: string, forkScoped: string) {
      assert.equal(runForEach, "Stream.runForEach");
      assert.equal(forkScoped, "Effect.forkScoped");
      // What that means observably: the layer `on` returned needed nothing of the author — it
      // built (in `When`) from the bus alone — and it is already subscribed, so an event
      // published now reaches the handler.
      yield* publish(replay("author-did-not-fork"));
      yield* letSubscribersRun;
      assert.equal((yield* Ref.get((yield* getProbe("composed")).handled)).length, 1);
    },
  );

  Then("the isolation guarantee still holds", function* () {
    const { host } = yield* World;
    // The handler failed on its own fiber; the publisher, and the bus, carried on.
    assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 1);
    yield* publish(replay("still-publishing"));
    const dropped = yield* host.run(
      Effect.flatMap(AuthEvents.AuthEvents, (events) => events.droppedCount),
    );
    assert.equal(dropped, 0);
  });

  // ---- BEH-EA-104: a stable, queryable log name, never re-raised ----

  Given("a subscriber that fails while handling an event", function* () {
    yield* subscribe("failing", "auth.token.replay", { failing: true });
  });

  When("the failure is logged", function* () {
    yield* publish(replay("observer-failure"));
    yield* letSubscribersRun;
  });

  Then("it is logged under the event name {string}", function* (name: string) {
    assert.equal((yield* errorLogsNamed(name)).length, 1);
  });

  Then("the log entry identifies which subscription and which event triggered it", function* () {
    const [entry] = yield* errorLogsNamed("auth.event.observer.error");
    assert.ok(entry !== undefined);
    assert.ok(entry.text.includes('"tag":"auth.token.replay"'), "the entry does not name the event");
    assert.ok(
      entry.text.includes('"subscription":"auth.token.replay"'),
      "the entry does not name the subscription",
    );
  });

  Given(
    "a signed-in user {string} whose sign-in publishes an event a subscriber fails to handle",
    function* (name: string) {
      yield* signUpUser(name);
      yield* subscribe("failing", "auth.user.signedIn", { failing: true });
    },
  );

  When("that subscriber's failure occurs", function* () {
    yield* signIn("alice");
  });

  Then(
    "the failure is not re-raised to {string}'s sign-in call or its caller",
    function* (name: string) {
      const { signIns } = yield* World;
      const outcomes = yield* Ref.get(signIns);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.userId, yield* userIdOf(name));
      assert.equal(outcomes[0]?.succeeded, true);
    },
  );

  Then("it is terminal at the point it is logged", function* () {
    // Logged once, and that is the end of it: further turns of the scheduler produce no second
    // entry (no retry of the handler, no cascade), and the subscription is alive for the next event.
    yield* letSubscribersRun;
    assert.equal((yield* errorLogsNamed("auth.event.observer.error")).length, 1);
    const failing = yield* getProbe("failing");
    assert.equal((yield* Ref.get(failing.handled)).length, 1);
    yield* signIn("alice");
    assert.equal((yield* Ref.get(failing.handled)).length, 2);
  });

  Given(
    "both a subscriber failure and a genuine {string} security event have occurred",
    function* (tag: string) {
      yield* signUpUser("alice");
      yield* subscribe("failing", "auth.user.signedIn", { failing: true });
      yield* subscribe("replays", tagNamed(tag));
      yield* signIn("alice");
      yield* publish(replay("genuine-security-event"));
      yield* letSubscribersRun;
    },
  );

  When("an operator queries logs for {string}", function* (name: string) {
    const { queried } = yield* World;
    yield* queried.set(yield* errorLogsNamed(name));
  });

  Then("only subscriber-failure entries are returned", function* () {
    const { queried } = yield* World;
    const entries = yield* queried.get;
    assert.equal(entries.length, 1);
    // The one entry is the failing sign-in subscriber's — nothing else was logged under this name.
    assert.ok(entries.every((entry) => entry.text.includes('"tag":"auth.user.signedIn"')));
  });

  Then(
    "genuine {string} security events are not conflated with subscriber failures",
    function* (tag: string) {
      const { queried } = yield* World;
      assert.ok((yield* queried.get).every((entry) => !entry.text.includes(`"tag":"${tag}"`)));
      // The genuine event is where it belongs: in the durable audit log, handled fine by its subscriber.
      assert.ok((yield* auditRows).some((row) => row.eventTag === tag));
      assert.equal(yield* Ref.get((yield* getProbe("replays")).completed), 1);
      // ...and no error-level line anywhere names it as a failure.
      assert.ok(
        (yield* capturedLogs()).every(
          (entry) => entry.level !== "Error" || !entry.text.includes(`"tag":"${tag}"`),
        ),
      );
    },
  );
});
