// @awthaq/ports — Jws
//
// Plan 38 (ADR-EA-057): the one module that verifies a compact JWS for every verifier in the repo, the
// OIDC `id_token` (`@awthaq/oauth`), the jwt plugin and the edge-safe lite verifier (`@awthaq/jwt`).
// Behind the `verify` interface sits everything RFC 7515/7517/8725 says about a token and a key set:
//
//   - strict compact decoding (RFC 7515 §7.1): exactly three base64url segments, JSON object header and
//     payload. Malformed input is a typed `Jws/Rejected`, never a defect;
//   - `crit` (RFC 7515 §4.1.11): this module understands no extension, so any `crit` is refused;
//   - the algorithm table: RS256, PS256, ES256, ES384, EdDSA. HS* and `none` are unrepresentable, so a
//     verifier that holds only public keys can never be tricked into an HMAC check (RFC 8725 §3.1). The
//     header `alg` must be in the caller's allowlist; the allowlist is checked before any key is fetched;
//   - key selection (RFC 7517 §4.2-4.5): a key is a candidate when it decodes structurally and its `use`
//     is absent or `sig` and its `key_ops` is absent or includes `verify`. The token's `kid` matches
//     exactly. A usable key has `alg` absent or equal to the header `alg`, and a `kty`/`crv` that fits it;
//   - signature verification over WebCrypto, importing public members only (a private member such as `d`
//     in a key set never reaches `importKey`);
//   - one refetch of the key source when no candidate carries the token's `kid`.
//
// What stays with the callers: claim policy (`iss`, `aud`, `typ`, `nonce`, integer NumericDates ...), where
// keys come from, how long they are cached and how a fetch failure is classified. `timeProblem` is the one
// piece of claim policy shared by both: `exp`/`nbf`/`iat` judgement with a leeway.
//
// Edge-safe: imports only `effect` and (as a type) `node:crypto`, so `@awthaq/jwt/verify` can reach it.

import type { webcrypto } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The five asymmetric JWS algorithms WebCrypto implements; HS* and `none` are unrepresentable. */
export const Algorithm = Schema.Literals(["RS256", "PS256", "ES256", "ES384", "EdDSA"]);
export type Algorithm = typeof Algorithm.Type;

/** In the order RS256, PS256, ES256, ES384, EdDSA (a boot message lists them in this order). */
export const algorithms: ReadonlyArray<Algorithm> = Algorithm.literals;

export const isAlgorithm: (value: unknown) => value is Algorithm = Schema.is(Algorithm);

interface AlgorithmSpec {
  readonly kty: "RSA" | "EC" | "OKP";
  /** The `crv` a JWK for this algorithm must carry (EC and OKP only). */
  readonly crv: string | undefined;
  readonly importParams:
    | webcrypto.AlgorithmIdentifier
    | webcrypto.RsaHashedImportParams
    | webcrypto.EcKeyImportParams;
  readonly signParams:
    | webcrypto.AlgorithmIdentifier
    | webcrypto.RsaPssParams
    | webcrypto.EcdsaParams;
}

const specs: Record<Algorithm, AlgorithmSpec> = {
  RS256: {
    kty: "RSA",
    crv: undefined,
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    signParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    kty: "RSA",
    crv: undefined,
    importParams: { name: "RSA-PSS", hash: "SHA-256" },
    signParams: { name: "RSA-PSS", saltLength: 32 },
  },
  ES256: {
    kty: "EC",
    crv: "P-256",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    signParams: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    crv: "P-384",
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    signParams: { name: "ECDSA", hash: "SHA-384" },
  },
  EdDSA: {
    kty: "OKP",
    crv: "Ed25519",
    importParams: { name: "Ed25519" },
    signParams: { name: "Ed25519" },
  },
};

/** The `kty` a JWK for `alg` must carry. */
export const keyType = (alg: Algorithm): "RSA" | "EC" | "OKP" => specs[alg].kty;

/** WebCrypto import and sign/verify parameters for `alg` (the jwt signer reads these too). */
export const webCryptoParams = (
  alg: Algorithm,
): Pick<AlgorithmSpec, "importParams" | "signParams"> => ({
  importParams: specs[alg].importParams,
  signParams: specs[alg].signParams,
});

