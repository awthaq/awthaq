// BEH-EA-359 / ADR-EA-054: one recording behind the `Mailer` and `SmsSender` ports, and a `Mailbox` a suite reads
// it through. A port carries only what a production adapter implements (`send`); waiting for the mail a detached
// fiber sends, refuting one, and reading a mailed secret live here, once.
//
// Suites run under `TestClock`, so every deadline here is a real timer (`setTimeout`), never `Clock`, `sleep` or
// `timeout`. A failure text names the template, the position and the count recorded; never a recipient or `data`
// (EOTS-010).
import { Mailer, SmsSender } from "@awthaq/ports";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as DurationModule from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Which recorded messages a wait or a refutation is about: fields to equal, or a predicate. */
export type Match<M> =
  | { readonly to?: string; readonly template?: string }
  | ((message: M) => boolean);

export interface Outbox<M extends { readonly to: string; readonly template: string }> {
  /** Every message recorded so far, in send order. */
  readonly messages: Effect.Effect<ReadonlyArray<M>>;
  /**
   * The nth (1-based, default 1) message matching `match`, as soon as it is recorded. Dies at a real-clock deadline
   * (default 5 s) naming the match and the count, never a recipient or data.
   */
  readonly waitFor: (
    match: Match<M>,
    options?: { readonly nth?: number; readonly timeout?: Duration.Input },
  ) => Effect.Effect<M>;
  /**
   * Dies if more than `beyond` (default 0) matching messages are recorded already or within `window` real time
   * (default 50 ms). `refute(m)` is "none"; `refute(m, { beyond: 1 })` is "exactly the one I awaited".
   */
  readonly refute: (
    match: Match<M>,
    options?: { readonly beyond?: number; readonly window?: Duration.Input },
  ) => Effect.Effect<void>;
}

export interface MailboxShape {
  readonly mail: Outbox<Mailer.MailMessage>;
  readonly sms: Outbox<SmsSender.SmsMessage>;
}

export class Mailbox extends Context.Service<Mailbox, MailboxShape>()("awthaq/test/Mailbox") {}

const matches =
  <M extends { readonly to: string; readonly template: string }>(match: Match<M>) =>
  (message: M) =>
    typeof match === "function"
      ? match(message)
      : (match.to === undefined || match.to === message.to) &&
        (match.template === undefined || match.template === message.template);

/** What a failure may say about a match: the template, and whether a recipient was asked for (never which). */
const describe = <M>(match: Match<M>) =>
  typeof match === "function"
    ? "a predicate"
    : `template ${match.template ?? "(any)"}${match.to === undefined ? "" : " for a given recipient"}`;

/** A real-clock timer that runs `onFire` after `duration`; interruption clears it. */
const realTimer = <A>(duration: Duration.Input, onFire: () => Effect.Effect<A>) =>
  Effect.callback<A>((resume) => {
    const handle = setTimeout(() => resume(onFire()), DurationModule.toMillis(duration));
    return Effect.sync(() => clearTimeout(handle));
  });

/**
 * Each snapshot of the recording, starting with the current one: subscribe first, then read, so an append between
 * the two shows up in both rather than in neither.
 */
const untilSnapshot = <M, A>(
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<M>>,
  decide: (snapshot: ReadonlyArray<M>) => A | undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(ref.pubsub);
      let snapshot = yield* SubscriptionRef.get(ref);
      let decided = decide(snapshot);
      while (decided === undefined) {
        snapshot = yield* PubSub.take(subscription);
        decided = decide(snapshot);
      }
      return decided;
    }),
  );

const makeOutbox = <M extends { readonly to: string; readonly template: string }>() =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<ReadonlyArray<M>>([]);
    const record = (message: M) =>
      SubscriptionRef.update(ref, (existing) => [...existing, message]);
    const outbox: Outbox<M> = {
      messages: SubscriptionRef.get(ref),
      waitFor: (match, options = {}) => {
        const nth = options.nth ?? 1;
        const found = untilSnapshot(ref, (snapshot) => snapshot.filter(matches(match))[nth - 1]);
        const deadline = realTimer(options.timeout ?? "5 seconds", () =>
          Effect.flatMap(SubscriptionRef.get(ref), (recorded) =>
            Effect.die(
              new Error(
                `no mail matching ${describe(match)} (#${nth}) arrived in time; ${recorded.length} recorded`,
              ),
            ),
          ),
        );
        return Effect.raceFirst(found, deadline);
      },
      refute: (match, options = {}) => {
        const beyond = options.beyond ?? 0;
        const tooMany = untilSnapshot(ref, (snapshot) =>
          snapshot.filter(matches(match)).length > beyond ? snapshot.length : undefined,
        ).pipe(
          Effect.flatMap((recorded) =>
            Effect.die(
              new Error(
                `more than ${beyond} mail matching ${describe(match)} was recorded (${recorded} in all)`,
              ),
            ),
          ),
        );
        return Effect.raceFirst(
          tooMany,
          realTimer(options.window ?? "50 millis", () => Effect.void),
        );
      },
    };
    return { outbox, record };
  });

/** `Mailer` and `SmsSender` (both `development: true`) recording into one `Mailbox`. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const mail = yield* makeOutbox<Mailer.MailMessage>();
    const sms = yield* makeOutbox<SmsSender.SmsMessage>();
    return Context.make(
      Mailer.Mailer,
      Mailer.Mailer.of({
        send: mail.record,
        development: true,
      }),
    ).pipe(
      Context.add(
        SmsSender.SmsSender,
        SmsSender.SmsSender.of({
          send: sms.record,
          development: true,
        }),
      ),
      Context.add(Mailbox, Mailbox.of({ mail: mail.outbox, sms: sms.outbox })),
    );
  }),
);

/** A mailed value (`"token"` by default), `Redacted` or plain. Throws naming the field and template when absent. */
export const secret = (
  message: { readonly template: string; readonly data?: Record<string, unknown> },
  field = "token",
): string => {
  const value = message.data?.[field];
  if (Redacted.isRedacted(value)) return String(Redacted.value(value));
  if (typeof value === "string") return value;
  throw new Error(`expected "${field}" in the "${message.template}" mail`);
};
