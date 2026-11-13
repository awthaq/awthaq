// plan 38 (ADR-EA-057): tests at the Jws interface. Every shared vector, the refetch contract,
// "never dies", and the cases that used to test the two private copies of this logic
// (AH-001/ESS-004, ACS-004, AOMS-005 from the OIDC copy; JJS-003, JJS-009, JJS-008 from the jwt codec).
// Signatures come from node:crypto, independent of WebCrypto signing.
import { Buffer } from "node:buffer";
import {
  constants,
  createHmac,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Jws from "../src/Jws.ts";
import { NOW_MS, SKEW_MS, vectors } from "./jwsVectors.ts";

type Entry = Record<string, unknown>;

const staticKeys = (set: Jws.JwkSet): Jws.KeySource<never> => ({
  get: Effect.succeed(set),
  refreshOnMiss: Effect.succeed(set),
});

const rejection = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(effect);
    assert.isTrue(Result.isFailure(outcome), "expected a failure");
    return Result.isFailure(outcome) ? outcome.failure : undefined;
  });

const reasonOf = (effect: Effect.Effect<unknown, Jws.JwsRejected>) =>
  Effect.map(rejection(effect), (error) => error?.reason);

describe("Jws vectors (jwsVectors.ts)", () => {
  for (const vector of vectors) {
    it.effect(vector.name, () =>
      Effect.gen(function* () {
        const run = Jws.verify({
          token: vector.token,
          keys: staticKeys(vector.jwks),
          algorithms: vector.algorithms,
          requireKid: false,
        });
        if (vector.jwsReason !== undefined) {
          assert.strictEqual(yield* reasonOf(run), vector.jwsReason);
          return;
        }
        const verified = yield* run;
        assert.strictEqual(
          Jws.timeProblem(verified.payload, { nowMs: NOW_MS, skewMs: SKEW_MS }),
          vector.timeProblem,
        );
      }),
    );
  }

  it.effect("kid-less with requireKid is missing-kid", () =>
    Effect.gen(function* () {
      const vector = vectors.find((candidate) => candidate.name === "kid-less");
      assert.isDefined(vector);
      if (vector === undefined) return;
      const reason = yield* reasonOf(
        Jws.verify({
          token: vector.token,
          keys: staticKeys(vector.jwks),
          algorithms: vector.algorithms,
          requireKid: true,
        }),
      );
      assert.strictEqual(reason, "missing-kid");
    }),
  );
});

describe("Jws refetch contract", () => {
  const vectorNamed = (name: string) => {
    const vector = vectors.find((candidate) => candidate.name === name);
    if (vector === undefined) throw new Error(`no vector ${name}`);
    return vector;
  };

  const counting = <E>(
    first: Effect.Effect<Jws.JwkSet, E>,
    refreshed: Effect.Effect<Jws.JwkSet, E>,
  ) => {
    const calls = { get: 0, refresh: 0 };
    const keys: Jws.KeySource<E> = {
      get: Effect.suspend(() => {
        calls.get += 1;
        return first;
      }),
      refreshOnMiss: Effect.suspend(() => {
        calls.refresh += 1;
        return refreshed;
      }),
    };
    return { keys, calls };
  };

  const input = <E>(name: string, keys: Jws.KeySource<E>) => {
    const vector = vectorNamed(name);
    return { token: vector.token, keys, algorithms: vector.algorithms, requireKid: true };
  };

  it.effect("an unknown kid refetches exactly once, and the refetched set can succeed", () =>
    Effect.gen(function* () {
      const valid = vectorNamed("valid-eddsa");
      const { keys, calls } = counting(Effect.succeed({ keys: [] }), Effect.succeed(valid.jwks));
      yield* Jws.verify(input("valid-eddsa", keys));
      assert.deepStrictEqual(calls, { get: 1, refresh: 1 });
    }),
  );

  it.effect("an unknown kid against a static set refetches once and is refused", () =>
    Effect.gen(function* () {
      const set = vectorNamed("unknown-kid").jwks;
      const { keys, calls } = counting(Effect.succeed(set), Effect.succeed(set));
      assert.strictEqual(yield* reasonOf(Jws.verify(input("unknown-kid", keys))), "unknown-kid");
      assert.deepStrictEqual(calls, { get: 1, refresh: 1 });
    }),
  );

  it.effect("key-mismatch reads get once and never refetches", () =>
    Effect.gen(function* () {
      const set = vectorNamed("key-alg-mismatch").jwks;
      const { keys, calls } = counting(Effect.succeed(set), Effect.succeed(set));
      assert.strictEqual(
        yield* reasonOf(Jws.verify(input("key-alg-mismatch", keys))),
        "key-mismatch",
      );
      assert.deepStrictEqual(calls, { get: 1, refresh: 0 });
    }),
  );

  for (const name of ["alg-not-allowed", "crit-unknown", "sig-not-base64url"]) {
    it.effect(`${name} touches no key source`, () =>
      Effect.gen(function* () {
        const set = vectorNamed(name).jwks;
        const { keys, calls } = counting(Effect.succeed(set), Effect.succeed(set));
        yield* rejection(Jws.verify(input(name, keys)));
        assert.deepStrictEqual(calls, { get: 0, refresh: 0 });
      }),
    );
  }

  it.effect("a get failure propagates unchanged", () =>
    Effect.gen(function* () {
      const { keys } = counting(Effect.fail("jwks down"), Effect.fail("jwks down"));
      assert.strictEqual(yield* rejection(Jws.verify(input("valid-eddsa", keys))), "jwks down");
    }),
  );
});

