// @awthaq/admin — ImpersonationOwnerNotice
//
// ARF-005 (wayfinder ticket 05 §2), BEH-EA-209. Self-service recovery of an account with no
// remaining factor is left to the application (ticket 05: there is no single correct answer
// independent of an application's trust model), which makes support-assisted impersonation the
// realistic recovery path today — and it used to be silent to the very person whose account it
// enters. This is the one mitigation shipped for it: an opt-in subscription that mails the
// account's owner when an impersonation episode starts.
//
// Opt-in and outside `Admin.layer` on purpose: sending mail is a policy the host chooses (and pairs
// with its own `Mailer`), not something installing the admin plugin should start doing. Compose it
// beside the plugin:
//
//   Admin.Admin.layer, ImpersonationOwnerNotice.layer   // + a Mailer and the AuthEvents bus
//
// The mail is the template `impersonation-started` with `{ reason, startedAt }` — the reason the
// admin gave and when it began. It deliberately names neither the session, nor a token, nor the
// admin (the reason is the operator's own note; the audit trail holds the rest for the owner's
// support ticket). A phone or anonymous account has no address to mail and is skipped. It goes
// through a `MailDispatch` dispatcher, so the impersonation itself never waits on the mail provider
// and a lost mail is reported as `auth.mail.failed`, not swallowed.

import { AuthEvents, MailDispatch, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The template the mail is sent under; a `Mailer` adapter renders it. */
export const TEMPLATE = "impersonation-started";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const mailer = yield* Mailer.Mailer;
    const dispatcher = yield* MailDispatch.make;

    return AuthEvents.on("auth.admin.impersonationStarted", (event) =>
      Effect.gen(function* () {
        const target = yield* users.findById(event.targetUserId);
        const to = Users.emailOf(target);
        if (Option.isNone(to)) return;
        yield* dispatcher.dispatch(
          { template: TEMPLATE, userId: target.id },
          mailer.send({
            to: to.value,
            template: TEMPLATE,
            data: { reason: event.reason, startedAt: DateTime.formatIso(event.occurredAt) },
          }),
        );
      }),
    );
  }),
);
