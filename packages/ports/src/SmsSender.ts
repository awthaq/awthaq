// @awthaq/ports — SmsSender
//
// SOS-002: the capability seam `archive/design/api-design.md` reserved as `auth.sms` (and
// `research/05-oauth-oidc.md` repeats: "SMS: same capability shape, Sms tag"). It mirrors `Mailer`
// deliberately — a plugin that delivers a one-time code, a step-up challenge or a security notice over
// SMS names a template and its interpolation data and requires this port, never a vendor SDK; which
// provider renders and delivers it is the concrete `SmsSender` the application chooses.
//
// The destination is a normalised E.164 number. This stratum sits below `@awthaq/core`, so it types it
// as a plain string; `Phone.normalizePhone` (core) is what produces a well-formed one, and
// `RateLimits.phoneKey` is the recipient-dimension rate-limit key an SMS-sending endpoint pairs with a
// per-IP rule (SOS-007) — the toll-fraud ("SMS pumping") defence is those caps, not this port.

import * as Defects from "./Defects.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

/**
 * As `Mailer`'s `MailMessage` (EOTS-010): the message carries the recipient and, in `data`, credentials
 * (one-time codes). Implementations MUST NOT log, trace or put `to` or `data` into an error or defect
 * message — the only fields safe to report are `template` and the provider's own reason string. Secret
 * values in `data` are `Redacted`; an adapter unwraps them with `Redacted.value` only at the moment it
 * renders the template.
 */
export interface SmsMessage {
  /** A normalised E.164 number (`+15550100`), e.g. from core's `Phone.normalizePhone`. */
  readonly to: string;
  readonly template: string;
  readonly data?: Record<string, unknown>;
}

/**
 * EEM-002: an expected operational failure — the provider is down, throttling, rejected the number or
 * the message — reported in the error channel rather than forced into a defect. Carries no recipient
 * and no `data` (EOTS-010): `template` and `reason` are what a log line or event may show.
 * `retryable` separates a transient outage (retry with backoff) from a permanent rejection (an invalid
 * or unroutable number: give up at once). `cause` is the provider's own error for the adapter's logs.
 */
export class SmsDeliveryFailed extends Data.TaggedError("SmsDeliveryFailed")<{
  readonly template: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export interface SmsSenderShape {
  /**
   * Every caller chooses a policy for `SmsDeliveryFailed`: a caller with an enumeration-uniform response
   * dispatches it in the background and logs the loss; one whose requester is authenticated surfaces it.
   * `layerNoop` still dies — an unconfigured `SmsSender` is a wiring defect, not an outage.
   */
  readonly send: (message: SmsMessage) => Effect.Effect<void, SmsDeliveryFailed>;
  readonly sent: Effect.Effect<ReadonlyArray<SmsMessage>>;
  /**
   * As `Mailer`: set by the implementations that must never reach production (`layerNoop`,
   * `layerMemory`, `layerConsole`). A real provider leaves it unset.
   */
  readonly development?: true;
}

export class SmsSender extends Context.Service<SmsSender, SmsSenderShape>()(
  "awthaq/ports/SmsSender",
) {}

/** "Fails loudly in prod": a code dropped because no provider was wired is a defect, not a silent no-op. */
export const layerNoop: Layer.Layer<SmsSender> = Layer.succeed(
  SmsSender,
  SmsSender.of({
    send: (message) =>
      Defects.invalidConfiguration(
        "SmsSender", // EOTS-010: the template only — never the recipient.
        `awthaq: no SmsSender configured — dropped a "${message.template}" message. ` +
          "Provide a real SmsSender layer (or SmsSender.layerMemory for tests).",
      ),
    sent: Effect.succeed([]),
    development: true,
  }),
);

/** Records every sent message in memory; `sent` reads them back for assertions. */
export const layerMemory: Layer.Layer<SmsSender> = Layer.effect(
  SmsSender,
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<SmsMessage>>([]);
    return SmsSender.of({
      send: (message) => Ref.update(messages, (existing) => [...existing, message]),
      sent: Ref.get(messages),
      development: true,
    });
  }),
);

/**
 * The development stand-in for a real provider: records like `layerMemory` and also logs the message —
 * recipient, template and `data` with any `Redacted` value unwrapped — so a person running an app
 * locally can read a one-time code off the console. **Development only:** it deliberately breaks
 * EOTS-010 (logging the code is its whole purpose) and sets `development`.
 */
export const layerConsole: Layer.Layer<SmsSender> = Layer.effect(
  SmsSender,
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<SmsMessage>>([]);
    return SmsSender.of({
      send: (message) =>
        Effect.logInfo("awthaq sms").pipe(
          Effect.annotateLogs({
            to: message.to,
            template: message.template,
            ...Object.fromEntries(
              Object.entries(message.data ?? {}).map(([key, value]) => [
                key,
                Redacted.isRedacted(value) ? Redacted.value(value) : value,
              ]),
            ),
          }),
          Effect.andThen(Ref.update(messages, (existing) => [...existing, message])),
        ),
      sent: Ref.get(messages),
      development: true,
    });
  }),
);