describe("Jws never dies on hostile input", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const hostile: ReadonlyArray<string> = [
    "",
    ".",
    "..",
    "...",
    "a.b.c.d",
    "only.two",
    "!!.!!.!!",
    `${encode(null)}.${encode({})}.sig`,
    `${encode([1, 2, 3])}.${encode({})}.sig`,
    `${encode({ alg: 5 })}.${encode({})}.sig`,
    `${encode({ alg: "EdDSA" })}.${encode(null)}.sig`,
    `${encode({ alg: "EdDSA" })}.${encode([])}.sig`,
    `${encode({ alg: "EdDSA" })}.${encode("text")}.sig`,
    `${encode({ alg: "EdDSA", crit: null })}.${encode({})}.sig`,
    `${encode({ alg: "EdDSA", kid: 7 })}.${encode({})}.sig`,
    "éè.é.é",
    "%00.%00.%00",
    `${"A".repeat(1_000_000)}.${"A".repeat(1_000_000)}.${"A".repeat(1_000_000)}`,
    `${Buffer.from("{not json").toString("base64url")}.e30.sig`,
    "e30.e30.e30",
  ];
  for (const [index, token] of hostile.entries()) {
    it.effect(`hostile string #${index} is a typed rejection`, () =>
      Effect.gen(function* () {
        const reason = yield* reasonOf(
          Jws.verify({
            token,
            keys: staticKeys({ keys: [] }),
            algorithms: Jws.algorithms,
            requireKid: false,
          }),
        );
        assert.include(["malformed", "alg", "crit"], reason);
      }),
    );
  }
});

// ---- cases moved from oauth/test/Jwt.test.ts and jwt/test/JwtCodec.test.ts ------------------------