/**
 * A JWK Set document (RFC 7517 §5). Each entry stays a record, so one foreign key (an algorithm this
 * module does not speak, say) cannot void the whole set; `verify` narrows every entry itself.
 */
export const JwkSet = Schema.Struct({
  keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
export type JwkSet = typeof JwkSet.Type;

/** Where the keys come from. A `RefreshingCache<JwkSet, E>` satisfies it structurally. */
export interface KeySource<E> {
  readonly get: Effect.Effect<JwkSet, E>;
  /** Re-reads the keys after an unknown `kid`; the source decides whether that is rate limited. */
  readonly refreshOnMiss: Effect.Effect<JwkSet, E>;
}

export type Reason =
  | "malformed"
  | "crit"
  | "alg"
  | "missing-kid"
  | "unknown-kid"
  | "key-mismatch"
  | "signature";

/** Internal: each caller maps it to its own existing error, so no wire tag changes. */
export class JwsRejected extends Data.TaggedError("Jws/Rejected")<{
  readonly reason: Reason;
}> {}

export interface Verified {
  readonly header: {
    readonly alg: Algorithm;
    readonly kid: string | undefined;
    readonly typ: string | undefined;
  };
  readonly payload: Record<string, unknown>;
}

// ACS-004: a JWK is a candidate only once it decodes as one of these; a `kty`-less or member-less entry
// can never reach WebCrypto as key material.
const JwkCommon = {
  kid: Schema.optional(Schema.String),
  alg: Schema.optional(Schema.String),
  use: Schema.optional(Schema.String),
  key_ops: Schema.optional(Schema.Array(Schema.String)),
};
const Jwk = Schema.Union([
  Schema.Struct({ kty: Schema.Literal("RSA"), n: Schema.String, e: Schema.String, ...JwkCommon }),
  Schema.Struct({
    kty: Schema.Literal("EC"),
    crv: Schema.String,
    x: Schema.String,
    y: Schema.String,
    ...JwkCommon,
  }),
  Schema.Struct({
    kty: Schema.Literal("OKP"),
    crv: Schema.String,
    x: Schema.String,
    ...JwkCommon,
  }),
]);
type Jwk = typeof Jwk.Type;

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optional(Schema.String),
  typ: Schema.optional(Schema.String),
  crit: Schema.optional(Schema.Unknown),
});
const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));
const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeJwk = Schema.decodeUnknownOption(Jwk);

/** Whether `jwk`'s key type (and curve) is one `alg` can verify with. */
const fits = (alg: Algorithm, jwk: Jwk): boolean => {
  const spec = specs[alg];
  return jwk.kty === spec.kty && (jwk.kty === "RSA" || jwk.crv === spec.crv);
};

/** Only the public-key members: everything else in a set entry means nothing to WebCrypto's import. */
const publicMembers = (jwk: Jwk): webcrypto.JsonWebKey => {
  switch (jwk.kty) {
    case "RSA":
      return { kty: jwk.kty, n: jwk.n, e: jwk.e };
    case "EC":
      return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    case "OKP":
      return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  }
};

/** RFC 7517 §4.2-4.5 key selection. `unknown-kid` is the only outcome a refetch can change. */
const select = (
  set: JwkSet,
  alg: Algorithm,
  kid: string | undefined,
): Result.Result<Jwk, "unknown-kid" | "key-mismatch"> => {
  const candidates = set.keys.flatMap((entry) => {
    const jwk = decodeJwk(entry);
    return Option.isSome(jwk) &&
      (jwk.value.use === undefined || jwk.value.use === "sig") &&
      (jwk.value.key_ops === undefined || jwk.value.key_ops.includes("verify"))
      ? [jwk.value]
      : [];
  });
  const named = kid === undefined ? candidates : candidates.filter((jwk) => jwk.kid === kid);
  if (named.length === 0) return Result.fail("unknown-kid");
  const usable = named.find((jwk) => (jwk.alg === undefined || jwk.alg === alg) && fits(alg, jwk));
  return usable === undefined ? Result.fail("key-mismatch") : Result.succeed(usable);
};

