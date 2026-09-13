// @effect-auth/jwt/verify — the standalone lite verifier
//
// .scratch/jwt/issues/13-lite-verifier.md: for a downstream service that
// never installs `effect-auth` at all — verifying a JWT this plugin's
// full package minted, using only its own dependency on this one module.
// Deliberately, checkably free of any import from `@effect-auth/core`,
// `@effect-auth/server`, `./Jwt.ts`, or `./KeyRing.ts`: the only local
// import is `./JwtCodec.ts` (already, independently, free of every one of
// those — see that file's own header comment), plus `effect` itself and
// `effect/unstable/http`'s `HttpClient` for JWKS retrieval. Confirmed by
// hand: `grep -E "@effect-auth/(core|server)|\./Jwt\.ts|\./KeyRing\.ts"
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

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as JwtCodec from "./JwtCodec.ts";

export interface VerifierOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly algorithm: JwtCodec.Algorithm;
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

/** A fetched JWK is only usable for verification once it carries a `kid` and one of this module's two supported algorithms — both narrowed by plain equality checks, never a cast. */
const toVerificationKeys = (
  jwks: typeof JwksDocumentSchema.Type,
): ReadonlyArray<JwtCodec.VerificationKey> =>
  jwks.keys.flatMap((jwk) => {
    const kid = jwk["kid"];
    const alg = jwk["alg"];
    return typeof kid === "string" && (alg === "EdDSA" || alg === "ES256")
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
    const cache = yield* Ref.make<Option.Option<ReadonlyArray<JwtCodec.VerificationKey>>>(
      Option.none(),
    );

    const fetchKeys = httpClient.get(options.jwksUrl).pipe(
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(JwksDocumentSchema)),
      Effect.map(toVerificationKeys),
      Effect.tap((keys) => Ref.set(cache, Option.some(keys))),
      Effect.catch(() =>
        Effect.fail(new JwtCodec.JwtInvalidError({ reason: "jwks fetch failed" })),
      ),
    );

    const currentKeys = Ref.get(cache).pipe(
      Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => fetchKeys })),
    );

    const verifyAgainst = (token: string, keys: ReadonlyArray<JwtCodec.VerificationKey>) =>
      JwtCodec.verify({
        token,
        keys,
        algorithm: options.algorithm,
        issuer: options.issuer,
        audience: options.audience,
      });

    const verify: Verifier["verify"] = (token) =>
      Effect.gen(function* () {
        const keys = yield* currentKeys;
        return yield* verifyAgainst(token, keys).pipe(
          Effect.catchIf(
            (error) => error.reason === "unknown kid",
            () => Effect.flatMap(fetchKeys, (refetched) => verifyAgainst(token, refetched)),
          ),
        );
      });

    return { verify };
  });
