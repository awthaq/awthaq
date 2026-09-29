// @awthaq/ports — Mailer
//
// spec/overview.md's Ports stratum table ("Mailer (layerNoop, layerMemory)")
// and archive/PRD.md's own table: "layerNoop (fails loudly in prod),
// layerMemory (records)". No BEH-EA range is allocated for the Ports
// stratum yet (spec/traceability.md); this module is grounded directly in
// the cited spec/archive sources rather than a numbered behavior.
//
// The message shape (`to`, `template`, `data`) and the `send` signature are
// reproduced from the two call sites shown in archive/design's own
// examples — `usage-examples-v4.md` §17's
// `Mailer.use((m) => m.send({ to: user.email, template: "welcome" }))` and
// `api-design-v4.md`'s
// `mailer.send({ to: amended.email, template: "invite", data: { token } })`
// — a plugin (verification/reset/invite) names a template and its
// interpolation data; which provider renders and delivers that template is
// exactly the concrete `Mailer` implementation the application chooses.
//
// `layerMemory`'s recorded messages are read back through the `sent` field
// on the service shape itself (`archive/design/usage-examples-v4.md` §17:
// "Mailer.layerMemory // records; Mailer.sent to assert") rather than a
// second service or a module-level ref, so a test can assert against
// whichever `Mailer` layer it happened to provide without needing to know
// which one it was.

import * as Defects from "./Defects.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * EOTS-010: a message carries the recipient and, in `data`, credentials
 * (reset/verify tokens, links). Implementations MUST NOT log, trace or put
 * `to` or `data` into an error or defect message — the only fields safe to
 * report are `template` and the provider's own reason string. Secret values
 * in `data` (tokens) are `Redacted`; an adapter unwraps them with
 * `Redacted.value` only at the moment it renders the template.
 */
export interface MailMessage {
  readonly to: string;
  readonly template: string;
  readonly data?: Record<string, unknown>;
}

/**
 * EEM-002: an expected operational failure — the provider is down, rate
 * limiting, rejected the message — reported in the error channel rather than
 * forced into a defect. Deliberately carries no recipient and no `data`
 * (EOTS-010: no PII, no tokens): `template` and `reason` are what a log line
 * or `auth.mail.failed` event may show. `retryable` lets the dispatcher tell
 * a transient outage (retry with backoff) from a permanent rejection (give up
 * at once). `cause` is the provider's own error for the adapter's logs; it is
 * never rendered by awthaq.
 */
export class MailDeliveryFailed extends Data.TaggedError("MailDeliveryFailed")<{
  readonly template: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export interface MailerShape {
  /**
   * Every caller chooses a policy for `MailDeliveryFailed`: a caller with an
   * enumeration-uniform response (password reset/verification) dispatches it
   * in the background and logs the loss; a caller whose requester is
   * authenticated (an organization invitation) surfaces it. `layerNoop`
   * still dies — an unconfigured `Mailer` is a wiring defect, not an outage.
   */
  readonly send: (message: MailMessage) => Effect.Effect<void, MailDeliveryFailed>;
  readonly sent: Effect.Effect<ReadonlyArray<MailMessage>>;
  /**
   * ECS-005/BEH-EA-201: set by the implementations that must never reach production
   * (`layerNoop`, `layerMemory`) so `awthaq doctor --build` can flag one left in a
   * production composition. A real provider leaves it unset.
   */
  readonly development?: true;
}

export class Mailer extends Context.Service<Mailer, MailerShape>()("awthaq/ports/Mailer") {}

/**
 * "Fails loudly in prod" (`archive/PRD.md`): an application that reaches
 * production with no real `Mailer` provided gets a defect the moment
 * anything tries to send mail, not a silently dropped verification or
 * reset email.
 */
export const layerNoop: Layer.Layer<Mailer> = Layer.succeed(
  Mailer,
  Mailer.of({
    send: (message) =>
      Defects.invalidConfiguration("Mailer", // EOTS-010: the template only — never the recipient.
          `awthaq: no Mailer configured — dropped a "${message.template}" message. ` +
            "Provide a real Mailer layer (or Mailer.layerMemory for tests)."),
    sent: Effect.succeed([]),
    development: true,
  }),
);

/** Records every sent message in memory; `sent` reads them back for assertions. */
export const layerMemory: Layer.Layer<Mailer> = Layer.effect(
  Mailer,
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<MailMessage>>([]);
    return Mailer.of({
      send: (message) => Ref.update(messages, (existing) => [...existing, message]),
      sent: Ref.get(messages),
      development: true,
    });
  }),
);
