// @awthaq/jwt — JwtCodec
//
// .scratch/jwt/issues/08-sign-and-verify.md: the shared claims-assembly and
// JWS encode/verify logic — deliberately free of any import from `Jwt.ts`,
// `KeyRing.ts`'s `Context`-tagged services, `JwtConfig`, or anything
// `AuthPlugin`-shaped. Operates on plain data only (a `kid`/`alg`/JWK, a
// token string, expected `iss`/`aud`/`alg`) so ticket 13's standalone lite
// verifier can depend on this module alone, with zero footprint from the
// rest of this plugin or `@awthaq/core`.
//
// GC-002: the registered claims are one `RegisteredClaims` Schema used on
// both sides — `sign` encodes through it, `parse` decodes through it — so
// the contract exists once and a token this module would refuse to accept
// is a token it refuses to mint. `aud` is a string or a non-empty array
// (RFC 7519 §4.1.3); `exp` is required.
//
// Verification rules (segments, `crit`, algorithm allowlist, key selection, signature, time) are
// `Jws` (ADR-EA-057); this module keeps signing and the jwt claim policy (`iss`/`aud`/`typ`/`sub`).
// The only workspace import is `@awthaq/ports`; nothing from `Jwt.ts`, `KeyRing.ts` or `@awthaq/core`.
//
// RFC 8725: `verify` never trusts the token's own `alg`: it must be in the caller's allowlist and
// fit the key matched by `kid`; the `typ` header must equal the caller's expected token class
// (JJS-008/VB-005; case-insensitive per RFC 7515 §4.1.9).
//
// Every distinct verification failure collapses to this module's own single
// `JwtInvalidError` tag (an internal `reason` field is retained for
// diagnostics/logging — not exposed to a caller as a distinguishable typed
// error) — the spec's own "don't leak which check failed" posture, mirrored
// from `better-auth/07-session-extensions/03-bearer-and-jwt.md` §B.2.

import { Jws } from "@awthaq/ports";
import type { webcrypto } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Algorithm = Jws.Algorithm;

/** Narrows an arbitrary string (a JWKS entry's `alg`, say) to a supported algorithm, no cast. */
export const isAlgorithm = Jws.isAlgorithm;

/** The schema for a stored/served algorithm name, for persistence layers that need to decode one. */
export const AlgorithmLiterals = Jws.Algorithm;

export class JwtInvalidError extends Data.TaggedError("JwtInvalidError")<{
  readonly reason: string;
}> {}

export interface VerificationKey {
  readonly kid: string;
  readonly alg?: Algorithm;
  readonly publicKeyJwk: Record<string, unknown>;
}

/** Registered claims plus any extras (`sid`, `act`, application payload...), one schema for encode and decode. */
export const RegisteredClaims = Schema.StructWithRest(
  Schema.Struct({
    iss: Schema.String,
    aud: Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)]),
    exp: Schema.Int,
    iat: Schema.optional(Schema.Int),
    nbf: Schema.optional(Schema.Int),
    jti: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.NonEmptyString),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type Claims = typeof RegisteredClaims.Type;

const HeaderSchema = Schema.Struct({
  alg: Schema.optional(Schema.String),
  kid: Schema.optional(Schema.String),
  typ: Schema.optional(Schema.String),
});

/**
 * MAPS-001/MAPS-004: the JOSE header `typ` of a compact JWT, read without
 * verifying anything, or `None` for a credential that is not three
 * dot-separated segments with a JSON header. Only public structure is looked
 * at, so a bearer-credential contribution can claim "a principal token"
 * (`at+jwt`) versus "a service token" before any signature check runs and
 * without an opaque session token ever being mistaken for either.
 */
export const peekTyp = (token: string): Option.Option<string> => {
  const [header, payload, signature, ...rest] = token.split(".");
  if (
    header === undefined ||
    header === "" ||
    payload === undefined ||
    signature === undefined ||
    rest.length > 0
  ) {
    return Option.none();
  }
  return Base64Url.decodeString(header).pipe(
    Option.getSuccess,
    Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(HeaderSchema))),
    Option.flatMapNullishOr((decoded) => decoded.typ),
  );
};

const rsaGenerate = (name: string, rsaModulusLength: number): webcrypto.RsaHashedKeyGenParams => ({
  name,
  modulusLength: rsaModulusLength,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
});

const generateParams: Record<
  Algorithm,
  (
    rsaModulusLength: number,
  ) => webcrypto.AlgorithmIdentifier | webcrypto.RsaHashedKeyGenParams | webcrypto.EcKeyGenParams
> = {
  EdDSA: () => ({ name: "Ed25519" }),
  ES256: () => ({ name: "ECDSA", namedCurve: "P-256" }),
  ES384: () => ({ name: "ECDSA", namedCurve: "P-384" }),
  RS256: (length) => rsaGenerate("RSASSA-PKCS1-v1_5", length),
  PS256: (length) => rsaGenerate("RSA-PSS", length),
};

/** The `kty` a JWK for `algorithm` must carry, lets a key importer reject a JWK of the wrong family. */
export const keyTypeFor = Jws.keyType;

