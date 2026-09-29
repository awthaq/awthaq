// @awthaq/oauth — ProviderHttp
//
// ECF-001/EEM-004/ERS-003: the shared plumbing every outbound provider call
// goes through — a retrying client for the idempotent GETs, a body decoder
// that tells "the provider is down" (5xx/429) from "the provider answered
// with something we reject", and the classifier that maps a failed call onto
// the wire's two distinct outcomes (`ProviderUnavailable` 503 vs
// `OAuthCallbackFailed` 400).

import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";

/** The provider answered 5xx/429: its failure, not a malformed answer. */
class ProviderServerError extends Data.TaggedError("ProviderServerError")<{
  readonly status: number;
}> {}

/** The provider answered, but not 2xx (a 4xx rejection, an unexpected redirect): a protocol failure. */
class ProviderRejectedError extends Data.TaggedError("ProviderRejectedError")<{
  readonly status: number;
}> {}

/**
 * ERS-003: retries for the *idempotent* provider GETs only (JWKS, userinfo,
 * discovery) — jittered exponential backoff inside each call's deadline.
 * The code exchange is never retried: an authorization code is single-use
 * (RFC 6749 §4.1.2), so a replay after an ambiguous failure would turn a
 * transient error into a permanent one.
 */
export interface OAuthRetryPolicy {
  /** Extra attempts after the first (`0` disables retrying). */
  readonly times: number;
  readonly base: Duration.Duration;
}

/**
 * ERS-003: a client that retries transient failures (transport errors,
 * 408/429/5xx) with jittered exponential backoff. Only ever used for
 * idempotent GETs — never for the single-use code exchange.
 */
export const retrying = (
  client: HttpClient.HttpClient,
  policy: OAuthRetryPolicy,
): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      times: policy.times,
      schedule: Schedule.exponential(policy.base).pipe(Schedule.jittered),
    }),
  );

/**
 * Decodes a provider's JSON body with `schema`, first sorting the status:
 * 5xx/429 becomes `ProviderServerError` (a 5xx body is usually an HTML error
 * page, and reporting that as "malformed response" would misfile a provider
 * outage as a protocol failure) and any other non-2xx becomes
 * `ProviderRejectedError` (so a userinfo `401 {"error":...}` body can never
 * be mistaken for a claim set).
 */
export const decodeBody =
  <S extends Schema.Constraint>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status >= 500 || response.status === 429) {
        return yield* new ProviderServerError({ status: response.status });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new ProviderRejectedError({ status: response.status });
      }
      return yield* HttpIncomingMessage.schemaBodyJson(schema)(response);
    });

/** Transport failures, deadline overruns and 5xx/429 answers: the provider (or the path to it) is unavailable. */
export const isUnavailable = (error: unknown): boolean =>
  error instanceof ProviderServerError ||
  Cause.isTimeoutError(error) ||
  (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError");
