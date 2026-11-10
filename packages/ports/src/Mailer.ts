// @awthaq/ports — Mailer
//
// spec/overview.md's Ports stratum table ("Mailer (layerNoop, layerConsole)")
// and archive/PRD.md's own table: "layerNoop (fails loudly in prod)". No BEH-EA range is allocated for the Ports
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
// Observing sent mail is test tooling, not part of this port: `@awthaq/test`'s `TestMailbox` records and
// waits for it (ADR-EA-054), so a provider adapter implements `send` and nothing else.

import * as Defects from "./Defects.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

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
  /**
   * ECS-005/BEH-EA-201: set by the implementations that must never reach production
   * (`layerNoop`, `layerConsole`) so `awthaq doctor --build` can flag one left in a
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
      Defects.invalidConfiguration(
        "Mailer", // EOTS-010: the template only — never the recipient.
        `awthaq: no Mailer configured — dropped a "${message.template}" message. ` +
          "Provide a real Mailer layer (or TestMailbox.layer from @awthaq/test for tests).",
      ),
    development: true,
  }),
);

/**
 * DESS-002: the development stand-in for a real provider. Logs every message — the recipient, the template and the `data`
 * with any `Redacted` value unwrapped — so a person running an app locally can copy a
 * verification or reset token straight out of the console and finish the flow
 * without an inbox.
 *
 * **Development only.** This is the one `Mailer` that deliberately breaks EOTS-010
 * (no recipient, no token in a log line): logging the token is its whole purpose. It
 * sets `development`, so `awthaq doctor --build` flags it in a production composition.
 */
export const layerConsole: Layer.Layer<Mailer> = Layer.succeed(
  Mailer,
  Mailer.of({
    send: (message) =>
      Effect.logInfo("awthaq mail").pipe(
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
      ),
    development: true,
  }),
);
