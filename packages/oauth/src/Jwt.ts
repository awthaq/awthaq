// @awthaq/oauth — Jwt
//
// spec/behaviors/16-oauth.md, BEH-EA-127 (issuer exact match feeds the same
// claim check here). Not itself a numbered behavior — `research/05-oauth-oidc.md`
// Q54's open question 3 leaves "depend on jose vs. a minimal internal
// verifier" open; this is the minimal-internal-verifier answer, scoped
// deliberately: RS256 only (the OIDC-mandated, near-universal default —
// Google, Okta, Auth0, Entra ID all sign with RS256 by default), signature
// verification via the platform `crypto.subtle` (Node's WebCrypto, no
// dependency), and no JWKS-rotation refresh policy beyond "refetch once on
// a `kid` cache miss." ES256/EdDSA and a real rotation policy are not
// implemented — a real gap, documented here rather than silently assumed
// away, the same way `Verification.layerSql`/`WebAuthn` are documented as
// deferred elsewhere in this codebase rather than pretended not to exist.
//
// OIT-007 — also deliberately not implemented, and compliant as it stands:
//   - `at_hash` is not validated. Only `response_type=code` exists (pinned
//     structurally in `OAuth.ts`'s `buildAuthorizeUrl`), and OIDC Core 3.1.3.7
//     makes `at_hash` optional for the code flow. It becomes REQUIRED the day
//     a hybrid or implicit `response_type` is added — that change must add
//     the check.
//   - `auth_time` / `max_age` (authentication freshness, step-up) are
//     unsupported here; they belong to wayfinder ticket 15 (step-up).

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * ESS-001/GC-001/SFS-002/TTE-001: a JWKS document is untrusted, network-fetched
 * input — decoded via `Schema`, never a cast. Each entry is a bare
 * `Record<string, unknown>` (mirroring `@awthaq/jwt/verify.ts`'s own
 * `JwksDocumentSchema`, this codebase's established idiom for the identical
 * shape) so one entry of an algorithm this verifier doesn't speak (an EC or
 * OKP key beside the RSA one) doesn't invalidate the whole document;
 * `findKey` narrows each entry with `RsaJwkSchema` (ACS-004) before it can
 * become key material.
 */
export const JwksDocumentSchema = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
export type Jwks = typeof JwksDocumentSchema.Type;

/**
 * ACS-004: the structural RSA JWK `findKey` admits. A JWKS entry is only
 * ever a candidate once it decodes as this — a `kty`-less or `n`/`e`-less
 * entry can no longer reach `crypto.subtle.importKey` as key material.
 */
export const RsaJwkSchema = Schema.Struct({
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
  kid: Schema.optional(Schema.String),
  alg: Schema.optional(Schema.String),
  use: Schema.optional(Schema.String),
});
export type Jwk = typeof RsaJwkSchema.Type;

export class JwtVerificationError extends Data.TaggedError("JwtVerificationError")<{
  readonly reason: string;
}> {}

/**
 * `Uint8Array<ArrayBuffer>`, not the bare (`ArrayBufferLike`-defaulted)
 * `Uint8Array` alias: `Uint8Array.from` here always allocates a fresh
 * regular `ArrayBuffer`, never a `SharedArrayBuffer` — the same real
 * distinction `lib.dom.d.ts`'s `BufferSource` (what `crypto.subtle.verify`
 * below actually requires) already draws, surfaced only once this
 * package's shared `tsconfig` gained the `"DOM"` lib for
 * `@awthaq/react`'s sake.
 */
const base64UrlToUint8Array = (segment: string): Uint8Array<ArrayBuffer> => {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Uint8Array.from(atob(withPadding), (char) => char.charCodeAt(0));
};

const decodeJson = (segment: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(segment)));

/**
 * AH-001/ESS-004: a JWT header/payload segment is fully attacker-controlled
 * and decoded before signature verification — `JSON.parse` alone accepts
 * any valid JSON value (`null`, an array, a bare string...), not only an
 * object, so a plain `as` cast previously let a segment encoding the JSON
 * literal `null` reach a caller's ordinary property access
 * (`decoded.header.alg`, `claims["iss"]`) as an unhandled fiber defect
 * instead of this module's own typed `JwtVerificationError`. Schema-decoded
 * here instead, exactly like `JwksDocumentSchema` above.
 */
