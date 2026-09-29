// @awthaq/oauth — IdToken
//
// spec/behaviors/16-oauth.md, BEH-EA-127 (claims side): verification of an
// OIDC `id_token` — RS256 signature against the provider's JWKS (`Jwt.ts`),
// then the claim checks OIDC Core 3.1.3.7 requires. Split out of `OAuth.ts`
// so the claim rules are one pure, individually testable function and the
// callback handler stays about the flow.
//
// Time comes from the Effect `Clock` (MA-002), read once per verification, so
// expiry, `iat`/`nbf` and the JWKS cache age are all driven by `TestClock` in
// tests and agree with each other within one verification.

import { RefreshingCache } from "@awthaq/ports";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as CallbackFailure from "./CallbackFailure.ts";
import * as Jwt from "./Jwt.ts";
import type * as OAuthApi from "./OAuthApi.ts";
import type * as OAuthProvider from "./OAuthProvider.ts";
import * as ProviderHttp from "./ProviderHttp.ts";

type JwksFailure = OAuthApi.OAuthCallbackFailed | OAuthApi.ProviderUnavailable;

/**
 * JJS-001/KRS-004/OIT-002: bounds how long a provider-removed JWKS key keeps
 * verifying tokens. The kid-miss refetch already converges as soon as a
 * provider *rotates in* a new kid; a TTL additionally converges the case a
 * `kid` cache miss never catches at all — a key the provider has *removed*,
 * with no new kid ever presented to force a refetch.
 */
const JWKS_CACHE_TTL = Duration.minutes(15);

/**
 * ECF-002: at most one forced refetch (an unknown `kid`) per this interval, and a failed
 * fetch is replayed for as long — so a flood of forged tokens, or an unreachable JWKS
 * endpoint, costs the provider one request per interval rather than one per callback.
 */
const JWKS_MIN_REFETCH_INTERVAL = Duration.seconds(30);

/**
 * ECF-002: one single-flight, TTL'd `RefreshingCache` per (provider, `jwks_uri`), created on
 * first use. Keyed by the URI as well as the id so a connection whose discovery changed can
 * never be served the old endpoint's keys.
 */
interface JwksCaches {
  readonly forProvider: (
    provider: OAuthProvider.ResolvedProvider,
    jwksUri: string,
    load: Effect.Effect<Jwt.Jwks, JwksFailure>,
  ) => Effect.Effect<RefreshingCache.RefreshingCache<Jwt.Jwks, JwksFailure>>;
}

export const makeJwksCaches = Effect.gen(function* () {
  const caches = new Map<string, RefreshingCache.RefreshingCache<Jwt.Jwks, JwksFailure>>();
  const creation = yield* Semaphore.make(1);
  const forProvider: JwksCaches["forProvider"] = (provider, jwksUri, load) =>
    creation.withPermit(
      Effect.gen(function* () {
        const key = `${provider.id}\n${jwksUri}`;
        const existing = caches.get(key);
        if (existing !== undefined) return existing;
        const created = yield* RefreshingCache.make(load, {
          ttl: JWKS_CACHE_TTL,
          minRefetchInterval: JWKS_MIN_REFETCH_INTERVAL,
        });
        caches.set(key, created);
        return created;
      }),
    );
  return { forProvider };
});

/**
 * OIT-003 (OIDC Core 3.1.3.7 rules 3–5): `aud` is a string equal to the
 * client id, or an array of strings containing it. With several audiences
 * `azp` must be present and equal the client id, and whenever `azp` is
 * present at all it must equal the client id. Narrowing only — no casts.
 */
const audienceProblem = (
  claims: Record<string, unknown>,
  clientId: string,
): "aud" | "azp" | undefined => {
  const aud = claims["aud"];
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.every((value) => typeof value === "string") || !audiences.includes(clientId)) {
    return "aud";
  }
  const azp = claims["azp"];
  if (azp !== undefined && azp !== clientId) return "azp";
  if (audiences.length > 1 && azp !== clientId) return "azp";
  return undefined;
};

interface ClaimExpectations {
  readonly clientId: string;
  /** `undefined` only for a provider that (mis)declared none; then no `iss` can match. */
  readonly issuer: string | undefined;
  /** OIT-006: mandatory — an oidc flow always carries one, and the verifier never runs without. */
  readonly nonce: string;
  readonly nowMs: number;
  /** OIT-004: leeway applied to `exp`, `nbf` and `iat`. */
  readonly skewMs: number;
  /** OIT-004: optional defence in depth — reject a token whose `iat` is older than this. */
  readonly maxAgeMs: number | undefined;
}

/**
 * The claim checks, as a pure function: the reason the first failing check
 * names, or `undefined` when the claims are acceptable (OIT-008 logs it).
 */
