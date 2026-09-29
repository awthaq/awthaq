// GC-002 / JJS-008 / JJS-007 / JJS-003 / BAM-010 / JJS-009 — the codec's claims
// schema, typ/nbf/iat enforcement, per-key algorithm pinning, the asymmetric
// algorithm table, and characterization pins for algorithm confusion and
// unknown-kid fail-closed. Tokens are hand-assembled from real WebCrypto keys
// so the codec is exercised directly, with no plugin composition.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as JwtCodec from "../src/JwtCodec.ts";

const ISSUER = "https://issuer.test";
const AUDIENCE = "svc-a";

interface TestKey {
  readonly kid: string;
  readonly alg: JwtCodec.Algorithm;
  readonly publicKeyJwk: Record<string, unknown>;
  readonly privateKeyJwk: Record<string, unknown>;
}

const generate = (kid: string, alg: JwtCodec.Algorithm) =>
  Effect.map(JwtCodec.generateKeyJwks(alg), ({ publicKeyJwk, privateKeyJwk }): TestKey => ({
    kid,
    alg,
    publicKeyJwk: { ...publicKeyJwk, kid, alg },
    privateKeyJwk: { ...privateKeyJwk, kid, alg },
  }));

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  iat: 0,
  exp: 900,
  sub: "user-1",
  ...extra,
});

const mint = (
  key: TestKey,
  overrides: { readonly typ?: string; readonly claims?: Record<string, unknown> } = {},
) =>
  JwtCodec.sign({
    kid: key.kid,
    alg: key.alg,
    typ: overrides.typ ?? "at+jwt",
    signer: JwtCodec.localSigner(key.privateKeyJwk),
    claims: claims(overrides.claims),
  });

const verify = (
  token: string,
  keys: ReadonlyArray<TestKey>,
  extra: {
    readonly algorithms?: ReadonlyArray<JwtCodec.Algorithm>;
    readonly expectedTyp?: string;
    readonly requireSubject?: boolean;
    readonly audience?: string;
    readonly clockSkew?: Duration.Input;
  } = {},
) =>
  JwtCodec.verify({
    token,
    keys: keys.map(({ kid, alg, publicKeyJwk }) => ({ kid, alg, publicKeyJwk })),
    algorithms: extra.algorithms ?? [...new Set(keys.map((key) => key.alg))],
    issuer: ISSUER,
    audience: extra.audience ?? AUDIENCE,
    expectedTyp: extra.expectedTyp ?? "at+jwt",
    requireSubject: extra.requireSubject ?? true,
    ...(extra.clockSkew === undefined ? {} : { clockSkew: extra.clockSkew }),
  });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Re-signs nothing: swaps the header of a real token, so the signature no longer covers it. */
const withHeader = (token: string, header: Record<string, unknown>) => {
  const [, payload, signature] = token.split(".");
  return `${b64(header)}.${payload}.${signature}`;
};

const reason = <A>(effect: Effect.Effect<A, JwtCodec.JwtInvalidError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("JwtCodec algorithm table (BAM-010)", () => {
  for (const alg of ["EdDSA", "ES256", "ES384", "RS256", "PS256"] as const) {
    it.effect(`${alg}: sign/verify round-trip`, () =>
      Effect.gen(function* () {
        const key = yield* generate("k1", alg);
        const token = yield* mint(key);
        const payload = yield* verify(token, [key]);
        assert.strictEqual(payload["sub"], "user-1");
      }),
    );
  }

  it.effect("an RS256 header against an ES256-only key fails (cross-alg confusion)", () =>
    Effect.gen(function* () {
      const es = yield* generate("k1", "ES256");
      const rs = yield* generate("k1", "RS256");
      const token = yield* mint(rs);
      assert.strictEqual(yield* reason(verify(token, [es])), "algorithm not allowed");
    }),
  );

  it.effect("generateKeyJwks produces a usable pair for every algorithm", () =>
    Effect.gen(function* () {
      for (const alg of ["EdDSA", "ES256", "ES384", "RS256", "PS256"] as const) {
        const { publicKeyJwk, privateKeyJwk } = yield* JwtCodec.generateKeyJwks(alg);
        const key = {
          kid: "gen",
          alg,
          publicKeyJwk: { ...publicKeyJwk, kid: "gen", alg },
          privateKeyJwk,
        };
        const token = yield* mint(key);
        yield* verify(token, [key]);
      }
    }),
  );
});

describe("JwtCodec claims (GC-002)", () => {
  it.effect("an aud array containing the expected audience verifies", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { claims: { aud: ["other", AUDIENCE] } });
      const payload = yield* verify(token, [key]);
      assert.deepStrictEqual(payload["aud"], ["other", AUDIENCE]);
    }),
  );

  it.effect("an aud array without the expected audience fails", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { claims: { aud: ["other", "another"] } });
      assert.strictEqual(yield* reason(verify(token, [key])), "iss/aud mismatch");
    }),
  );

  it.effect("a non-integer exp fails as malformed", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* JwtCodec.sign({
        kid: key.kid,
        alg: key.alg,
        typ: "at+jwt",
        signer: JwtCodec.localSigner(key.privateKeyJwk),
        // hand-signed so the schema is enforced on the decode side too
        claims: claims(),
      });
      const [header, , signature] = token.split(".");
      const forged = `${header}.${b64({ ...claims(), exp: 900.5 })}.${signature}`;
      assert.strictEqual(yield* reason(verify(forged, [key])), "malformed token");
    }),
  );

  it.effect("an absent exp fails as malformed", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key);
      const [header, , signature] = token.split(".");
      const { exp: _exp, ...withoutExp } = claims();
      const forged = `${header}.${b64(withoutExp)}.${signature}`;
      assert.strictEqual(yield* reason(verify(forged, [key])), "malformed token");
    }),
  );
});

