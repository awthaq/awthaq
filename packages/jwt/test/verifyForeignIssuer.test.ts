// FAMS-005 (option A, ticket recommendation): the lite verifier is the
// Firebase dual-run building block — an RS256 token with Firebase-shaped
// `iss`/`aud` verifies against a fake JWKS, and only under the allowlist the
// caller configured.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as JwtCodec from "../src/JwtCodec.ts";
import * as Verify from "../src/verify.ts";

const PROJECT = "demo-project";
const ISSUER = `https://securetoken.google.com/${PROJECT}`;

const jwksClient = (keys: ReadonlyArray<Record<string, unknown>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ keys }), { status: 200 }),
        ),
      ),
    ),
  );

const firebaseToken = Effect.gen(function* () {
  const { publicKeyJwk, privateKeyJwk } = yield* JwtCodec.generateKeyJwks("RS256");
  const kid = "firebase-key-1";
  const token = yield* JwtCodec.sign({
    kid,
    alg: "RS256",
    typ: "JWT",
    signer: JwtCodec.localSigner(privateKeyJwk),
    claims: { iss: ISSUER, aud: PROJECT, exp: 4_000_000_000, iat: 0, sub: "firebase-uid-1" },
  });
  return { token, jwks: [{ ...publicKeyJwk, kid, alg: "RS256", use: "sig" }] };
});

describe("lite verifier with a foreign RS256 issuer (FAMS-005)", () => {
  it.effect(
    "an RS256 token with Firebase-shaped iss/aud verifies via makeVerifier against a fake JWKS",
    () =>
      Effect.gen(function* () {
        const { token, jwks } = yield* firebaseToken;
        const verifier = yield* Verify.makeVerifier({
          jwksUrl:
            "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
          issuer: ISSUER,
          audience: PROJECT,
          algorithms: ["RS256"],
          expectedTyp: "JWT",
        }).pipe(Effect.provide(jwksClient(jwks)));
        const claims = yield* verifier.verify(token);
        assert.strictEqual(claims["sub"], "firebase-uid-1");
      }),
  );

  it.effect("the same token is refused when RS256 is not in the configured allowlist", () =>
    Effect.gen(function* () {
      const { token, jwks } = yield* firebaseToken;
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: "https://issuer.test/jwks",
        issuer: ISSUER,
        audience: PROJECT,
        algorithms: ["EdDSA"],
        expectedTyp: "JWT",
      }).pipe(Effect.provide(jwksClient(jwks)));
      const failure = yield* verifier.verify(token).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "algorithm not allowed");
    }),
  );
});
