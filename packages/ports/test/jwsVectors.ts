// Test-only support (plan 38): one table of compact-JWS vectors, shared by the
// jwt runner, the oauth runner and `Jws.test.ts`. Plain data: it imports only
// `node:crypto`/`node:buffer`, so no verifier under test signs a vector.
// Signatures come from `crypto.sign`, keys from `generateKeyPairSync`.
import { Buffer } from "node:buffer";
import {
  constants,
  createHmac,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";

export const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
export const ISSUER = "https://idp.test";
export const AUDIENCE = "client-1";
export const NONCE = "n-1";
export const SKEW_MS = 60_000;
export const JWKS_URL = "https://idp.test/jwks";

type VectorAlg = "RS256" | "PS256" | "ES256" | "ES384" | "EdDSA";
type Verdict = "accept" | "reject";

export interface Vector {
  readonly name: string;
  readonly token: string;
  readonly jwks: { readonly keys: ReadonlyArray<Record<string, unknown>> };
  readonly algorithms: ReadonlyArray<VectorAlg>;
  /** The RFC-correct verdict after plan 38. */
  readonly expected: Verdict;
  /** The `Jws`-level rejection reason ticket 04 asserts. */
  readonly jwsReason?:
    | "malformed"
    | "crit"
    | "alg"
    | "missing-kid"
    | "unknown-kid"
    | "key-mismatch"
    | "signature";
  readonly timeProblem?: "exp" | "nbf" | "iat";
  /** A caller-policy override (not drift). */
  readonly policy?: { readonly jwt?: Verdict; readonly oauth?: Verdict };
}

interface Pair {
  readonly alg: VectorAlg;
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const pair = (alg: VectorAlg, kid: string, keys: Omit<Pair, "alg" | "kid">): Pair => ({
  alg,
  kid,
  ...keys,
});

const keys = {
  RS256: pair("RS256", "k-rs256", rsa()),
  PS256: pair("PS256", "k-ps256", rsa()),
  ES256: pair("ES256", "k-es256", generateKeyPairSync("ec", { namedCurve: "P-256" })),
  ES384: pair("ES384", "k-es384", generateKeyPairSync("ec", { namedCurve: "P-384" })),
  EdDSA: pair("EdDSA", "k-eddsa", generateKeyPairSync("ed25519")),
};
const decoyRsa = rsa().publicKey;

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString("base64url");
const json = (value: unknown): string => b64(JSON.stringify(value));

const signWith = (key: Pair, input: string): Buffer => {
  const data = Buffer.from(input);
  switch (key.alg) {
    case "RS256":
      return nodeSign("sha256", data, key.privateKey);
    case "PS256":
      return nodeSign("sha256", data, {
        key: key.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
    case "ES256":
      return nodeSign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
    case "ES384":
      return nodeSign("sha384", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
    case "EdDSA":
      return nodeSign(null, data, key.privateKey);
  }
};

const defaultClaims = (): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "user-1",
  nonce: NONCE,
  iat: NOW_S,
  exp: NOW_S + 600,
});

const defaultHeader = (key: Pair): Record<string, unknown> => ({
  alg: key.alg,
  kid: key.kid,
  typ: "JWT",
});

const makeToken = (
  key: Pair,
  options: {
    readonly header?: Record<string, unknown>;
    readonly claims?: Record<string, unknown>;
  } = {},
): string => {
  const signingInput = `${json(options.header ?? defaultHeader(key))}.${json(options.claims ?? defaultClaims())}`;
  return `${signingInput}.${b64(signWith(key, signingInput))}`;
};

const publicJwk = (key: Pair): Record<string, unknown> => ({
  ...key.publicKey.export({ format: "jwk" }),
});
const jwkOf = (key: Pair, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...publicJwk(key),
  kid: key.kid,
  alg: key.alg,
  use: "sig",
  ...extra,
});

const withoutKeys = (record: Record<string, unknown>, ...names: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));

const row = (
  name: string,
  key: Pair,
  expected: Verdict,
  extra: Partial<Omit<Vector, "name" | "expected">> = {},
): Vector => ({
  name,
  token: makeToken(key),
  jwks: { keys: [jwkOf(key)] },
  algorithms: [key.alg],
  expected,
  ...extra,
});

const claimsWith = (extra: Record<string, unknown>) => ({ ...defaultClaims(), ...extra });
const replaceSegment = (token: string, index: number, replacement: string): string =>
  token
    .split(".")
    .map((segment, at) => (at === index ? replacement : segment))
    .join(".");

const { RS256, PS256, ES256, ES384, EdDSA } = keys;
const valid = makeToken(EdDSA);

export const vectors: ReadonlyArray<Vector> = [
  row("valid-rs256", RS256, "accept"),
  row("valid-ps256", PS256, "accept"),
  row("valid-es256", ES256, "accept"),
  row("valid-es384", ES384, "accept"),
  row("valid-eddsa", EdDSA, "accept"),
  row("alg-less-okp", EdDSA, "accept", {
    jwks: { keys: [withoutKeys(jwkOf(EdDSA), "alg")] },
  }),
  row("alg-less-rsa", RS256, "accept", {
    jwks: { keys: [withoutKeys(jwkOf(RS256), "alg")] },
  }),
  row("enc-key-shares-kid", RS256, "accept", {
    jwks: {
      keys: [
        {
          ...decoyRsa.export({ format: "jwk" }),
          kid: RS256.kid,
          alg: "RS256",
          use: "enc",
        },
        jwkOf(RS256),
      ],
    },
  }),
  row("enc-only", RS256, "reject", {
    jwks: { keys: [jwkOf(RS256, { use: "enc" })] },
    jwsReason: "unknown-kid",
  }),
  row("key-ops-encrypt-only", EdDSA, "reject", {
    jwks: { keys: [withoutKeys(jwkOf(EdDSA, { key_ops: ["encrypt"] }), "use")] },
    jwsReason: "unknown-kid",
  }),
  row("crit-unknown", EdDSA, "reject", {
    token: makeToken(EdDSA, {
      header: { ...defaultHeader(EdDSA), crit: ["x-unknown"], "x-unknown": true },
    }),
    jwsReason: "crit",
  }),
  row("sig-not-base64url", EdDSA, "reject", {
    token: replaceSegment(valid, 2, "!!"),
    jwsReason: "malformed",
  }),
  row("header-not-base64url", EdDSA, "reject", {
    token: `!${valid}`,
    jwsReason: "malformed",
  }),
  row("alg-not-allowed", ES256, "reject", { algorithms: ["EdDSA"], jwsReason: "alg" }),
  row("alg-none", EdDSA, "reject", {
    token: `${json({ alg: "none", kid: EdDSA.kid, typ: "JWT" })}.${json(defaultClaims())}.`,
    jwsReason: "alg",
  }),
  (() => {
    const signingInput = `${json({ alg: "HS256", kid: RS256.kid, typ: "JWT" })}.${json(defaultClaims())}`;
    const mac = createHmac("sha256", JSON.stringify(publicJwk(RS256))).update(signingInput);
    return row("alg-hs256", RS256, "reject", {
      token: `${signingInput}.${b64(mac.digest())}`,
      jwsReason: "alg",
    });
  })(),
  row("unknown-kid", EdDSA, "reject", {
    token: makeToken(EdDSA, { header: { ...defaultHeader(EdDSA), kid: "k-missing" } }),
    jwsReason: "unknown-kid",
  }),
  row("key-alg-mismatch", RS256, "reject", {
    // A PS256 signature by the RSA key, whose JWK advertises RS256 only.
    token: makeToken(pair("PS256", RS256.kid, RS256), {
      header: { alg: "PS256", kid: RS256.kid, typ: "JWT" },
    }),
    algorithms: ["RS256", "PS256"],
    jwsReason: "key-mismatch",
  }),
  row("curve-mismatch", ES384, "reject", {
    token: makeToken(pair("ES256", ES384.kid, ES384), {
      header: { alg: "ES256", kid: ES384.kid, typ: "JWT" },
    }),
    jwks: { keys: [withoutKeys(jwkOf(ES384), "alg")] },
    algorithms: ["ES256"],
    jwsReason: "key-mismatch",
  }),
  row("tampered-payload", EdDSA, "reject", {
    token: replaceSegment(valid, 1, json(claimsWith({ sub: "user-admin" }))),
    jwsReason: "signature",
  }),
  row("expired", EdDSA, "reject", {
    token: makeToken(EdDSA, { claims: claimsWith({ exp: NOW_S - 120 }) }),
    timeProblem: "exp",
  }),
  row("expired-within-skew", EdDSA, "accept", {
    token: makeToken(EdDSA, { claims: claimsWith({ exp: NOW_S - 30 }) }),
  }),
  row("nbf-future", EdDSA, "reject", {
    token: makeToken(EdDSA, { claims: claimsWith({ nbf: NOW_S + 120 }) }),
    timeProblem: "nbf",
  }),
  row("iat-future", EdDSA, "reject", {
    token: makeToken(EdDSA, { claims: claimsWith({ iat: NOW_S + 120 }) }),
    timeProblem: "iat",
  }),
  row("kid-less", EdDSA, "accept", {
    token: makeToken(EdDSA, { header: { alg: "EdDSA", typ: "JWT" } }),
    policy: { jwt: "reject" },
  }),
  row("typ-less", EdDSA, "accept", {
    token: makeToken(EdDSA, { header: { alg: "EdDSA", kid: EdDSA.kid } }),
    policy: { jwt: "reject" },
  }),
];