const reject = (reason: Reason) => Effect.fail(new JwsRejected({ reason }));

const split = (token: string) => {
  const [header, payload, signature, ...rest] = token.split(".");
  return header === undefined || payload === undefined || signature === undefined || rest.length > 0
    ? undefined
    : { header, payload, signature };
};

/**
 * Verifies a compact JWS. Order: decode (`malformed`), `crit`, `alg` against `algorithms` (no key is
 * touched yet), `kid` (`missing-kid`), key selection with one refetch on `unknown-kid`, then the signature.
 * Claims are the caller's to judge; the payload comes back as a JSON object.
 */
export const verify = <E>(input: {
  readonly token: string;
  readonly keys: KeySource<E>;
  /** The caller's allowlist; never the header's say-so. */
  readonly algorithms: ReadonlyArray<Algorithm>;
  readonly requireKid: boolean;
}): Effect.Effect<Verified, JwsRejected | E> =>
  Effect.gen(function* () {
    const segments = split(input.token);
    if (segments === undefined) return yield* reject("malformed");
    const headerJson = Base64Url.decodeString(segments.header);
    const payloadJson = Base64Url.decodeString(segments.payload);
    const signature = Base64Url.decode(segments.signature);
    if (
      Result.isFailure(headerJson) ||
      Result.isFailure(payloadJson) ||
      Result.isFailure(signature)
    ) {
      return yield* reject("malformed");
    }
    const header = decodeHeader(headerJson.success);
    const payload = decodePayload(payloadJson.success);
    if (Option.isNone(header) || Option.isNone(payload)) return yield* reject("malformed");
    if ("crit" in header.value) return yield* reject("crit");

    const alg = header.value.alg;
    if (!isAlgorithm(alg) || !input.algorithms.includes(alg)) return yield* reject("alg");
    const kid = header.value.kid;
    if (input.requireKid && (kid === undefined || kid === "")) return yield* reject("missing-kid");

    const first = select(yield* input.keys.get, alg, kid);
    const selected =
      Result.isFailure(first) && first.failure === "unknown-kid"
        ? select(yield* input.keys.refreshOnMiss, alg, kid)
        : first;
    if (Result.isFailure(selected)) return yield* reject(selected.failure);

    const { importParams, signParams } = webCryptoParams(alg);
    const signingInput = new TextEncoder().encode(`${segments.header}.${segments.payload}`);
    const valid = yield* Effect.tryPromise({
      try: async () => {
        const key = await globalThis.crypto.subtle.importKey(
          "jwk",
          publicMembers(selected.success),
          importParams,
          false,
          ["verify"],
        );
        // JWS ECDSA signatures are the raw r || s form WebCrypto expects: no DER conversion.
        return globalThis.crypto.subtle.verify(
          signParams,
          key,
          new Uint8Array(signature.success),
          signingInput,
        );
      },
      catch: () => new JwsRejected({ reason: "signature" }),
    });
    if (!valid) return yield* reject("signature");
    return {
      header: { alg, kid, typ: header.value.typ },
      payload: payload.value,
    };
  });

export type TimeProblem = "exp" | "nbf" | "iat";

/**
 * RFC 7519 §4.1.4-4.1.6 with a leeway: `exp` is required and finite, and expired once
 * `nowMs >= exp * 1000 + skewMs`; a present `nbf` is refused until `nowMs + skewMs` reaches it; a present
 * `iat` is refused when it lies beyond `nowMs + skewMs`. Pure, so a caller places it in its own check order.
 */
export const timeProblem = (
  payload: Record<string, unknown>,
  at: { readonly nowMs: number; readonly skewMs: number },
): TimeProblem | undefined => {
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) return "exp";
  if (at.nowMs >= exp * 1000 + at.skewMs) return "exp";
  if ("nbf" in payload) {
    const nbf = payload["nbf"];
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) return "nbf";
    if (at.nowMs + at.skewMs < nbf * 1000) return "nbf";
  }
  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat)) return "iat";
    if (iat * 1000 > at.nowMs + at.skewMs) return "iat";
  }
  return undefined;
};