const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encodeJson = (value: unknown): string =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Generates a fresh key pair for `algorithm` and exports both halves as JWKs
 * (`kid`/`alg` are the caller's to add). RSA modulus length defaults to 2048.
 */
export const generateKeyJwks = (
  algorithm: Algorithm,
  options?: { readonly rsaModulusLength?: number },
) =>
  Effect.tryPromise({
    try: async () => {
      const pair = await globalThis.crypto.subtle.generateKey(
        generateParams[algorithm](options?.rsaModulusLength ?? 2048),
        true,
        ["sign", "verify"],
      );
      // Every asymmetric algorithm generates a pair; the union return type of
      // `generateKey` just cannot say so.
      if (!("publicKey" in pair)) throw new Error(`${algorithm} did not generate a key pair`);
      const publicKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
      const privateKeyJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
      return { publicKeyJwk: { ...publicKeyJwk }, privateKeyJwk: { ...privateKeyJwk } };
    },
    catch: (cause) => new JwtInvalidError({ reason: `key generation failed: ${cause}` }),
  }).pipe(Effect.orDie);

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
        const { importParams, signParams } = Jws.webCryptoParams(alg);
        const key = await globalThis.crypto.subtle.importKey(
          "jwk",
          privateKeyJwk,
          importParams,
          false,
          ["sign"],
        );
        const signature = await globalThis.crypto.subtle.sign(signParams, key, signingInput);
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
  "awthaq/jwt/RemoteSigner",
  { defaultValue: () => Option.none() },
);

const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(RegisteredClaims));

/**
 * Signs `claims` (registered + extra, already merged) into a compact JWS
 * string via `signer`. `typ` is the header token class (`"at+jwt"` for
 * principal tokens, `"JWT"` for general-purpose ones — VB-005).
 */
export const sign = (params: {
  readonly kid: string;
  readonly alg: Algorithm;
  readonly typ: string;
  readonly signer: Signer;
  readonly claims: Claims;
}) =>
  Effect.gen(function* () {
    const header = { alg: params.alg, kid: params.kid, typ: params.typ };
    const headerSegment = encodeJson(header);
    const payloadJson = yield* encodeClaims(params.claims).pipe(
      Effect.mapError(() => new JwtInvalidError({ reason: "claims do not satisfy the schema" })),
    );
    const payloadSegment = base64UrlEncode(new TextEncoder().encode(payloadJson));
    const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
    const signature = yield* params.signer.sign({
      kid: params.kid,
      alg: params.alg,
      signingInput,
    });
    const signatureSegment = base64UrlEncode(signature);
    return `${headerSegment}.${payloadSegment}.${signatureSegment}`;
  });

const decodeClaims = Schema.decodeUnknownEffect(RegisteredClaims);

const REASONS: Record<Jws.Reason, string> = {
  malformed: "malformed token",
  crit: "critical header not understood",
  alg: "algorithm not allowed",
  "key-mismatch": "algorithm not allowed",
  "missing-kid": "missing kid",
  "unknown-kid": "unknown kid",
  signature: "bad signature",
};

/**
 * Verifies `token` against `keys` (matched by `kid`) through `Jws`, then `issuer`/`audience`,
 * `expectedTyp` and the current time; returns the payload claims, or one undifferentiated
 * `JwtInvalidError`. `algorithms` is the allowlist, never the token's say-so. `refetch`, when given,
 * is read once if no key carries the token's `kid`; its own failure type `E` passes through.
 * `requireSubject` (default true) is for principal tokens (JJS-007).
 */
export const verify = <E = never>(params: {
  readonly token: string;
  readonly keys: ReadonlyArray<VerificationKey>;
  readonly refetch?: Effect.Effect<ReadonlyArray<VerificationKey>, E>;
  readonly algorithms: ReadonlyArray<Algorithm>;
  readonly issuer: string;
  readonly audience: string;
  /** The accepted header `typ` value(s), compared case-insensitively. */
  readonly expectedTyp: string | ReadonlyArray<string>;
  readonly requireSubject?: boolean;
  readonly clockSkew?: Duration.Input;
}) =>
  Effect.gen(function* () {
    const typ = Option.getOrUndefined(peekTyp(params.token));
    const acceptedTyps = (
      typeof params.expectedTyp === "string" ? [params.expectedTyp] : params.expectedTyp
    ).map((accepted) => accepted.toLowerCase());
    if (typ === undefined || !acceptedTyps.includes(typ.toLowerCase())) {
      return yield* new JwtInvalidError({ reason: "typ mismatch" });
    }
    const toSet = (keys: ReadonlyArray<VerificationKey>): Jws.JwkSet => ({
      keys: keys.map((key) => ({
        ...key.publicKeyJwk,
        kid: key.kid,
        ...(key.alg === undefined ? {} : { alg: key.alg }),
      })),
    });
    const verified = yield* Jws.verify({
      token: params.token,
      keys: {
        get: Effect.succeed(toSet(params.keys)),
        refreshOnMiss:
          params.refetch === undefined
            ? Effect.succeed(toSet(params.keys))
            : Effect.map(params.refetch, toSet),
      },
      algorithms: params.algorithms,
      requireKid: true,
    }).pipe(
      Effect.catchIf(
        (error): error is Jws.JwsRejected => error instanceof Jws.JwsRejected,
        (rejected) => Effect.fail(new JwtInvalidError({ reason: REASONS[rejected.reason] })),
      ),
    );
    const payload = yield* decodeClaims(verified.payload).pipe(
      Effect.mapError(() => new JwtInvalidError({ reason: "malformed token" })),
    );
    const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    if (payload.iss !== params.issuer || !audiences.includes(params.audience)) {
      return yield* new JwtInvalidError({ reason: "iss/aud mismatch" });
    }
    const timeProblem = Jws.timeProblem(payload, {
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      skewMs: Duration.toMillis(params.clockSkew ?? Duration.zero),
    });
    if (timeProblem !== undefined) {
      return yield* new JwtInvalidError({
        reason: timeProblem === "exp" ? "expired" : "not yet valid",
      });
    }
    if ((params.requireSubject ?? true) && payload.sub === undefined) {
      return yield* new JwtInvalidError({ reason: "missing sub" });
    }
    return payload;
  });