const claimProblem = (
  claims: Record<string, unknown>,
  expected: ClaimExpectations,
): CallbackFailure.CallbackFailureReason | undefined => {
  if (claims["iss"] !== expected.issuer) return "iss";
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub === "") return "sub";
  const audience = audienceProblem(claims, expected.clientId);
  if (audience !== undefined) return audience;

  const exp = claims["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "exp";
  if (expected.nowMs >= exp * 1000 + expected.skewMs) return "exp";

  if ("nbf" in claims) {
    const nbf = claims["nbf"];
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) return "nbf";
    if (expected.nowMs + expected.skewMs < nbf * 1000) return "nbf";
  }

  const iat = claims["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat)) return "iat";
    if (iat * 1000 > expected.nowMs + expected.skewMs) return "iat";
    if (expected.maxAgeMs !== undefined && expected.nowMs - iat * 1000 > expected.maxAgeMs) {
      return "iat";
    }
  } else if (expected.maxAgeMs !== undefined) {
    return "iat";
  }

  if (claims["nonce"] !== expected.nonce) return "nonce";
  return undefined;
};

export interface VerifyInput {
  /** The retrying client (ERS-003): JWKS is an idempotent GET. */
  readonly httpClient: HttpClient.HttpClient;
  readonly jwksCaches: Effect.Success<typeof makeJwksCaches>;
  readonly provider: OAuthProvider.ResolvedProvider;
  readonly idToken: string;
  readonly nonce: string;
  readonly jwksTimeout: Duration.Duration;
  readonly clockSkew: Duration.Duration;
  readonly maxIdTokenAge: Option.Option<Duration.Duration>;
}

/**
 * Verifies an `id_token` and returns its (now trusted) claims. Failures are
 * the opaque `OAuthCallbackFailed` (with a logged reason, OIT-008), or
 * `ProviderUnavailable` when the JWKS endpoint itself is down (EEM-004).
 */
export const verify = (
  input: VerifyInput,
): Effect.Effect<
  Record<string, unknown>,
  OAuthApi.OAuthCallbackFailed | OAuthApi.ProviderUnavailable
> =>
  Effect.gen(function* () {
    const { provider, jwksCaches } = input;
    if (Option.isNone(provider.jwksUri)) {
      return yield* CallbackFailure.callbackFailed("jwks", "provider declares no jwksUri");
    }
    const jwksUri = provider.jwksUri.value;
    // MA-002: one clock reading serves every time claim.
    const nowMs = yield* Clock.currentTimeMillis;

    const decoded = yield* Jwt.decode(input.idToken).pipe(
      Effect.catchTag("JwtVerificationError", (error) =>
        CallbackFailure.callbackFailed("jwt-malformed", error.reason),
      ),
    );
    // AOMS-005: the header `alg` selects within the provider's allowlist; it never widens it.
    const alg = decoded.header.alg;
    if (!Jwt.isSigningAlg(alg) || !provider.idTokenSigningAlgs.includes(alg)) {
      return yield* CallbackFailure.callbackFailed("alg", alg ?? "absent");
    }

    // ESS-001/GC-001/SFS-002/TTE-001: the JWKS document is untrusted,
    // network-fetched input — schema-decoded, never cast. ECF-001/EEM-004/
    // ERS-003: the retrying client, a deadline over request plus decode, and a
    // transport/timeout/5xx failure is `ProviderUnavailable` while a rejected
    // or malformed document is a 400.
    const fetchJwks = input.httpClient.get(jwksUri).pipe(
      Effect.flatMap(ProviderHttp.decodeBody(Jwt.JwksDocumentSchema)),
      Effect.timeout(input.jwksTimeout),
      Effect.catch((error) => CallbackFailure.providerFailure("jwks", error)),
    );

    // JJS-001/KRS-004/OIT-002/ECF-002: a TTL'd-out entry is a cache miss, refetched by exactly one
    // of the callers that noticed (single-flight).
    const cache = yield* jwksCaches.forProvider(provider, jwksUri, fetchJwks);
    const jwks = yield* cache.get;

    const jwk = yield* Jwt.findKey(jwks, decoded.header.kid, alg).pipe(
      // A `kid` cache miss earns a refetch — the provider may have rotated keys since this
      // process last cached them — but at most one per `JWKS_MIN_REFETCH_INTERVAL` (ECF-002),
      // so tokens naming garbage kids cannot turn the callback into a request amplifier.
      Effect.catch(() =>
        cache.refreshOnMiss.pipe(
          Effect.flatMap((fresh) => Jwt.findKey(fresh, decoded.header.kid, alg)),
        ),
      ),
      Effect.catchTag("JwtVerificationError", (error) =>
        CallbackFailure.callbackFailed("kid", error.reason),
      ),
    );
    const verified = yield* Jwt.verifySignature(alg, jwk, decoded.signingInput, decoded.signature).pipe(
      Effect.catchTag("JwtVerificationError", (error) =>
        CallbackFailure.callbackFailed("signature", error.reason),
      ),
    );
    if (!verified) return yield* CallbackFailure.callbackFailed("signature");

    const problem = claimProblem(decoded.payload, {
      clientId: provider.clientId,
      issuer: Option.getOrUndefined(provider.issuer),
      nonce: input.nonce,
      nowMs,
      skewMs: Duration.toMillis(input.clockSkew),
      maxAgeMs: Option.match(input.maxIdTokenAge, {
        onNone: () => undefined,
        onSome: Duration.toMillis,
      }),
    });
    if (problem !== undefined) return yield* CallbackFailure.callbackFailed(problem);
    return decoded.payload;
  });
