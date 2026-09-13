// @effect-auth/jwt — JwtCodec
//
// .scratch/jwt/issues/08-sign-and-verify.md: the shared claims-assembly and
// JWS encode/verify logic — deliberately free of any import from `Jwt.ts`,
// `KeyRing.ts`'s `Context`-tagged services, `JwtConfig`, or anything
// `AuthPlugin`-shaped. Operates on plain data only (a `kid`/`alg`/JWK, a
// token string, expected `iss`/`aud`/`alg`) so ticket 13's standalone lite
// verifier can depend on this module alone, with zero footprint from the
// rest of this plugin or `@effect-auth/core`.
//
// Compact-JWS *segment splitting* mirrors `@effect-auth/oauth`'s own
// `Jwt.ts` (base64url decode) — not imported from there, since that module
// solves a narrower, different problem (RS256-only third-party `id_token`
// verification) and this codebase's own `.scratch/jwt/spec.md` decided to
// keep the two independent. Unlike that module, header/payload JSON is
// decoded via `Schema.fromJsonString` (this codebase's own established
// "arbitrary/dynamic JSON" idiom — see `packages/sql/src/Models.ts`'s
// `Model.Field({ select: Schema.fromJsonString(Schema.Unknown), ... })`)
// rather than a raw `JSON.parse` + type assertion — this repo's standing
// rule against type assertions in library source applies to untrusted
// wire data even more than anywhere else.
//
// Every distinct verification failure collapses to this module's own single
// `JwtInvalidError` tag (an internal `reason` field is retained for
// diagnostics/logging — not exposed to a caller as a distinguishable typed
// error) — the spec's own "don't leak which check failed" posture, mirrored
// from `better-auth/07-session-extensions/03-bearer-and-jwt.md` §B.2.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Algorithm = "EdDSA" | "ES256";

export class JwtInvalidError extends Data.TaggedError("JwtInvalidError")<{
  readonly reason: string;
}> {}

export interface VerificationKey {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly publicKeyJwk: Record<string, unknown>;
}

const HeaderSchema = Schema.Struct({
  alg: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
});

const PayloadSchema = Schema.Record(Schema.String, Schema.Unknown);

const importParams = (algorithm: Algorithm) =>
  algorithm === "EdDSA"
    ? ({ name: "Ed25519" } as const)
    : ({ name: "ECDSA", namedCurve: "P-256" } as const);

const signParams = (algorithm: Algorithm) =>
  algorithm === "EdDSA"
    ? ({ name: "Ed25519" } as const)
    : ({ name: "ECDSA", hash: "SHA-256" } as const);

const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const base64UrlDecode = (segment: string): Uint8Array<ArrayBuffer> => {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Uint8Array.from(atob(withPadding), (char) => char.charCodeAt(0));
};

const encodeJson = (value: unknown): string =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/**
 * .scratch/jwt/issues/15-remote-signing-swap.md: the pluggable boundary a
 * KMS/HSM-backed deployment swaps in — given bytes to sign, a `kid`, and an
 * algorithm, returns a signature. `sign` below still owns compact-JWS
 * envelope assembly (header/payload encoding, joining the segments) either
 * way; a `Signer` only ever produces the raw signature bytes.
 */
export interface Signer {
  readonly sign: (input: {
    readonly kid: string;
    readonly alg: Algorithm;
    readonly signingInput: Uint8Array<ArrayBuffer>;
  }) => Effect.Effect<Uint8Array<ArrayBuffer>, JwtInvalidError>;
}

/** The default `Signer`: a local, already-in-hand `privateKeyJwk` via platform WebCrypto — what every key ticket 07 mints uses. */
export const localSigner = (privateKeyJwk: Record<string, unknown>): Signer => ({
  sign: ({ alg, signingInput }) =>
    Effect.tryPromise({
      try: async () => {
        const key = await globalThis.crypto.subtle.importKey(
          "jwk",
          privateKeyJwk,
          importParams(alg),
          false,
          ["sign"],
        );
        const signature = await globalThis.crypto.subtle.sign(signParams(alg), key, signingInput);
        return new Uint8Array(signature);
      },
      catch: (cause) => new JwtInvalidError({ reason: `signing failed: ${cause}` }),
    }),
});

