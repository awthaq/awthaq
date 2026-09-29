// ERS-002: the owned, observable, retrying background mail dispatcher.
import { Mailer } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as AuditLog from "../src/AuditLog.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as MailDispatch from "../src/MailDispatch.ts";
import * as Users from "../src/Users.ts";

const EventsLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));

const failed = (retryable: boolean) =>
  new Mailer.MailDeliveryFailed({ template: "reset-password", reason: "provider down", retryable });

/** Yields a dispatcher plus a collector of every `auth.mail.failed` event. */
const withDispatcher = <A, E, R>(
  use: (
    dispatcher: MailDispatch.MailDispatcherShape,
    failures: Effect.Effect<ReadonlyArray<AuthEvents.AuthEvent>>,
  ) => Effect.Effect<A, E, R>,
  config: Partial<MailDispatch.MailDispatchConfigShape> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const seen = yield* Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]);
      yield* Effect.forkScoped(
        events.stream.pipe(
          Stream.filter((event) => event._tag === "auth.mail.failed"),
          Stream.runForEach((event) =>
            Ref.update(seen, (all) => [...all, AuthEvents.payloadOf(event)]),
          ),
        ),
        { startImmediately: true },
      );
      const dispatcher = yield* MailDispatch.make.pipe(Effect.provide(MailDispatch.config(config)));
      return yield* use(dispatcher, Ref.get(seen));
    }),
  ).pipe(Effect.provide(EventsLive));

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("MailDispatch", () => {
  it.effect("dispatch returns before the send completes", () =>
    withDispatcher(
      (dispatcher) =>
        Effect.gen(function* () {
          // If `dispatch` awaited `work`, this would never return.
          yield* dispatcher.dispatch({ template: "verify-email" }, Effect.never);
        }),
      // Closing the scope must not wait on the never-ending send (TestClock is frozen).
      { drainTimeout: Duration.zero },
    ),
  );

  it.effect("a Mailer failing twice then succeeding delivers once", () =>
    withDispatcher((dispatcher, failures) =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const delivered = yield* Ref.make(0);
        yield* dispatcher.dispatch(
          { template: "reset-password" },
          Ref.updateAndGet(attempts, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              n < 3 ? Effect.fail(failed(true)) : Ref.update(delivered, (d) => d + 1),
            ),
          ),
        );
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(10));
        yield* settle;
        assert.strictEqual(yield* Ref.get(attempts), 3);
        assert.strictEqual(yield* Ref.get(delivered), 1);
        assert.deepStrictEqual(yield* failures, []);
      }),
    ),
  );

  it.effect(
    "a permanently failing Mailer publishes auth.mail.failed with the template and no recipient",
    () =>
      withDispatcher(
        (dispatcher, failures) =>
          Effect.gen(function* () {
            const userId = Users.UserId("11111111-1111-1111-1111-111111111111");
            const attempts = yield* Ref.make(0);
            yield* dispatcher.dispatch(
              { template: "reset-password", userId },
              Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(Effect.fail(failed(true)))),
            );
            yield* settle;
            yield* TestClock.adjust(Duration.seconds(30));
            yield* settle;
            // The first attempt plus `retries` retries, then it gives up.
            assert.strictEqual(yield* Ref.get(attempts), 3);
            const seen = yield* failures;
            assert.strictEqual(seen.length, 1);
            assert.deepStrictEqual(seen[0], {
              _tag: "auth.mail.failed",
              template: "reset-password",
              userId,
            });
            assert.notInclude(JSON.stringify(seen), "@");
          }),
        { retries: 2 },
      ),
  );

  it.effect("a non-retryable failure is not retried", () =>
    withDispatcher((dispatcher, failures) =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        yield* dispatcher.dispatch(
          { template: "reset-password" },
          Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(Effect.fail(failed(false)))),
        );
        yield* settle;
        assert.strictEqual(yield* Ref.get(attempts), 1);
        assert.strictEqual((yield* failures).length, 1);
      }),
    ),
  );

  it.effect("bounds concurrent sends to the configured concurrency", () =>
    withDispatcher(
      (dispatcher) =>
        Effect.gen(function* () {
          const running = yield* Ref.make(0);
          const peak = yield* Ref.make(0);
          const gate = yield* Latch.make();
          const work = Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(running, (n) => n + 1);
            yield* Ref.update(peak, (p) => Math.max(p, now));
            yield* gate.await;
            yield* Ref.update(running, (n) => n - 1);
          });
          for (let i = 0; i < 6; i++)
            yield* dispatcher.dispatch({ template: "verify-email" }, work);
          yield* settle;
          assert.strictEqual(yield* Ref.get(peak), 2);
          yield* gate.open;
          yield* settle;
          assert.strictEqual(yield* Ref.get(running), 0);
        }),
      { concurrency: 2 },
    ),
  );

  it.effect("closing the scope waits for in-flight mail, then interrupts after drainTimeout", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const delivered = yield* Ref.make(0);
      const interrupted = yield* Ref.make(0);
      const dispatcher = yield* MailDispatch.make.pipe(
        Effect.provide(MailDispatch.config({ drainTimeout: Duration.seconds(5) })),
        Effect.provideService(Scope.Scope, scope),
      );
      // Finishes within the grace period.
      yield* dispatcher.dispatch(
        { template: "verify-email" },
        Effect.sleep(Duration.seconds(2)).pipe(Effect.andThen(Ref.update(delivered, (n) => n + 1))),
      );
      // Never finishes: interrupted once the grace period is over.
      yield* dispatcher.dispatch(
        { template: "verify-email" },
        Effect.never.pipe(Effect.onInterrupt(() => Ref.update(interrupted, (n) => n + 1))),
      );
      yield* settle;

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.seconds(2));
      yield* settle;
      assert.strictEqual(yield* Ref.get(delivered), 1);
      assert.isUndefined(closing.pollUnsafe());
      yield* TestClock.adjust(Duration.seconds(4));
      yield* Fiber.join(closing);
      assert.strictEqual(yield* Ref.get(interrupted), 1);
    }).pipe(Effect.provide(EventsLive)),
  );
});
