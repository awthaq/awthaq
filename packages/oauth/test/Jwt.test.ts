// AH-001/ESS-004: `decode` must turn a malformed (including maliciously
// minimal) header/payload segment into a typed `JwtVerificationError`,
// never an unhandled defect — the attacker fully controls both segments,
// and this runs before signature verification.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { constants, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import * as Jwt from "../src/Jwt.ts";

const toBase64Url = (value: string): string => Buffer.from(value).toString("base64url");

const buildToken = (header: string, payload: string, signature = "sig"): string =>
  `${toBase64Url(header)}.${toBase64Url(payload)}.${toBase64Url(signature)}`;

describe("Jwt.findKey (ACS-004)", () => {
  const rsa = { kty: "RSA", n: "modulus", e: "AQAB" };
  const keysOf = (...keys: ReadonlyArray<Record<string, unknown>>): Jwt.Jwks => ({ keys });

  it.effect("selects an RSA key by kid", () =>
    Effect.gen(function* () {
      const key = yield* Jwt.findKey(keysOf({ ...rsa, kid: "a" }, { ...rsa, kid: "b" }), "b");
      assert.strictEqual(key.kid, "b");
    }),
  );

  it.effect("ignores a kty-less entry", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.findKey(keysOf({ kid: "a", n: "m", e: "AQAB" }), "a").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("ignores use=enc keys", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.findKey(keysOf({ ...rsa, kid: "a", use: "enc" }), "a").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("ignores a key whose alg is not RS256", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.findKey(keysOf({ ...rsa, kid: "a", alg: "RS512" }), "a").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("ignores an RSA entry missing n", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.findKey(keysOf({ kty: "RSA", kid: "a", e: "AQAB" }), "a").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a kid-less token picks the lone valid RSA key", () =>
    Effect.gen(function* () {
      const key = yield* Jwt.findKey(
        keysOf({ kty: "EC", crv: "P-256" }, { ...rsa, kid: "only" }),
        undefined,
      );
      assert.strictEqual(key.kid, "only");
    }),
  );
});

describe("Jwt.decode (AH-001/ESS-004)", () => {
  it.effect("decodes a well-formed header/payload", () =>
    Effect.gen(function* () {
      const token = buildToken(
        JSON.stringify({ alg: "RS256", kid: "key-1" }),
        JSON.stringify({ iss: "https://issuer.example.com", sub: "user-1" }),
      );
      const decoded = yield* Jwt.decode(token);
      assert.strictEqual(decoded.header.alg, "RS256");
      assert.strictEqual(decoded.header.kid, "key-1");
      assert.strictEqual(decoded.payload["iss"], "https://issuer.example.com");
    }),
  );

  it.effect("a JSON `null` header fails with JwtVerificationError, not a defect", () =>
    Effect.gen(function* () {
      const token = buildToken("null", JSON.stringify({ iss: "https://issuer.example.com" }));
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a JSON `null` payload fails with JwtVerificationError, not a defect", () =>
    Effect.gen(function* () {
      const token = buildToken(JSON.stringify({ alg: "RS256" }), "null");
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a header encoded as a JSON array fails with JwtVerificationError", () =>
    Effect.gen(function* () {
      const token = buildToken("[1,2,3]", JSON.stringify({ iss: "https://issuer.example.com" }));
      const failure = yield* Jwt.decode(token).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("a token with fewer than 3 segments fails with JwtVerificationError", () =>
    Effect.gen(function* () {
      const failure = yield* Jwt.decode("only.two").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it.effect("extra, unrecognized header fields are dropped, not rejected", () =>
    Effect.gen(function* () {
      const token = buildToken(
        JSON.stringify({ alg: "RS256", typ: "JWT", x5t: "thumbprint" }),
        JSON.stringify({}),
      );
      const decoded = yield* Jwt.decode(token);
      assert.strictEqual(decoded.header.alg, "RS256");
      assert.notProperty(decoded.header, "x5t");
    }),
  );
});

// AOMS-005: id_token signatures beyond RS256, each over a real keypair and a real signature.
describe("Jwt.verifySignature / findKey per algorithm (AOMS-005)", () => {
  const data = new TextEncoder().encode("header.payload");

  interface Case {
    readonly alg: Jwt.SigningAlg;
    readonly publicKey: KeyObject;
    readonly sign: (input: Uint8Array) => Uint8Array;
  }

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const ed = generateKeyPairSync("ed25519");

  const cases: ReadonlyArray<Case> = [
    { alg: "RS256", publicKey: rsa.publicKey, sign: (i) => nodeSign("sha256", i, rsa.privateKey) },
    {
      alg: "PS256",
      publicKey: rsa.publicKey,
      sign: (i) =>
        nodeSign("sha256", i, {
          key: rsa.privateKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        }),
    },
    {
      alg: "ES256",
      publicKey: p256.publicKey,
      sign: (i) => nodeSign("sha256", i, { key: p256.privateKey, dsaEncoding: "ieee-p1363" }),
    },
    {
      alg: "ES384",
      publicKey: p384.publicKey,
      sign: (i) => nodeSign("sha384", i, { key: p384.privateKey, dsaEncoding: "ieee-p1363" }),
    },
    { alg: "EdDSA", publicKey: ed.publicKey, sign: (i) => nodeSign(null, i, ed.privateKey) },
  ];

  const jwkOf = (key: KeyObject, kid: string): Jwt.Jwks => ({
    keys: [{ ...key.export({ format: "jwk" }), kid }],
  });

  for (const testCase of cases) {
    it.effect(`${testCase.alg}: a genuine signature verifies, a tampered one does not`, () =>
      Effect.gen(function* () {
        const jwks = jwkOf(testCase.publicKey, "k");
        const jwk = yield* Jwt.findKey(jwks, "k", testCase.alg);
        const signature = Uint8Array.from(testCase.sign(data));
        assert.isTrue(yield* Jwt.verifySignature(testCase.alg, jwk, data, signature));
        const tampered = new TextEncoder().encode("header.payloaD");
        assert.isFalse(yield* Jwt.verifySignature(testCase.alg, jwk, tampered, signature));
      }),
    );
  }

  it.effect("a key of the wrong type or curve is not a candidate for the algorithm", () =>
    Effect.gen(function* () {
      const asEs256 = yield* Jwt.findKey(jwkOf(p384.publicKey, "k"), "k", "ES256").pipe(
        Effect.flip,
      );
      assert.strictEqual(asEs256._tag, "JwtVerificationError");
      const rsaAsEs = yield* Jwt.findKey(jwkOf(rsa.publicKey, "k"), "k", "ES256").pipe(Effect.flip);
      assert.strictEqual(rsaAsEs._tag, "JwtVerificationError");
      const edAsRs = yield* Jwt.findKey(jwkOf(ed.publicKey, "k"), "k", "RS256").pipe(Effect.flip);
      assert.strictEqual(edAsRs._tag, "JwtVerificationError");
    }),
  );

  it.effect("a key advertising a different alg than the one being verified is skipped", () =>
    Effect.gen(function* () {
      const jwks: Jwt.Jwks = {
        keys: [{ ...p256.publicKey.export({ format: "jwk" }), kid: "k", alg: "ES384" }],
      };
      const failure = yield* Jwt.findKey(jwks, "k", "ES256").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "JwtVerificationError");
    }),
  );

  it("only the five verified algorithms are recognised", () => {
    assert.deepStrictEqual([...Jwt.SIGNING_ALGS].sort(), [
      "ES256",
      "ES384",
      "EdDSA",
      "PS256",
      "RS256",
    ]);
    assert.isFalse(Jwt.isSigningAlg("HS256"));
    assert.isFalse(Jwt.isSigningAlg("none"));
    assert.isTrue(Jwt.isSigningAlg("ES256"));
  });
});
