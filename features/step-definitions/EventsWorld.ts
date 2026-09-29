// ESS-008 / decision 36 tier 3: 13-events.feature's World. The real `AuthEvents` (bounded,
// dropping PubSub) and `AuditLog` from `TestAuth`'s bundle, plus what a scenario about a bus
// needs to *observe* it: named subscriber probes (what each handled and on which fiber), a
// gate that makes a subscriber controllably slow, a capacity probe, and the captured logs.
//
// A subscriber is registered with a scenario's real `AuthEvents.on(...)` — the sugar
// BEH-EA-103 is about — or, where the raw stream is the point, `AuthEvents.subscribe`/`stream`.
// Subscriptions are built late (into the app's scope, over its context) so a Given may add one
// after another Given has already signed a user up.
import { AuthEvents } from "@awthaq/core";
import { Password } from "@awthaq/password";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type Host, type LogRecord, makeHost } from "./CrossCuttingApp.ts";
import { letForkedFibersRun, STRONG_PASSWORD } from "./shared/Harness.ts";

/** What a named subscriber saw: every event it was handed, on which fibers, and whether it finished handling. */
export interface Probe {
  readonly handled: Ref.Ref<ReadonlyArray<AuthEvents.Published>>;
  readonly fibers: Ref.Ref<ReadonlyArray<number>>;
  /** Handlers that ran to completion (a gated or failing one never counts). */
  readonly completed: Ref.Ref<number>;
  /** Opened by a scenario to release a gated (slow) subscriber; `undefined` when the subscriber is not gated. */
  readonly gate: Deferred.Deferred<void> | undefined;
  /** When set, the handler fails after recording the event. */
  readonly failing: Ref.Ref<boolean>;
}

export interface SignInOutcome {
  readonly userId: string;
  readonly succeeded: boolean;
}

export interface WorldShape {
  readonly host: Host;
  readonly probes: Ref.Ref<Readonly<Record<string, Probe>>>;
  readonly userIds: Ref.Ref<Readonly<Record<string, string>>>;
  readonly signIns: Ref.Ref<ReadonlyArray<SignInOutcome>>;
  /** What one scenario's When hands its Thens, each under a typed name (a cell dies if read before it is set). */
  readonly capacity: Cell<{ readonly published: number; readonly dropped: number }>;
  readonly counts: Cell<{ readonly published: number; readonly handled: number }>;
  readonly publisher: Cell<Fiber.Fiber<void, never>>;
  readonly publisherFiberId: Cell<number>;
  readonly consumer: Cell<Fiber.Fiber<ReadonlyArray<string>, never>>;
  readonly alerts: Cell<Ref.Ref<ReadonlyArray<string>>>;
  readonly queried: Cell<ReadonlyArray<LogRecord>>;
  readonly lagging: Cell<string>;
  /** The tag the scenario's `Given` named for the sign-in's event. */
  readonly tag: Ref.Ref<AuthEvents.AuthEventTag | undefined>;
}

/** A write-once-per-scenario slot: `get` dies with the slot's name if a Then reads what no When set. */
export interface Cell<A> {
  readonly set: (value: A) => Effect.Effect<void>;
  readonly get: Effect.Effect<A>;
}

const makeCell = <A>(name: string) =>
  Effect.map(Ref.make<A | undefined>(undefined), (ref): Cell<A> => ({
    set: (value) => Ref.set(ref, value),
    get: Effect.flatMap(Ref.get(ref), (value) =>
      value === undefined
        ? Effect.die(new Error(`nothing was recorded for "${name}" yet`))
        : Effect.succeed(value),
    ),
  }));

