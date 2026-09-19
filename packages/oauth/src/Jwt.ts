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

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * ESS-001/GC-001/SFS-002/TTE-001: a JWKS document is untrusted, network-fetched
 * input — decoded via `Schema`, never a cast. Each entry is a bare
 * `Record<string, unknown>` (mirroring `@awthaq/jwt/verify.ts`'s own
 * `JwksDocumentSchema`, this codebase's established idiom for the identical
 * shape): a JWK's full field set (`kty`/`n`/`e`/`crv`/`x`/`y`/... per RFC
 * 7517) isn't narrowed here since `findKey` only ever reads `kty`/`kid` by
 * plain property access, and `verifyRs256` passes a matched entry to
 * `crypto.subtle.importKey` wholesale, needing no narrower type either.
 */
export const JwksDocumentSchema = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
export type Jwks = typeof JwksDocumentSchema.Type;
export type Jwk = Jwks["keys"][number];

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
        const parts = token.split(".");
        if (parts.length !== 3) throw new Error("not a compact JWS");
        const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
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
        jwk,
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
  const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
  const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  return matched === undefined
    ? Effect.fail(new JwtVerificationError({ reason: "no matching JWKS key" }))
    : Effect.succeed(matched);
};
