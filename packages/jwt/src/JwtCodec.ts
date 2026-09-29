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
// Compact-JWS *segment splitting* mirrors `@awthaq/oauth`'s own
// `Jwt.ts` (base64url decode) — not imported from there, since that module
// solves a narrower, different problem (third-party `id_token`
// verification) and this codebase's own `.scratch/jwt/spec.md` decided to
// keep the two independent. Unlike that module, header/payload JSON is
// decoded via `Schema.fromJsonString` (this codebase's own established
// "arbitrary/dynamic JSON" idiom — see `packages/sql/src/Models.ts`'s
// `Model.Field({ select: Schema.fromJsonString(Schema.Unknown), ... })`)
// rather than a raw `JSON.parse` + type assertion — this repo's standing
// rule against type assertions in library source applies to untrusted
// wire data even more than anywhere else.
//
// GC-002: the registered claims are one `RegisteredClaims` Schema used on
// both sides — `sign` encodes through it, `parse` decodes through it — so
// the contract exists once and a token this module would refuse to accept
// is a token it refuses to mint. `aud` is a string or a non-empty array
// (RFC 7519 §4.1.3); `exp` is required.
//
// BAM-010: the supported algorithm set is one table (`specs`) over the
// asymmetric JOSE algorithms WebCrypto implements — EdDSA, ES256, ES384,
// RS256, PS256. HS* is deliberately unrepresentable: a verifier that holds
// only public keys can never be tricked into an HMAC check.
//
// RFC 8725: `verify` never trusts the token's own `alg`. The header `alg`
// must be in the caller's allowlist *and* equal the `alg` of the key matched
// by `kid` (JJS-003), the `typ` header must equal the caller's expected token
// class (JJS-008/VB-005; case-insensitive per RFC 7515 §4.1.9), and
// `nbf`/`iat` are honoured within an optional `clockSkew`.
//
// Every distinct verification failure collapses to this module's own single
// `JwtInvalidError` tag (an internal `reason` field is retained for
// diagnostics/logging — not exposed to a caller as a distinguishable typed
// error) — the spec's own "don't leak which check failed" posture, mirrored
// from `better-auth/07-session-extensions/03-bearer-and-jwt.md` §B.2.

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AlgorithmSchema = Schema.Literals(["EdDSA", "ES256", "ES384", "RS256", "PS256"]);

export type Algorithm = typeof AlgorithmSchema.Type;

/** Narrows an arbitrary string (a JWKS entry's `alg`, say) to a supported algorithm — no cast. */
export const isAlgorithm: (value: unknown) => value is Algorithm = Schema.is(AlgorithmSchema);

/** The schema for a stored/served algorithm name, for persistence layers that need to decode one. */
export const AlgorithmLiterals = AlgorithmSchema;

export class JwtInvalidError extends Data.TaggedError("JwtInvalidError")<{
  readonly reason: string;
}> {}

export interface VerificationKey {
  readonly kid: string;
  readonly alg: Algorithm;
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
  return Encoding.decodeBase64UrlString(header).pipe(
    Option.getSuccess,
    Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(HeaderSchema))),
    Option.flatMapNullishOr((decoded) => decoded.typ),
  );
};

interface AlgorithmSpec {
  /** `kty` a JWK for this algorithm must carry. */
  readonly kty: "OKP" | "EC" | "RSA";
  readonly importParams: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams;
  readonly signParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  readonly generateParams: (
    rsaModulusLength: number,
  ) => AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams;
}

const rsaGenerate = (name: string, rsaModulusLength: number): RsaHashedKeyGenParams => ({
  name,
  modulusLength: rsaModulusLength,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
});

const specs: Record<Algorithm, AlgorithmSpec> = {
  EdDSA: {
    kty: "OKP",
    importParams: { name: "Ed25519" },
    signParams: { name: "Ed25519" },
    generateParams: () => ({ name: "Ed25519" }),
  },
  ES256: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    signParams: { name: "ECDSA", hash: "SHA-256" },
    generateParams: () => ({ name: "ECDSA", namedCurve: "P-256" }),
  },
  ES384: {
    kty: "EC",
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    signParams: { name: "ECDSA", hash: "SHA-384" },
    generateParams: () => ({ name: "ECDSA", namedCurve: "P-384" }),
  },
  RS256: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    signParams: { name: "RSASSA-PKCS1-v1_5" },
    generateParams: (length) => rsaGenerate("RSASSA-PKCS1-v1_5", length),
  },
  PS256: {
    kty: "RSA",
    importParams: { name: "RSA-PSS", hash: "SHA-256" },
    signParams: { name: "RSA-PSS", saltLength: 32 },
    generateParams: (length) => rsaGenerate("RSA-PSS", length),
  },
};