export class World extends Context.Service<World, WorldShape>()("features/EventsWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      host: yield* makeHost,
      probes: yield* Ref.make<Readonly<Record<string, Probe>>>({}),
      userIds: yield* Ref.make<Readonly<Record<string, string>>>({}),
      signIns: yield* Ref.make<ReadonlyArray<SignInOutcome>>([]),
      capacity: yield* makeCell<{ readonly published: number; readonly dropped: number }>(
        "capacity probe",
      ),
      counts: yield* makeCell<{ readonly published: number; readonly handled: number }>("counts"),
      publisher: yield* makeCell<Fiber.Fiber<void, never>>("publisher fiber"),
      publisherFiberId: yield* makeCell<number>("publisher fiber id"),
      consumer: yield* makeCell<Fiber.Fiber<ReadonlyArray<string>, never>>("consumer fiber"),
      alerts: yield* makeCell<Ref.Ref<ReadonlyArray<string>>>("alerts"),
      queried: yield* makeCell<ReadonlyArray<LogRecord>>("queried logs"),
      lagging: yield* makeCell<string>("failing subscriber name"),
      tag: yield* Ref.make<AuthEvents.AuthEventTag | undefined>(undefined),
    });
  }),
);

export const getProbe = Effect.fn("features.events.getProbe")(function* (name: string) {
  const { probes } = yield* World;
  const found = (yield* Ref.get(probes))[name];
  if (found === undefined)
    return yield* Effect.die(new Error(`no subscriber "${name}" was set up`));
  return found;
});

const makeProbe = (options: { readonly gated: boolean; readonly failing: boolean }) =>
  Effect.gen(function* () {
    const gate = options.gated ? yield* Deferred.make<void>() : undefined;
    const probe: Probe = {
      handled: yield* Ref.make<ReadonlyArray<AuthEvents.Published>>([]),
      fibers: yield* Ref.make<ReadonlyArray<number>>([]),
      completed: yield* Ref.make(0),
      gate,
      failing: yield* Ref.make(options.failing),
    };
    return probe;
  });

/** What every probed subscriber does with an event: record it and the fiber it runs on, wait at its gate if it has one, fail if told to, else complete. */
const handle = (probe: Probe, event: AuthEvents.Published) =>
  Effect.gen(function* () {
    yield* Ref.update(probe.handled, (existing) => [...existing, event]);
    const fiber = yield* Effect.fiberId;
    yield* Ref.update(probe.fibers, (existing) => [...existing, fiber]);
    if (probe.gate !== undefined) yield* Deferred.await(probe.gate);
    if (yield* Ref.get(probe.failing)) {
      return yield* Effect.fail({
        _tag: "SubscriberBoom",
        message: "the subscriber failed while handling an event",
      });
    }
    yield* Ref.update(probe.completed, (n) => n + 1);
  });

/**
 * Registers a named subscriber with the real `AuthEvents.on(select, ...)` layer, built into the
 * app's own scope over its own context. The subscription is registered synchronously while the
 * layer builds (ALF-007), so an event published right after this returns is not missed.
 */
export const subscribe = Effect.fn("features.events.subscribe")(function* (
  name: string,
  select: AuthEvents.AuthEventTag | ReadonlyArray<AuthEvents.AuthEventTag>,
  options: { readonly gated?: boolean; readonly failing?: boolean } = {},
) {
  const { probes } = yield* World;
  const probe = yield* makeProbe({
    gated: options.gated === true,
    failing: options.failing === true,
  });
  yield* Ref.update(probes, (existing) => ({ ...existing, [name]: probe }));
  yield* subscribeLayer(AuthEvents.on(select, (event) => handle(probe, event)));
  return probe;
});

/** Builds a subscription layer (the product of `AuthEvents.on`) into the app's scope. */
export const subscribeLayer = Effect.fn("features.events.subscribeLayer")(function* (
  subscription: Layer.Layer<never, never, AuthEvents.AuthEvents>,
) {
  const { host } = yield* World;
  const context = yield* host.context;
  yield* Layer.buildWithScope(
    subscription.pipe(
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(host.captureLogs),
    ),
    host.scope,
  );
});

