// @awthaq/jwt/verify — the standalone lite verifier
//
// .scratch/jwt/issues/13-lite-verifier.md: for a downstream service that
// never installs `awthaq` at all — verifying a JWT this plugin's
// full package minted, using only its own dependency on this one module.
// Deliberately, checkably free of any import from `@awthaq/core`,
// `@awthaq/server`, `./Jwt.ts`, or `./KeyRing.ts`: the only local
// import is `./JwtCodec.ts` (already, independently, free of every one of
// those — see that file's own header comment), plus `effect` itself,
// `effect/unstable/http`'s `HttpClient` for JWKS retrieval, and
// `@awthaq/ports`' `RefreshingCache` (ECF-002; that package is
// `sideEffects: false`, so a bundler drops everything but the cache). Confirmed by
// hand: `grep -E "@awthaq/(core|server)|\./Jwt\.ts|\./KeyRing\.ts"
// packages/jwt/src/verify.ts` prints nothing.
//
// JWKS documents are decoded via `Schema.decodeUnknownEffect`
// (`HttpIncomingMessage.schemaBodyJson`), never a raw `JSON.parse` + type
// assertion — this codebase's own established idiom for untrusted wire
// data (see `JwtCodec.ts`'s own header comment, and
// `packages/oauth/src/OAuth.ts`'s older `response.json() as {...}` — that
// file predates this convention and isn't the pattern to copy). Each
// fetched JWK's `kid`/`alg` are read off the decoded `Record<string,
// unknown>` via a plain `typeof`/equality narrow, never a cast.
//
// No `verifyLive`-equivalent exists here, and none should be added — a
// live revocation check needs `Sessions`, which this module cannot depend
// on by design (ticket 03/05 of this effort's own wayfinder tracker
// already settled this as a documented limitation of the lite path, not a
// gap to fill).
//
// Caching (ECF-002/JJS-002/KRS-010): the fetched key set is served for
// `cacheTtl` (default 10 minutes, so a key the issuer removes stops
// verifying without a restart), concurrent cold reads share one fetch, and a
// token naming an unknown `kid` triggers at most one forced refetch per
// `minRefetchInterval` (default 30 seconds) however many such tokens arrive.
// Size `cacheTtl` against the issuer's `keyGracePeriod`: a retired key stays
// in the issuer's JWKS for the grace period, so a removed key is honoured for
// at most `cacheTtl` past its removal.

import { RefreshingCache } from "@awthaq/ports";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as JwtCodec from "./JwtCodec.ts";

export interface VerifierOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  /**
   * Signature algorithms the issuer's tokens may use (JJS-003/BAM-010) — an
   * allowlist, never the token's own say-so. Several entries let a verifier
   * span an algorithm switch or a dual-run (e.g. `["EdDSA", "RS256"]`).
   */
  readonly algorithms: ReadonlyArray<JwtCodec.Algorithm>;
  /**
   * The header `typ` the tokens must carry (JJS-008/VB-005): `"at+jwt"` for the
   * principal tokens `Jwt.sign`/`GET /jwt/token` mint (the default), `"JWT"` for
   * general-purpose `signJWT` tokens. Compared case-insensitively.
   */
  readonly expectedTyp?: string | ReadonlyArray<string>;
  /** Require a non-empty `sub` (default true; a general-purpose token may have none — JJS-007). */
  readonly requireSubject?: boolean;
  /** Tolerated clock difference for `exp`/`nbf`/`iat` checks. Default none. */
  readonly clockSkew?: Duration.Input;
  /** How long a fetched JWKS is served before the next verification refetches it. Default 10 minutes. */
  readonly cacheTtl?: Duration.Input;
  /** Minimum gap between forced refetches triggered by an unknown `kid` (also how long a failed fetch is replayed). Default 30 seconds. */
  readonly minRefetchInterval?: Duration.Input;
}

export interface Verifier {
  /** Verifies `token` against the current (cached, refetched on an unknown `kid`) JWKS document. */
  readonly verify: (
    token: string,
  ) => Effect.Effect<Record<string, unknown>, JwtCodec.JwtInvalidError>;
}

const JwksDocumentSchema = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});

/** A fetched JWK is only usable for verification once it carries a `kid` and one of this module's supported algorithms — narrowed by a type guard, never a cast. */
const toVerificationKeys = (
  jwks: typeof JwksDocumentSchema.Type,
): ReadonlyArray<JwtCodec.VerificationKey> =>
  jwks.keys.flatMap((jwk) => {
    const kid = jwk["kid"];
    const alg = jwk["alg"];
    return typeof kid === "string" && JwtCodec.isAlgorithm(alg)
      ? [{ kid, alg, publicKeyJwk: jwk }]
      : [];
  });

/**
 * Creates a verifier bound to one JWKS endpoint/issuer/audience/algorithm,
 * with its own long-lived key cache — build this once (e.g. at the
 * consuming service's own startup), then call `.verify(token)` per
 * request. Fetches JWKS lazily on first use, and again, once, whenever a
 * token names a `kid` the current cache doesn't recognize (the standard
 * "unknown kid → refetch" pattern) — never repeatedly for the same
 * genuinely-unknown `kid`.
 */
export const makeVerifier = (options: VerifierOptions) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const fetchKeys = httpClient.get(options.jwksUrl).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(JwksDocumentSchema)),
      Effect.map(toVerificationKeys),
      Effect.catch(() =>
        Effect.fail(new JwtCodec.JwtInvalidError({ reason: "jwks fetch failed" })),
      ),
    );

    const keys = yield* RefreshingCache.make(fetchKeys, {
      ttl: options.cacheTtl ?? "10 minutes",
      minRefetchInterval: options.minRefetchInterval ?? "30 seconds",
    });

    const verifyAgainst = (token: string, keys: ReadonlyArray<JwtCodec.VerificationKey>) =>
      JwtCodec.verify({
        token,
        keys,
        algorithms: options.algorithms,
        issuer: options.issuer,
        audience: options.audience,
        expectedTyp: options.expectedTyp ?? "at+jwt",
        ...(options.requireSubject === undefined ? {} : { requireSubject: options.requireSubject }),
        ...(options.clockSkew === undefined ? {} : { clockSkew: options.clockSkew }),
      });

    const verify: Verifier["verify"] = (token) =>
      Effect.gen(function* () {
        const current = yield* keys.get;
        return yield* verifyAgainst(token, current).pipe(
          Effect.catchIf(
            (error) => error.reason === "unknown kid",
            () =>
              Effect.flatMap(keys.refreshOnMiss, (refetched) => verifyAgainst(token, refetched)),
          ),
        );
      });

    return { verify };
  });
