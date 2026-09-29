// @awthaq/core — MailDispatch
//
// spec/behaviors/15-password.md (BEH-EA-064, BEH-EA-113), ERS-002. A flow
// with an enumeration-uniform response (password reset, resend-verification,
// sign-up's verification mail) must not wait on the mail provider — response
// latency, and on a provider outage response status, would tell a caller
// whether an address has an account (BEH-EA-064) — so the mail is dispatched
// in the background. That used to be `Effect.forkDetach(...).pipe(Effect.ignore)`:
// unowned (dropped on shutdown), unretried, unbounded, and silent on loss.
//
// `MailDispatcher` keeps the non-blocking dispatch and adds what the detached
// fiber lacked: fibers owned by a `FiberSet` in the plugin's scope; retries
// with jittered exponential backoff for a `retryable` `MailDeliveryFailed`;
// a bound on concurrent sends; an `auth.mail.failed` event (template and user
// id only — never the recipient or a token, EOTS-010) when a mail is lost; and
// a drain at scope close that waits up to `drainTimeout` for in-flight mail
// before interrupting the rest and logging how many were dropped.

import { Mailer } from "@awthaq/ports";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as AuthEvents from "./AuthEvents.ts";
import type { UserId } from "./Users.ts";

export interface MailDispatchConfigShape {
  /** Concurrent `send` attempts; the rest wait (retry back-off does not hold a slot). */
  readonly concurrency: number;
  /** Attempts after the first, for a `retryable` `MailDeliveryFailed`. */
  readonly retries: number;
  /** First back-off; doubles each retry, jittered by +-20%. */
  readonly retryBase: Duration.Duration;
  /** How long scope close waits for in-flight mail before interrupting it. */
  readonly drainTimeout: Duration.Duration;
}

const defaultMailDispatchConfig: MailDispatchConfigShape = {
  concurrency: 32,
  retries: 3,
  retryBase: Duration.millis(200),
  drainTimeout: Duration.seconds(5),
};

/** BEH-EA-017's `Context.Reference`-with-default pattern. */
export const MailDispatchConfig: Context.Reference<MailDispatchConfigShape> = Context.Reference(
  "awthaq/core/MailDispatchConfig",
  { defaultValue: () => defaultMailDispatchConfig },
);

export const config = (partial: Partial<MailDispatchConfigShape>): Layer.Layer<never> =>
  Layer.succeed(MailDispatchConfig, { ...defaultMailDispatchConfig, ...partial });

/** What is safe to say about a mail without saying who it went to. */
export interface MailMeta {
  readonly template: string;
  readonly userId?: UserId;
}

export interface MailDispatcherShape {
  /**
   * Starts `work` (typically: issue a token, then `mailer.send`) in the
   * background and returns at once. A `MailDeliveryFailed` that is
   * `retryable` re-runs `work` with backoff — so keep `work` safe to repeat
   * (a re-issued token simply supersedes an undelivered one). Anything that
   * still fails is reported as `auth.mail.failed` and a warning log, never
   * to the caller.
   */
  readonly dispatch: <E>(meta: MailMeta, work: Effect.Effect<void, E>) => Effect.Effect<void>;
}

export class MailDispatcher extends Context.Service<MailDispatcher, MailDispatcherShape>()(
  "awthaq/core/MailDispatcher",
) {}

const isRetryable = (error: unknown): boolean =>
  error instanceof Mailer.MailDeliveryFailed && error.retryable;

/**
 * Builds a dispatcher owned by the current `Scope` (a plugin's `make`, or a
 * `Layer.effect`). Each plugin that mails builds its own; sharing one across
 * plugins is `layer` below.
 */
export const make = Effect.gen(function* () {
  const settings = yield* MailDispatchConfig;
  const events = yield* AuthEvents.AuthEvents;
  const fibers = yield* FiberSet.make<void, never>();
  const slots = yield* Semaphore.make(settings.concurrency);

  // Registered after the `FiberSet`'s own interrupt-on-close finalizer, so it
  // runs first: in-flight mail gets `drainTimeout` to finish, then whatever
  // remains is interrupted and counted.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const drained = yield* FiberSet.awaitEmpty(fibers).pipe(
        Effect.timeoutOption(settings.drainTimeout),
      );
      if (Option.isNone(drained)) {
        const dropped = yield* FiberSet.size(fibers);
        yield* Effect.logWarning(
          "awthaq: mail dispatch drain timed out; dropping in-flight mail",
        ).pipe(Effect.annotateLogs({ dropped }));
      }
    }),
  );

  const dispatch: MailDispatcherShape["dispatch"] = (meta, work) => {
    const attempt = slots
      .withPermits(1)(work)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential(settings.retryBase).pipe(Schedule.jittered),
          times: settings.retries,
          while: isRetryable,
        }),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failure = Cause.findErrorOption(cause);
            const reason =
              Option.isSome(failure) && failure.value instanceof Mailer.MailDeliveryFailed
                ? failure.value.reason
                : "unexpected failure";
            yield* events.publish({
              _tag: "auth.mail.failed",
              template: meta.template,
              ...(meta.userId === undefined ? {} : { userId: meta.userId }),
            });
            yield* Effect.logWarning("awthaq: mail delivery failed").pipe(
              Effect.annotateLogs({ template: meta.template, reason }),
            );
          }),
        ),
      );
    return FiberSet.run(fibers, attempt).pipe(Effect.asVoid);
  };

  return MailDispatcher.of({ dispatch });
});

/** A dispatcher shared by every plugin composed with this layer (one concurrency bound). */
export const layer = Layer.effect(MailDispatcher, make);