/** Registers a stalled subscriber over the raw `subscribe` stream: it takes one event and then never catches up. */
export const subscribeStalled = Effect.fn("features.events.subscribeStalled")(function* (
  name: string,
) {
  const { host, probes } = yield* World;
  const probe = yield* makeProbe({ gated: true, failing: false });
  yield* Ref.update(probes, (existing) => ({ ...existing, [name]: probe }));
  yield* host.run(
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const stream = yield* events.subscribe;
      yield* stream.pipe(
        Stream.runForEach((event) => handle(probe, event)),
        Effect.forkIn(host.scope, { startImmediately: true }),
      );
    }).pipe(Effect.provideService(Scope.Scope, host.scope)),
  );
  return probe;
});

const emailOf = (name: string) => `${name}@example.com`;

/** A real password sign-up: creates the user (and publishes `auth.user.created`), recording the id under `name`. */
export const signUpUser = Effect.fn("features.events.signUpUser")(function* (name: string) {
  const { host, userIds } = yield* World;
  const issued = yield* host.run(
    Effect.flatMap(Password.Password, (password) =>
      password.signUp({ email: emailOf(name), password: Redacted.make(STRONG_PASSWORD) }),
    ).pipe(
      // A sign-up failing here is a defect in the scenario's own arrangement, not a result to assert on.
      Effect.orDie,
    ),
  );
  yield* Ref.update(userIds, (existing) => ({ ...existing, [name]: issued.session.userId }));
  return issued.session.userId;
});

export const userIdOf = Effect.fn("features.events.userIdOf")(function* (name: string) {
  const { userIds } = yield* World;
  const found = (yield* Ref.get(userIds))[name];
  if (found === undefined) return yield* Effect.die(new Error(`no user "${name}" was signed up`));
  return found;
});

/** A real password sign-in; the outcome is recorded so a Then can assert on it. Yields to the scheduler afterwards so subscribers get to run. */
export const signIn = Effect.fn("features.events.signIn")(function* (name: string) {
  const { host, signIns } = yield* World;
  const userId = yield* userIdOf(name);
  const succeeded = yield* host.run(
    Effect.flatMap(Password.Password, (password) =>
      password.signIn({ email: emailOf(name), password: Redacted.make(STRONG_PASSWORD) }),
    ).pipe(
      // Only whether it succeeded matters to a Then here; a typed failure is a `false`, a defect stays one.
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    ),
  );
  yield* Ref.update(signIns, (existing) => [...existing, { userId, succeeded }]);
  yield* letSubscribersRun;
  return succeeded;
});

/** Subscribers drain on their own fibers; a few cooperative turns let them reach their next suspension. */
export const letSubscribersRun = Effect.gen(function* () {
  yield* letForkedFibersRun;
  yield* letForkedFibersRun;
});

/** Publishes directly on the bus, the way a plugin's own flow would. */
export const publish = Effect.fn("features.events.publish")(function* (
  event: AuthEvents.AuthEvent,
) {
  const { host } = yield* World;
  yield* host.run(Effect.flatMap(AuthEvents.AuthEvents, (events) => events.publish(event)));
});

/** How many of the `probe`'s events were handled once its gate opens and everything queued for it has drained. */
export const releaseAndDrain = Effect.fn("features.events.releaseAndDrain")(function* (
  probe: Probe,
) {
  if (probe.gate !== undefined) yield* Deferred.succeed(probe.gate, undefined);
  // Yield until the count stops moving: the queued events are in memory, so a stable count
  // across many scheduler turns means the subscriber is caught up (or has nothing left).
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 200_000 && stable < 50; i++) {
    yield* Effect.yieldNow;
    const now = (yield* Ref.get(probe.handled)).length;
    stable = now === previous ? stable + 1 : 0;
    previous = now;
  }
  return previous;
});

export const capturedLogs = Effect.fn("features.events.capturedLogs")(function* () {
  const { host } = yield* World;
  return yield* host.logs;
});

/** Error-level log entries written under `name` — what an operator's query for that event name returns. */
export const errorLogsNamed = Effect.fn("features.events.errorLogsNamed")(function* (name: string) {
  return (yield* capturedLogs()).filter(
    (record) => record.level === "Error" && record.text.includes(name),
  );
});
