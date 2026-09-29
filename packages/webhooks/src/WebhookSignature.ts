// @awthaq/webhooks — WebhookSignature
//
// CWM-004 (ADR-EA-030 Decision 7): the signing scheme, the one the Standard Webhooks
// specification (standardwebhooks.com) defines and the svix libraries Clerk consumers already
// use verify, so a migrating receiver keeps its verification code:
//
//   webhook-id         the event id (`eventId`), stable across every retry — the receiver's
//                      idempotency key
//   webhook-timestamp  Unix seconds of *this attempt* (each retry is re-stamped, so a retry is
//                      never outside the receiver's replay window)
//   webhook-signature  `v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>` with the endpoint's
//                      secret; several space-separated `v1,` values while a rotated-out secret is
//                      still inside its grace window, so a receiver can accept either
//
// The secret is `whsec_` + base64 of 32 random bytes; the *decoded* bytes are the HMAC key. A
// receiver verifies with `verify` below (or any Standard Webhooks library): it rejects a missing
// header, a timestamp outside `tolerance` (the replay window; default 5 minutes, both directions,
// so a captured request cannot be replayed later) and compares the signatures in constant time.

import { Hmac } from "@awthaq/ports";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

export const SECRET_PREFIX = "whsec_";
export const SECRET_BYTES = 32;
export const DEFAULT_TOLERANCE = Duration.minutes(5);

/** A fresh endpoint secret. Shown to the administrator once; only the sealed form is stored. */
export const generateSecret = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(SECRET_BYTES).pipe(Effect.orDie);
  return Redacted.make(`${SECRET_PREFIX}${Encoding.encodeBase64(bytes)}`);
});

/** The HMAC key: the base64-decoded bytes after the `whsec_` prefix (the whole string, UTF-8, when it has none). */
const keyBytes = (secret: Redacted.Redacted<string>): Uint8Array => {
  const raw = Redacted.value(secret);
  if (!raw.startsWith(SECRET_PREFIX)) return new TextEncoder().encode(raw);
  return Result.getOrElse(Encoding.decodeBase64(raw.slice(SECRET_PREFIX.length)), () =>
    new TextEncoder().encode(raw),
  );
};

export interface SignedMessage {
  /** The event id. */
  readonly id: string;
  /** Unix seconds of this delivery attempt. */
  readonly timestamp: number;
  /** The exact bytes sent as the request body. */
  readonly body: string;
}

const signedContent = (message: SignedMessage): Uint8Array =>
  new TextEncoder().encode(`${message.id}.${message.timestamp}.${message.body}`);

/** `v1,<base64>` for one secret. */
export const sign = (secret: Redacted.Redacted<string>, message: SignedMessage) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const mac = yield* Hmac.hmacSha256(crypto, keyBytes(secret), signedContent(message)).pipe(
      Effect.orDie,
    );
    return `v1,${Encoding.encodeBase64(mac)}`;
  });

/** The three request headers, signed under every secret in `secrets` (the current one, and the previous one inside its grace window). */
export const headersFor = (secrets: ReadonlyArray<Redacted.Redacted<string>>, message: SignedMessage) =>
  Effect.gen(function* () {
    const signatures = yield* Effect.forEach(secrets, (secret) => sign(secret, message));
    return {
      "webhook-id": message.id,
      "webhook-timestamp": String(message.timestamp),
      "webhook-signature": signatures.join(" "),
    };
  });

export type SignatureFailure =
  | "missingHeaders"
  | "malformedTimestamp"
  | "timestampOutsideTolerance"
  | "noMatchingSignature";

/** The receiver-side refusal; `reason` says which check failed (a receiver answers 400 for all of them). */
export class InvalidWebhookSignature extends Data.TaggedError("InvalidWebhookSignature")<{
  readonly reason: SignatureFailure;
}> {}

export interface VerifyInput {
  /** Every secret the receiver still accepts (rotation overlap). */
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
  /** Request headers, names lower-cased. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The raw request body, exactly as received. */
  readonly body: string;
  /** The replay window, both directions. Default 5 minutes. */
  readonly tolerance?: Duration.Input;
  /** Unix seconds "now"; defaults to the ambient clock. */
  readonly nowSeconds?: number;
}

/**
 * Receiver-side verification. Succeeds with the event id (the idempotency key) when the timestamp is
 * inside the replay window and at least one presented `v1` signature matches one accepted secret.
 * Every comparison is constant-time and every candidate is checked (no early exit on a match),
 * so the response does not reveal which secret matched or how close a forgery was.
 */
export const verify = (input: VerifyInput) =>
  Effect.gen(function* () {
    const id = input.headers["webhook-id"];
    const timestampHeader = input.headers["webhook-timestamp"];
    const signatureHeader = input.headers["webhook-signature"];
    if (id === undefined || timestampHeader === undefined || signatureHeader === undefined) {
      return yield* Effect.fail(new InvalidWebhookSignature({ reason: "missingHeaders" }));
    }
    const timestamp = /^\d{1,12}$/.test(timestampHeader) ? Number(timestampHeader) : Number.NaN;
    if (!Number.isSafeInteger(timestamp)) {
      return yield* Effect.fail(new InvalidWebhookSignature({ reason: "malformedTimestamp" }));
    }
    const nowSeconds =
      input.nowSeconds ?? Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
    const toleranceSeconds = Duration.toSeconds(
      Duration.fromInputUnsafe(input.tolerance ?? DEFAULT_TOLERANCE),
    );
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
      return yield* Effect.fail(
        new InvalidWebhookSignature({ reason: "timestampOutsideTolerance" }),
      );
    }
    const presented = signatureHeader
      .split(" ")
      .filter((part) => part.startsWith("v1,"))
      .map((part) => part.slice(3));
    let matched = false;
    for (const secret of input.secrets) {
      const expected = (yield* sign(secret, { id, timestamp, body: input.body })).slice(3);
      for (const candidate of presented) {
        if (Hmac.constantTimeEqualString(candidate, expected)) matched = true;
      }
    }
    if (!matched) {
      return yield* Effect.fail(new InvalidWebhookSignature({ reason: "noMatchingSignature" }));
    }
    return id;
  });
