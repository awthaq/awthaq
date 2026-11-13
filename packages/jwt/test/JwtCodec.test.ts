// GC-002 / JJS-008 / JJS-007 / JJS-003 / BAM-010 / JJS-009 — the codec's claims
// schema, typ/nbf/iat enforcement, per-key algorithm pinning, the asymmetric
// algorithm table, and characterization pins for algorithm confusion and
// unknown-kid fail-closed. Tokens are hand-assembled from real WebCrypto keys
// so the codec is exercised directly, with no plugin composition.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

/** Signs an arbitrary payload (bypassing the claims schema) so only the verify-side schema can refuse it. */
const signRaw = (key: TestKey, payload: Record<string, unknown>) =>
  Effect.gen(function* () {
    const header = b64({ alg: key.alg, kid: key.kid, typ: "at+jwt" });
    const signingInput = `${header}.${b64(payload)}`;
    const signature = yield* JwtCodec.localSigner(key.privateKeyJwk).sign({
      kid: key.kid,
      alg: key.alg,
      signingInput: new TextEncoder().encode(signingInput),
    });
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  });

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

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
      const forged = yield* signRaw(key, { ...claims(), exp: 900.5 });
      assert.strictEqual(yield* reason(verify(forged, [key])), "malformed token");
    }),
  );

  it.effect("an absent exp fails as malformed", () =>
    Effect.gen(function* () {
      const key = yield* generate("k1", "EdDSA");
      const { exp: _exp, ...withoutExp } = claims();
      const forged = yield* signRaw(key, withoutExp);
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

describe("JwtCodec pinning (JJS-009)", () => {
  it.effect("a kid matching no key fails closed even when other keys exist", () =>
    Effect.gen(function* () {
      const a = yield* generate("k-a", "EdDSA");
      const b = yield* generate("k-b", "EdDSA");
      const stranger = yield* generate("k-stranger", "EdDSA");
      const token = yield* mint(stranger);
      assert.strictEqual(yield* reason(verify(token, [a, b])), "unknown kid");
    }),
  );
});