/** The `kty` a JWK for `algorithm` must carry — lets a key importer reject a JWK of the wrong family. */
export const keyTypeFor = (algorithm: Algorithm): "OKP" | "EC" | "RSA" => specs[algorithm].kty;

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
 * Generates a fresh key pair for `algorithm` and exports both halves as JWKs
 * (`kid`/`alg` are the caller's to add). RSA modulus length defaults to 2048.
 */
export const generateKeyJwks = (
  algorithm: Algorithm,
  options?: { readonly rsaModulusLength?: number },
) =>
  Effect.tryPromise({
    try: async () => {
      const spec = specs[algorithm];
      const pair = await globalThis.crypto.subtle.generateKey(
        spec.generateParams(options?.rsaModulusLength ?? 2048),
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
        const spec = specs[alg];
        const key = await globalThis.crypto.subtle.importKey(
          "jwk",
          privateKeyJwk,
          spec.importParams,
          false,
          ["sign"],
        );
        const signature = await globalThis.crypto.subtle.sign(spec.signParams, key, signingInput);
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

const decodeHeader = (segment: string) =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(base64UrlDecode(segment));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HeaderSchema))(json);
  }).pipe(Effect.mapError(() => new JwtInvalidError({ reason: "malformed token" })));

const decodePayload = (segment: string) =>
  Effect.gen(function* () {
    const json = new TextDecoder().decode(base64UrlDecode(segment));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RegisteredClaims))(json);
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
      const spec = specs[alg];
      const key = await globalThis.crypto.subtle.importKey(
        "jwk",
        publicKeyJwk,
        spec.importParams,
        false,
        ["verify"],
      );
      return globalThis.crypto.subtle.verify(spec.signParams, key, signature, signingInput);
    },
    catch: () => new JwtInvalidError({ reason: "signature verification threw" }),
  });

/**
 * Verifies `token` against `keys` (matched by `kid`), then `issuer`/
 * `audience`, `expectedTyp`, and the current time — returns the payload
 * claims on success, one undifferentiated `JwtInvalidError` on any failure.
 *
 * The token's own declared `alg` is never trusted alone: it must be in
 * `algorithms` and equal the matched key's own `alg`, and the signature is
 * checked under that key's algorithm (JJS-003), so keys of an old algorithm
 * keep verifying through their grace period after `JwtConfig.algorithm`
 * changes. `requireSubject` (default true) is for principal tokens;
 * general-purpose tokens may legitimately have no `sub` (JJS-007).
 */
export const verify = (params: {
  readonly token: string;
  readonly keys: ReadonlyArray<VerificationKey>;
  readonly algorithms: ReadonlyArray<Algorithm>;
  readonly issuer: string;
  readonly audience: string;
  /** The accepted header `typ` value(s), compared case-insensitively. */
  readonly expectedTyp: string | ReadonlyArray<string>;
  readonly requireSubject?: boolean;
  readonly clockSkew?: Duration.Input;
}) =>
  Effect.gen(function* () {
    const parsed = yield* parse(params.token);
    const kid = parsed.header.kid;
    if (kid === undefined || kid.length === 0) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing kid" }));
    }
    const headerAlg = parsed.header.alg;
    if (
      headerAlg === undefined ||
      !isAlgorithm(headerAlg) ||
      !params.algorithms.includes(headerAlg)
    ) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "algorithm not allowed" }));
    }
    const typ = parsed.header.typ;
    const acceptedTyps = (
      typeof params.expectedTyp === "string" ? [params.expectedTyp] : params.expectedTyp
    ).map((accepted) => accepted.toLowerCase());
    if (typ === undefined || !acceptedTyps.includes(typ.toLowerCase())) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "typ mismatch" }));
    }
    const key = params.keys.find((candidate) => candidate.kid === kid);
    if (key === undefined) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "unknown kid" }));
    }
    if (key.alg !== headerAlg || !params.algorithms.includes(key.alg)) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "algorithm not allowed" }));
    }
    const signatureValid = yield* verifySignature(
      key.alg,
      key.publicKeyJwk,
      parsed.signingInput,
      parsed.signature,
    );
    if (!signatureValid) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "bad signature" }));
    }
    const { payload } = parsed;
    const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    if (payload.iss !== params.issuer || !audiences.includes(params.audience)) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "iss/aud mismatch" }));
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const skewMs = Duration.toMillis(params.clockSkew ?? Duration.zero);
    if (payload.exp * 1000 + skewMs <= nowMs) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "expired" }));
    }
    // RFC 7519 §4.1.5 (`nbf`) and RFC 8725's guidance against future-dated
    // tokens (`iat`): both are refused until the clock (plus skew) catches up.
    const notBefore = payload.nbf;
    const issuedAt = payload.iat;
    if (
      (notBefore !== undefined && notBefore * 1000 - skewMs > nowMs) ||
      (issuedAt !== undefined && issuedAt * 1000 - skewMs > nowMs)
    ) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "not yet valid" }));
    }
    if ((params.requireSubject ?? true) && payload.sub === undefined) {
      return yield* Effect.fail(new JwtInvalidError({ reason: "missing sub" }));
    }
    return payload;
  });
