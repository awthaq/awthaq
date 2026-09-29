// @awthaq/oauth — CallbackFailure
//
// OIT-008: the wire error of a failed callback stays opaque and field-less
// (BEH-EA-086/122 — which stage failed is exactly what a probing attacker
// must not learn from the response), but an operator debugging a real
// provider integration needs to know *why*. Every failure site therefore goes
// through `callbackFailed(reason)`, which logs the discriminated reason and
// annotates the current span before failing with the unchanged, reason-free
// `OAuthCallbackFailed`.

import * as Effect from "effect/Effect";
import * as OAuthApi from "./OAuthApi.ts";
import * as ProviderHttp from "./ProviderHttp.ts";

export type CallbackFailureReason =
  | "state-malformed"
  | "state-cookie-mismatch"
  | "flow-consumed"
  | "flow-invalid"
  | "decrypt"
  | "iss-mismatch"
  | "error-redirect"
  | "token-exchange"
  | "id-token-missing"
  | "jwt-malformed"
  | "alg"
  | "jwks"
  | "kid"
  | "signature"
  | "iss"
  | "sub"
  | "aud"
  | "azp"
  | "exp"
  | "nbf"
  | "iat"
  | "nonce"
  | "missing-nonce"
  | "userinfo"
  | "userinfo-sub-mismatch"
  | "no-subject"
  | "account-already-linked"
  | "provider-unavailable"
  // MNA-003: the native exchange-code redemption.
  | "exchange-malformed"
  | "exchange-consumed"
  | "exchange-invalid"
  | "exchange-verifier";

/**
 * Logs why a callback failed (level warn, `reason` annotated, plus an optional
 * non-secret `detail`) and fails with the opaque `OAuthCallbackFailed`. The
 * reason never reaches the response body.
 */
export const callbackFailed = (reason: CallbackFailureReason, detail?: string) =>
  Effect.logWarning(`oauth callback failed: ${reason}`).pipe(
    Effect.annotateLogs({ reason, ...(detail === undefined ? {} : { detail }) }),
    Effect.andThen(Effect.annotateCurrentSpan("oauth.failure_reason", reason)),
    Effect.andThen(Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  );

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined;

/**
 * EEM-004 + OIT-008: an outbound provider call failed. Availability failures
 * (transport, deadline, 5xx/429) surface as `ProviderUnavailable`; anything
 * else is a protocol failure logged under `stage` and surfaced as the opaque
 * `OAuthCallbackFailed`.
 */
export const providerFailure = (stage: "token-exchange" | "jwks" | "userinfo", error: unknown) =>
  Effect.gen(function* () {
    if (ProviderHttp.isUnavailable(error)) {
      yield* Effect.logWarning(`oauth provider unavailable: ${stage}`).pipe(
        Effect.annotateLogs({ reason: "provider-unavailable", stage, detail: tagOf(error) ?? "" }),
      );
      return yield* Effect.fail(new OAuthApi.ProviderUnavailable());
    }
    return yield* callbackFailed(stage, tagOf(error));
  });
