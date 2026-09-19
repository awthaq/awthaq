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

export interface DecodedJwt {
  readonly header: { readonly alg?: string; readonly kid?: string };
  readonly payload: Record<string, unknown>;
  readonly signingInput: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/** Splits and decodes a compact JWS/JWT without verifying its signature. */
export const decode = (token: string): Effect.Effect<DecodedJwt, JwtVerificationError> =>
  Effect.try({
    try: () => {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("not a compact JWS");
      const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
      return {
        header: decodeJson(headerSegment) as DecodedJwt["header"],
        payload: decodeJson(payloadSegment) as Record<string, unknown>,
        signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
        signature: base64UrlToUint8Array(signatureSegment),
      };
    },
    catch: () => new JwtVerificationError({ reason: "malformed JWT" }),
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

/** Picks the JWKS entry matching a decoded JWT's `kid` (or its lone RSA key, absent one). */
export const findKey = (
  jwks: Jwks,
  kid: string | undefined,
): Effect.Effect<Jwk, JwtVerificationError> => {
  const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
  const matched =
    kid === undefined
      ? candidates[0]
      : (candidates.find((key) => key.kid === kid) ?? candidates[0]);
  return matched === undefined
    ? Effect.fail(new JwtVerificationError({ reason: "no matching JWKS key" }))
    : Effect.succeed(matched);
};
