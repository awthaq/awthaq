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

import type { webcrypto } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type Jwk = webcrypto.JsonWebKey & { readonly kid?: string; readonly alg?: string };

export interface Jwks {
  readonly keys: ReadonlyArray<Jwk>;
}

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
