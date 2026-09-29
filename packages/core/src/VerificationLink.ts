// @awthaq/core — VerificationLink
//
// spec/behaviors/08-verification-tokens.md, BEH-EA-057. The shared, purpose-
// checked codec every plugin that mails a `Verification` token uses (password
// reset and verify-email today; magic-link, email-otp, two-factor and
// impersonation notices next), so the bugs that codec closes — a token of one
// purpose accepted by another purpose's endpoint (ARF-007), a user id embedded
// in a mailed artifact (ARF-009), no expiry or link in the mail (MLO-009) —
// are fixed once rather than per plugin.
//
// A mailed token is `<identifier>.<secret>`; `identifier` is
// `<purpose>:<publicId>` and names the `Verification` row (its `consume` needs
// it to look the row up at all), `secret` is the row's own value. `publicId`
// is 128 random bits, base64url — it identifies the token, never the user
// (ARF-009); the user is recovered from the consumed row's `userId`. None of
// `purpose`, `publicId` or `secret` can contain a literal `.`, so splitting on
// the last `.` round-trips exactly.

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { storeUnavailable, type StoreUnavailable } from "./Errors.ts";
import type { UserId } from "./Users.ts";
import type { VerificationShape, VerificationTokenView } from "./Verification.ts";

export interface DecodedToken {
  /** The `Verification` row's identifier, `<purpose>:<publicId>`. */
  readonly identifier: string;
  readonly publicId: string;
  readonly value: Redacted.Redacted<string>;
}

/** A fresh, unguessable, user-independent id for one token. */
export const newPublicId = (crypto: Crypto.Crypto) =>
  crypto.randomBytes(16).pipe(Effect.map((bytes) => Encoding.encodeBase64Url(bytes)));

export const identifierOf = (purpose: string, publicId: string): string => `${purpose}:${publicId}`;

/** The token string handed to the recipient. Redacted: it is a credential. */
export const encode = (input: {
  readonly purpose: string;
  readonly publicId: string;
  readonly value: Redacted.Redacted<string>;
}): Redacted.Redacted<string> =>
  Redacted.make(`${identifierOf(input.purpose, input.publicId)}.${Redacted.value(input.value)}`);

/**
 * `None` for anything that is not a well-formed token of exactly `purpose` —
 * a missing separator, an empty half, or another purpose's prefix — so an
 * endpoint answers it the way it answers any unknown token, before rate
 * limiting, consuming or slicing it.
 */
export const decode = (raw: string, purpose: string): Option.Option<DecodedToken> => {
  const separator = raw.lastIndexOf(".");
  if (separator <= 0 || separator === raw.length - 1) return Option.none();
  const identifier = raw.slice(0, separator);
  const prefix = `${purpose}:`;
  if (!identifier.startsWith(prefix) || identifier.length === prefix.length) return Option.none();
  return Option.some({
    identifier,
    publicId: identifier.slice(prefix.length),
    value: Redacted.make(raw.slice(separator + 1)),
  });
};

export interface IssuedLink {
  readonly token: Redacted.Redacted<string>;
  readonly publicId: string;
  readonly expiresAt: DateTime.Utc;
  readonly view: VerificationTokenView;
}

/**
 * Mints a `Verification` row under a fresh public id and returns the mailable
 * token. `userId` rides on the row (BCR-003) so the consuming endpoint can
 * recover it without it ever appearing in the token.
 */
export const issue = (
  deps: { readonly verification: VerificationShape; readonly crypto: Crypto.Crypto },
  input: {
    readonly purpose: string;
    readonly ttl: Duration.Duration;
    readonly userId?: UserId;
    readonly payload?: unknown;
  },
): Effect.Effect<IssuedLink, StoreUnavailable> =>
  Effect.gen(function* () {
    const publicId = yield* newPublicId(deps.crypto).pipe(
      Effect.catchTag("PlatformError", storeUnavailable("VerificationLink.issue")),
    );
    const { token, value } = yield* deps.verification.issue({
      identifier: identifierOf(input.purpose, publicId),
      ttl: input.ttl,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    });
    return {
      token: encode({ purpose: input.purpose, publicId, value }),
      publicId,
      expiresAt: token.expiresAt,
      view: token,
    };
  });

/**
 * The `data` a mail template receives for a mailed token. `token` stays
 * `Redacted` (EOTS-010: an adapter unwraps it only to render); `expiresAt` is
 * always present so a template can say how long the link lives; `url` is set
 * when the application configured a link builder — prefer a page that
 * consumes the token from the URL fragment or a POST, never a token in a
 * query string a GET handler acts on (mail scanners prefetch links).
 */
export const mailData = (input: {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
  readonly link?: ((token: string) => string) | undefined;
}): {
  readonly token: Redacted.Redacted<string>;
  readonly url?: string;
  readonly expiresAt: string;
} => ({
  token: input.token,
  ...(input.link === undefined ? {} : { url: input.link(Redacted.value(input.token)) }),
  expiresAt: DateTime.formatIso(input.expiresAt),
});