interface TestKey {
  readonly alg: Jws.Algorithm;
  readonly kid: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

const rsaPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const p256Pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const p384Pair = generateKeyPairSync("ec", { namedCurve: "P-384" });
const edPair = generateKeyPairSync("ed25519");
const pairFor = (alg: Jws.Algorithm) => {
  switch (alg) {
    case "RS256":
    case "PS256":
      return rsaPair;
    case "ES256":
      return p256Pair;
    case "ES384":
      return p384Pair;
    case "EdDSA":
      return edPair;
  }
};
const keyOf = (alg: Jws.Algorithm, kid: string): TestKey => ({ alg, kid, ...pairFor(alg) });
const freshEd = (kid: string): TestKey => ({
  alg: "EdDSA",
  kid,
  ...generateKeyPairSync("ed25519"),
});

const signInput = (alg: Jws.Algorithm, privateKey: KeyObject, input: string): Buffer => {
  const data = Buffer.from(input);
  switch (alg) {
    case "RS256":
      return nodeSign("sha256", data, privateKey);
    case "PS256":
      return nodeSign("sha256", data, {
        key: privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
    case "ES256":
      return nodeSign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
    case "ES384":
      return nodeSign("sha384", data, { key: privateKey, dsaEncoding: "ieee-p1363" });
    case "EdDSA":
      return nodeSign(null, data, privateKey);
  }
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const PAYLOAD = { iss: "https://issuer.test", sub: "user-1", exp: 900, iat: 0 };

const tokenFor = (
  key: TestKey,
  options: { readonly header?: Entry; readonly payload?: Entry } = {},
): string => {
  const header = options.header ?? { alg: key.alg, kid: key.kid, typ: "JWT" };
  const signingInput = `${b64(header)}.${b64(options.payload ?? PAYLOAD)}`;
  return `${signingInput}.${signInput(key.alg, key.privateKey, signingInput).toString("base64url")}`;
};

const jwkOf = (key: TestKey, extra: Entry = {}): Entry => ({
  ...key.publicKey.export({ format: "jwk" }),
  kid: key.kid,
  alg: key.alg,
  ...extra,
});

const check = (
  token: string,
  keys: ReadonlyArray<Entry>,
  algorithms: ReadonlyArray<Jws.Algorithm>,
  requireKid = true,
) => Jws.verify({ token, keys: staticKeys({ keys }), algorithms, requireKid });

describe("Jws key selection (ACS-004, moved from the OIDC copy)", () => {
  it.effect("selects an RSA key by kid among several", () =>
    Effect.gen(function* () {
      const a = freshRsa("a");
      const b = freshRsa("b");
      const verified = yield* check(tokenFor(b), [jwkOf(a), jwkOf(b)], ["RS256"]);
      assert.strictEqual(verified.header.kid, "b");
    }),
  );

  const key = keyOf("RS256", "a");
  for (const [name, entry] of [
    [
      "a kty-less entry",
      (() => {
        const { kty: _kty, ...rest } = jwkOf(key);
        return rest;
      })(),
    ],
    ["use=enc keys", jwkOf(key, { use: "enc" })],
    [
      "an RSA entry missing n",
      (() => {
        const { n: _n, ...rest } = jwkOf(key);
        return rest;
      })(),
    ],
    ["a key whose alg is not the header's", jwkOf(key, { alg: "RS512" })],
  ] as const) {
    it.effect(`ignores ${name}`, () =>
      Effect.gen(function* () {
        const reason = yield* reasonOf(check(tokenFor(key), [entry], ["RS256"]));
        assert.include(["unknown-kid", "key-mismatch"], reason);
      }),
    );
  }

  it.effect("a kid-less token picks the lone usable key", () =>
    Effect.gen(function* () {
      const token = tokenFor(key, { header: { alg: "RS256", typ: "JWT" } });
      const verified = yield* check(
        token,
        [{ kty: "EC", crv: "P-256" }, jwkOf(key)],
        ["RS256"],
        false,
      );
      assert.isUndefined(verified.header.kid);
    }),
  );

  it.effect("a private member in a key set entry never reaches the import", () =>
    Effect.gen(function* () {
      const withPrivate = { ...key.privateKey.export({ format: "jwk" }), kid: "a", alg: "RS256" };
      const verified = yield* check(tokenFor(key), [withPrivate], ["RS256"]);
      assert.strictEqual(verified.header.alg, "RS256");
    }),
  );
});

const freshRsa = (kid: string): TestKey => ({
  alg: "RS256",
  kid,
  ...generateKeyPairSync("rsa", { modulusLength: 2048 }),
});

describe("Jws decoding (AH-001/ESS-004, moved)", () => {
  const key = keyOf("EdDSA", "k");
  const raw = (header: string, payload: string) =>
    `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}.c2ln`;

  it.effect("a well-formed token decodes and verifies", () =>
    Effect.gen(function* () {
      const verified = yield* check(tokenFor(key), [jwkOf(key)], ["EdDSA"]);
      assert.strictEqual(verified.payload["iss"], "https://issuer.test");
      assert.strictEqual(verified.header.kid, "k");
    }),
  );

  for (const [name, token] of [
    ["a JSON null header", raw("null", "{}")],
    ["a JSON null payload", raw('{"alg":"EdDSA"}', "null")],
    ["a header encoded as a JSON array", raw("[1,2,3]", "{}")],
    ["fewer than three segments", "only.two"],
  ] as const) {
    it.effect(`${name} is malformed`, () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* reasonOf(check(token, [jwkOf(key)], ["EdDSA"])), "malformed");
      }),
    );
  }

  it.effect("unknown header members are ignored", () =>
    Effect.gen(function* () {
      const token = tokenFor(key, {
        header: { alg: "EdDSA", kid: "k", typ: "JWT", x5t: "thumbprint" },
      });
      yield* check(token, [jwkOf(key)], ["EdDSA"]);
    }),
  );
});

describe("Jws per algorithm with node:crypto signatures (AOMS-005, moved)", () => {
  for (const alg of Jws.algorithms) {
    it.effect(`${alg}: a genuine signature verifies, a tampered payload does not`, () =>
      Effect.gen(function* () {
        const key = keyOf(alg, "k");
        const token = tokenFor(key);
        yield* check(token, [jwkOf(key)], [alg]);
        const [header, , signature] = token.split(".");
        const tampered = `${header}.${b64({ ...PAYLOAD, sub: "user-2" })}.${signature}`;
        assert.strictEqual(yield* reasonOf(check(tampered, [jwkOf(key)], [alg])), "signature");
      }),
    );
  }

  it.effect("a key of the wrong type or curve is never usable for the algorithm", () =>
    Effect.gen(function* () {
      const es256Token = tokenFor(keyOf("ES256", "k"));
      const p384AsEs256 = jwkOf(keyOf("ES384", "k"), { alg: undefined });
      assert.strictEqual(
        yield* reasonOf(check(es256Token, [p384AsEs256], ["ES256"])),
        "key-mismatch",
      );
      assert.strictEqual(
        yield* reasonOf(
          check(es256Token, [jwkOf(keyOf("RS256", "k"), { alg: undefined })], ["ES256"]),
        ),
        "key-mismatch",
      );
      const rs256Token = tokenFor(keyOf("RS256", "k"));
      assert.strictEqual(
        yield* reasonOf(
          check(rs256Token, [jwkOf(keyOf("EdDSA", "k"), { alg: undefined })], ["RS256"]),
        ),
        "key-mismatch",
      );
    }),
  );

  it("only the five verified algorithms are recognised", () => {
    assert.deepStrictEqual([...Jws.algorithms], ["RS256", "PS256", "ES256", "ES384", "EdDSA"]);
    assert.isFalse(Jws.isAlgorithm("HS256"));
    assert.isFalse(Jws.isAlgorithm("none"));
    assert.isTrue(Jws.isAlgorithm("ES256"));
    assert.strictEqual(Jws.keyType("PS256"), "RSA");
    assert.strictEqual(Jws.keyType("ES384"), "EC");
    assert.strictEqual(Jws.keyType("EdDSA"), "OKP");
  });
});

describe("Jws algorithm pinning and key slots (JJS-003, JJS-009, moved)", () => {
  it.effect("an RS256 header against an ES256-only key is refused (cross-alg confusion)", () =>
    Effect.gen(function* () {
      const token = tokenFor(keyOf("RS256", "k1"));
      const reason = yield* reasonOf(check(token, [jwkOf(keyOf("ES256", "k1"))], ["ES256"]));
      assert.strictEqual(reason, "alg");
    }),
  );

  it.effect("keys of two algorithms verify side by side, each under its own alg", () =>
    Effect.gen(function* () {
      const ed = keyOf("EdDSA", "k-ed");
      const es = keyOf("ES256", "k-es");
      const set = [jwkOf(ed), jwkOf(es)];
      yield* check(tokenFor(ed), set, ["EdDSA", "ES256"]);
      yield* check(tokenFor(es), set, ["EdDSA", "ES256"]);
    }),
  );

  it.effect("a header alg that differs from the matched key's alg is refused", () =>
    Effect.gen(function* () {
      const ed = keyOf("EdDSA", "k1");
      const token = tokenFor(keyOf("ES256", "k1"));
      assert.strictEqual(
        yield* reasonOf(check(token, [jwkOf(ed)], ["EdDSA", "ES256"])),
        "key-mismatch",
      );
    }),
  );

  it.effect("a key whose alg is outside the allowlist is never used", () =>
    Effect.gen(function* () {
      const es = keyOf("ES256", "k1");
      assert.strictEqual(yield* reasonOf(check(tokenFor(es), [jwkOf(es)], ["EdDSA"])), "alg");
    }),
  );

  it.effect("header alg missing is refused", () =>
    Effect.gen(function* () {
      const key = keyOf("EdDSA", "k1");
      const token = tokenFor(key, { header: { kid: "k1", typ: "JWT" } });
      assert.include(["malformed", "alg"], yield* reasonOf(check(token, [jwkOf(key)], ["EdDSA"])));
    }),
  );

  it.effect("HS256 with the public key bytes as the HMAC secret is refused", () =>
    Effect.gen(function* () {
      const key = keyOf("ES256", "k1");
      const input = `${b64({ alg: "HS256", kid: "k1", typ: "JWT" })}.${b64(PAYLOAD)}`;
      const mac = createHmac("sha256", JSON.stringify(jwkOf(key)))
        .update(input)
        .digest();
      const forged = `${input}.${mac.toString("base64url")}`;
      assert.strictEqual(yield* reasonOf(check(forged, [jwkOf(key)], Jws.algorithms)), "alg");
    }),
  );

  it.effect("an ES256 header against an EdDSA allowlist is refused", () =>
    Effect.gen(function* () {
      const token = tokenFor(keyOf("ES256", "k1"));
      assert.strictEqual(
        yield* reasonOf(check(token, [jwkOf(keyOf("EdDSA", "k1"))], ["EdDSA"])),
        "alg",
      );
    }),
  );

  it.effect("a kid matching no key fails closed even when other keys exist", () =>
    Effect.gen(function* () {
      const set = [jwkOf(freshEd("k-a")), jwkOf(freshEd("k-b"))];
      const reason = yield* reasonOf(check(tokenFor(freshEd("k-stranger")), set, ["EdDSA"]));
      assert.strictEqual(reason, "unknown-kid");
    }),
  );

  it.effect("a valid signature from another key sharing the kid's slot is refused", () =>
    Effect.gen(function* () {
      const real = freshEd("k1");
      const impostor = freshEd("k1");
      assert.strictEqual(
        yield* reasonOf(check(tokenFor(impostor), [jwkOf(real)], ["EdDSA"])),
        "signature",
      );
    }),
  );
});

describe("Jws.timeProblem (JJS-008, moved)", () => {
  const at = { nowMs: 100_000, skewMs: 0 };
  it("exp is required, finite and judged with the leeway", () => {
    assert.strictEqual(Jws.timeProblem({}, at), "exp");
    assert.strictEqual(Jws.timeProblem({ exp: "x" }, at), "exp");
    assert.strictEqual(Jws.timeProblem({ exp: 100 }, at), "exp");
    assert.isUndefined(Jws.timeProblem({ exp: 100 }, { nowMs: 100_000, skewMs: 1 }));
  });
  it("a future nbf is refused until the clock catches up", () => {
    assert.strictEqual(Jws.timeProblem({ exp: 900, nbf: 200 }, at), "nbf");
    assert.strictEqual(Jws.timeProblem({ exp: 900, nbf: "x" }, at), "nbf");
    assert.isUndefined(Jws.timeProblem({ exp: 900, nbf: 100 }, at));
  });
  it("a future iat is refused; a leeway forgives a little", () => {
    assert.strictEqual(Jws.timeProblem({ exp: 900, iat: 600 }, at), "iat");
    assert.strictEqual(Jws.timeProblem({ exp: 900, iat: "x" }, at), "iat");
    assert.isUndefined(
      Jws.timeProblem({ exp: 900, iat: 600 }, { nowMs: 100_000, skewMs: 600_000 }),
    );
  });
});