/**
 * .scratch/jwt/issues/15-remote-signing-swap.md: an application-supplied
 * `Signer` for keys with no local private material (`SigningKeyRecords`'
 * `privateKeyJwk` is `None` for such a key — see `KeyRing.ts`'s
 * `registerRemoteKey`). Defaults to `Option.none()`; a key with no local
 * material and no `RemoteSigner` configured dies with a clear message
 * (a configuration error, not a recoverable one) rather than silently
 * failing to sign.
 */
export const RemoteSigner: Context.Reference<Option.Option<Signer>> = Context.Reference(
  "effect-auth/jwt/RemoteSigner",
  { defaultValue: () => Option.none() },
);

/** Signs `claims` (registered + extra, already merged) into a compact JWS string via `signer`. */
export const sign = (params: {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly signer: Signer;
  readonly claims: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const header = { alg: params.alg, kid: params.kid, typ: "JWT" };
    const headerSegment = encodeJson(header);
    const payloadSegment = encodeJson(params.claims);
    const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
    const signature = yield* params.signer.sign({
      kid: params.kid,
      alg: params.alg,
      signingInput,
    });
    const signatureSegment = base64UrlEncode(signature);
    return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
  });

const decodeHeader = (segment: string) =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(base64UrlDecode(segment));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HeaderSchema))(json);
  }).pipe(Effect.mapError(() => new JwtInvalidError({ reason: "malformed token" })));

const decodePayload = (segment: string) =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(base64UrlDecode(segment));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PayloadSchema))(json);
  }).pipe(Effect.mapError(() => new JwtInvalidError({ reason: "malformed token" })));

/** Splits and decodes a compact JWS/JWT without verifying its signature. */
const parse = (token: string) =>
  Effect.gen(function* () {
    const parts = token.split(".");
    const headerSegment = parts[0];
    const payloadSegment = parts[1];
    const signatureSegment = parts[2];
    if (
      parts.length !== 3 ||
      headerSegment === undefined ||
      payloadSegment === undefined ||
      signatureSegment === undefined
    ) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "not a compact JWS" }));
    }
    const header = yield* decodeHeader(headerSegment);
    const payload = yield* decodePayload(payloadSegment);
    return {
      header,
      payload,
      signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      signature: base64UrlDecode(signatureSegment),
    };
  });

const verifySignature = (
  alg: Algorithm,
  publicKeyJwk: Record<string, unknown>,
  signingInput: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
) =>
  Effect.tryPromise({
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "jwk",
        publicKeyJwk,
        importParams(alg),
        false,
        ["verify"],
      );
      return globalThis.crypto.subtle.verify(signParams(alg), key, signature, signingInput);
    },
    catch: () => new JwtInvalidError({ reason: "signature verification threw" }),
  });

/**
 * Verifies `token` against `keys` (matched by `kid`, cross-checked against
 * `algorithm` — the token's own declared `alg` is never trusted alone),
 * `issuer`/`audience`, and the current time — returns the payload claims on
 * success, one undifferentiated `JwtInvalidError` on any failure.
 */
export const verify = (params: {
  readonly token: string;
  readonly keys: ReadonlyArray<VerificationKey>;
  readonly algorithm: Algorithm;
  readonly issuer: string;
  readonly audience: string;
}) =>
  Effect.gen(function* () {
    const parsed = yield* parse(params.token);
    const kid = parsed.header.kid;
    if (kid === undefined || kid.length === 0) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing kid" }));
    }
    if (parsed.header.alg !== params.algorithm) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "algorithm not allowed" }));
    }
    const key = params.keys.find((candidate) => candidate.kid === kid);
    if (key === undefined) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "unknown kid" }));
    }
    const signatureValid = yield* verifySignature(
      params.algorithm,
      key.publicKeyJwk,
      parsed.signingInput,
      parsed.signature,
    );
    if (!signatureValid) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "bad signature" }));
    }
    const { payload } = parsed;
    if (payload["iss"] !== params.issuer || payload["aud"] !== params.audience) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "iss/aud mismatch" }));
    }
    const exp = payload["exp"];
    if (typeof exp !== "number") {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing exp" }));
    }
    const now = yield* DateTime.now;
    if (exp * 1000 <= DateTime.toEpochMillis(now)) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "expired" }));
    }
    if (typeof payload["sub"] !== "string" || payload["sub"].length === 0) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing sub" }));
    }
    return payload;
  });
