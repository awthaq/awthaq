// @awthaq/core — EmailChange
//
// BAM-009/BAM-005 (BEH-EA-042, BEH-EA-057/058): the one definition of the `change-email`
// verification purpose that every plugin which can *start* an address change shares, so the
// mail a user's own request produces (`@awthaq/password`) and the mail an administrator's
// request produces (`@awthaq/admin`) are the same token with the same payload, and one
// confirmation endpoint (`@awthaq/password`'s) consumes both.
//
// The token is issued on the *account* (`userId` on the row) with the new address in its payload
// and mailed to the *new* address only, so consuming it proves control of that mailbox — the
// address is never replaced on anyone's say-so, and never before its owner has proven it.
// Consumption commits together with `Users.changeEmail` + `Users.verifyEmail` (BEH-EA-058); that
// half lives with the confirming endpoint.

import { Mailer } from "@awthaq/ports";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StoreUnavailable } from "./Errors.ts";
import type { UserId } from "./Users.ts";
import * as VerificationLink from "./VerificationLink.ts";
import type { VerificationShape } from "./Verification.ts";

/** The purpose prefix of the mailed token (`change-email:<publicId>.<secret>`). */
export const PURPOSE = "change-email";

/** The mail template a change-email token is sent with. */
export const TEMPLATE = "change-email";

/** How long the confirmation link lives: the same day a verify-email link does. */
export const DEFAULT_TTL = Duration.hours(24);

/** What the token row carries beside the account id: the address being proven. */
export const Payload = Schema.Struct({ newEmail: Schema.String });
export type Payload = typeof Payload.Type;

const decodePayload = Schema.decodeUnknownOption(Payload);

/** The new address a consumed token's payload names, or `None` for a row this flow did not issue. */
export const newEmailOf = (payload: unknown): Option.Option<string> =>
  Option.map(decodePayload(payload), (decoded) => decoded.newEmail);

/**
 * Issues a `change-email` token for `userId` and mails it to `newEmail`, awaited: both callers
 * are authenticated (the user themselves, or an administrator), so there is no enumeration
 * oracle to protect and a delivery failure is worth telling the requester about. It surfaces as
 * the typed `MailDeliveryFailed` (`template` and `reason` only, never the address or the token).
 * Each call mints a fresh token; an older undelivered one simply expires.
 */
export const request = (
  deps: {
    readonly verification: VerificationShape;
    readonly crypto: Crypto.Crypto;
    readonly mailer: Mailer.MailerShape;
  },
  input: {
    readonly userId: UserId;
    readonly newEmail: string;
    readonly ttl?: Duration.Duration;
    readonly link?: ((token: string) => string) | undefined;
  },
): Effect.Effect<void, Mailer.MailDeliveryFailed | StoreUnavailable> =>
  Effect.gen(function* () {
    const issued = yield* VerificationLink.issue(deps, {
      purpose: PURPOSE,
      ttl: input.ttl ?? DEFAULT_TTL,
      userId: input.userId,
      payload: { newEmail: input.newEmail } satisfies Payload,
    });
    yield* deps.mailer.send({
      to: input.newEmail,
      template: TEMPLATE,
      data: VerificationLink.mailData({
        token: issued.token,
        expiresAt: issued.expiresAt,
        link: input.link,
      }),
    });
  });