export const JwtHeaderSchema = Schema.Struct({
  alg: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
});

export const JwtPayloadSchema = Schema.Record(Schema.String, Schema.Unknown);

export interface DecodedJwt {
  readonly header: typeof JwtHeaderSchema.Type;
  readonly payload: typeof JwtPayloadSchema.Type;
  readonly signingInput: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/** Splits and decodes a compact JWS/JWT without verifying its signature. */
export const decode = (token: string): Effect.Effect<DecodedJwt, JwtVerificationError> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => {
        const [headerSegment, payloadSegment, signatureSegment, ...extra] = token.split(".");
        if (
          headerSegment === undefined ||
          payloadSegment === undefined ||
          signatureSegment === undefined ||
          extra.length > 0
        ) {
          throw new Error("not a compact JWS");
        }
        return {
          header: decodeJson(headerSegment),
          payload: decodeJson(payloadSegment),
          signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
          signature: base64UrlToUint8Array(signatureSegment),
        };
      },
      catch: () => new JwtVerificationError({ reason: "malformed JWT" }),
    });
    const header = Schema.decodeUnknownOption(JwtHeaderSchema)(decoded.header);
    const payload = Schema.decodeUnknownOption(JwtPayloadSchema)(decoded.payload);
    if (Option.isNone(header) || Option.isNone(payload)) {
      return yield* Effect.fail(new JwtVerificationError({ reason: "malformed JWT" }));
    }
    return {
      header: header.value,
      payload: payload.value,
      signingInput: decoded.signingInput,
      signature: decoded.signature,
    };
  });

/** Verifies an RS256 signature against one JWKS entry (matched by `kid` beforehand). */
export const verifyRs256 = (
  jwk: Jwk,
  signingInput: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Effect.Effect<boolean, JwtVerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "jwk",
        // Only the public-key members: `kid`/`alg`/`use` were already
        // checked by `findKey` and mean nothing to WebCrypto's import.
        { kty: jwk.kty, n: jwk.n, e: jwk.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return globalThis.crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signingInput);
    },
    catch: () => new JwtVerificationError({ reason: "signature verification failed" }),
  });

/**
 * Picks the JWKS entry matching a decoded JWT's `kid` (or its lone RSA
 * key, absent one).
 *
 * JJS-001/JR-002/KRS-004/OIT-002: a *present* `kid` that matches no
 * candidate now fails — the `candidates[0]` fallback applies only to a
 * `kid`-less token. A silent fallback here was the reason
 * `verifyIdToken`'s documented "refetch once on a `kid` cache miss" was
 * dead code: `Effect.catch` can only fire on a real failure, and a
 * mismatched-but-present `kid` never used to produce one. It also let a
 * mismatched-`kid` token verify against an arbitrary key instead of being
 * rejected, defeating `kid`'s purpose as an explicit key selector —
 * `@awthaq/jwt`'s own `JwtCodec.verify` already enforces this same
 * strictness for the identical class of input.
 */
export const findKey = (
  jwks: Jwks,
  kid: string | undefined,
): Effect.Effect<Jwk, JwtVerificationError> => {
  // ACS-004: only structurally valid RSA signing keys are candidates — a
  // `use` other than `sig`, or an `alg` other than RS256, marks a key this
  // verifier must not select even when its `kid` matches.
  const candidates = jwks.keys.flatMap((entry) => {
    const key = Schema.decodeUnknownOption(RsaJwkSchema)(entry);
    return Option.isSome(key) &&
      (key.value.use === undefined || key.value.use === "sig") &&
      (key.value.alg === undefined || key.value.alg === "RS256")
      ? [key.value]
      : [];
  });
  const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  return matched === undefined
    ? Effect.fail(new JwtVerificationError({ reason: "no matching JWKS key" }))
    : Effect.succeed(matched);
};