describe("JwtCodec typ/nbf/iat (JJS-008)", () => {
  it.effect("a token whose header typ differs from expectedTyp fails", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { typ: "JWT" });
      assert.strictEqual(yield* reason(verify(token, [key])), "typ mismatch");
      // and it verifies when the caller expects that class of token
      yield* verify(token, [key], { expectedTyp: "JWT" });
    }),
  );

  it.effect("typ is compared case-insensitively (RFC 7515 4.1.9)", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { typ: "AT+JWT" });
      yield* verify(token, [key]);
    }),
  );

  it.effect("a token with nbf in the future fails", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { claims: { nbf: 100 } });
      assert.strictEqual(yield* reason(verify(token, [key])), "not yet valid");
      yield* TestClock.adjust(Duration.seconds(101));
      yield* verify(token, [key]);
    }),
  );

  it.effect("a token with iat far in the future fails, clockSkew forgives a little", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, { claims: { iat: 600 } });
      assert.strictEqual(yield* reason(verify(token, [key])), "not yet valid");
      yield* verify(token, [key], { clockSkew: Duration.minutes(11) });
    }),
  );
});

describe("JwtCodec subject (JJS-007)", () => {
  it.effect("a token with no sub verifies when requireSubject is false", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key, {
        typ: "JWT",
        claims: { sub: undefined, machine: "etl-job" },
      });
      const payload = yield* verify(token, [key], { expectedTyp: "JWT", requireSubject: false });
      assert.strictEqual(payload["machine"], "etl-job");
      assert.strictEqual(
        yield* reason(verify(token, [key], { expectedTyp: "JWT" })),
        "missing sub",
      );
    }),
  );
});

describe("JwtCodec per-key algorithm (JJS-003)", () => {
  it.effect("keys of two algorithms verify side by side, each under its own alg", () =>
    Effect.gen(function* () {
      const ed = yield* generate("k-ed", "EdDSA");
      const es = yield* generate("k-es", "ES256");
      const edToken = yield* mint(ed);
      const esToken = yield* mint(es);
      yield* verify(edToken, [ed, es]);
      yield* verify(esToken, [ed, es]);
    }),
  );

  it.effect("a header alg that differs from the matched key's alg fails", () =>
    Effect.gen(function* () {
      const ed = yield* generate("k1", "EdDSA");
      const es = yield* generate("k1", "ES256");
      const token = yield* mint(es);
      // both algs are allowed, but kid k1 is an EdDSA key
      assert.strictEqual(
        yield* reason(verify(token, [ed], { algorithms: ["EdDSA", "ES256"] })),
        "algorithm not allowed",
      );
    }),
  );

  it.effect("a key whose alg is outside the allowlist is never used", () =>
    Effect.gen(function* () {
      const es = yield* generate("k1", "ES256");
      const token = yield* mint(es);
      assert.strictEqual(
        yield* reason(verify(token, [es], { algorithms: ["EdDSA"] })),
        "algorithm not allowed",
      );
    }),
  );
});

describe("JwtCodec pinning (JJS-009)", () => {
  it.effect('header alg "none" fails', () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key);
      const forged = withHeader(token, { alg: "none", kid: "k1", typ: "at+jwt" });
      assert.strictEqual(yield* reason(verify(forged, [key])), "algorithm not allowed");
    }),
  );

  it.effect("header alg missing fails", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const token = yield* mint(key);
      const forged = withHeader(token, { kid: "k1", typ: "at+jwt" });
      assert.strictEqual(yield* reason(verify(forged, [key])), "algorithm not allowed");
    }),
  );

  it.effect("header alg HS256 signed with the public key bytes as HMAC secret fails", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "ES256");
      const header = b64({ alg: "HS256", kid: "k1", typ: "at+jwt" });
      const payload = b64(claims());
      const secret = Buffer.from(JSON.stringify(key.publicKeyJwk));
      const hmacKey = yield* Effect.promise(() =>
        globalThis.crypto.subtle.importKey(
          "raw",
          secret,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      );
      const mac = yield* Effect.promise(() =>
        globalThis.crypto.subtle.sign("HMAC", hmacKey, Buffer.from(`${header}.${payload}`)),
      );
      const forged = `${header}.${payload}.${Buffer.from(mac).toString("base64url")}`;
      assert.strictEqual(yield* reason(verify(forged, [key])), "algorithm not allowed");
    }),
  );

  it.effect("ES256 header against an EdDSA configuration fails", () =>
    Effect.gen(function* () {
      const ed = yield* generate("k1", "EdDSA");
      const es = yield* generate("k1", "ES256");
      const token = yield* mint(es);
      assert.strictEqual(yield* reason(verify(token, [ed])), "algorithm not allowed");
    }),
  );

  it.effect("a kid matching no key fails closed even when other keys exist", () =>
    Effect.gen(function* () {
      const a = yield* generate("k-a", "EdDSA");
      const b = yield* generate("k-b", "EdDSA");
      const stranger = yield* generate("k-stranger", "EdDSA");
      const token = yield* mint(stranger);
      assert.strictEqual(yield* reason(verify(token, [a, b])), "unknown kid");
    }),
  );

  it.effect("a valid signature from another key sharing the kid's slot fails", () =>
    Effect.gen(function* () {
      const real = yield* generate("k1", "EdDSA");
      const impostor = yield* generate("k1", "EdDSA");
      const token = yield* mint(impostor);
      assert.strictEqual(yield* reason(verify(token, [real])), "bad signature");
    }),
  );
});
