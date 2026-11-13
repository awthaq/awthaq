// plan 38: the same vectors through both callers; a name in driftList is known drift,
// removed by the ticket that fixes it. This runner: the OIDC caller (`IdToken.verify`).
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";
import {
  AUDIENCE,
  ISSUER,
  JWKS_URL,
  NONCE,
  NOW_MS,
  vectors,
  type Vector,
} from "../../ports/test/jwsVectors.ts";
import * as IdToken from "../src/IdToken.ts";
import type * as OAuthProvider from "../src/OAuthProvider.ts";
import { fakeHttpClient } from "./FakeProvider.ts";

const driftList: ReadonlyArray<string> = [];

const providerFor = (vector: Vector): OAuthProvider.ResolvedProvider => ({
  id: "idp",
  kind: "oidc",
  issuer: Option.some(ISSUER),
  authorizationEndpoint: "https://idp.test/authorize",
  tokenEndpoint: "https://idp.test/token",
  jwksUri: Option.some(JWKS_URL),
  userinfoEndpoint: Option.none(),
  clientId: AUDIENCE,
  clientSecret: Option.none(),
  scopes: ["openid"],
  skipPkce: false,
  tokenEndpointAuthMethod: "client_secret_post",
  idTokenSigningAlgs: vector.algorithms,
  mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
});

const run = (vector: Vector) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const httpClient = yield* HttpClient.HttpClient;
    const outcome = yield* Effect.result(
      IdToken.verify({
        httpClient,
        jwksCaches: yield* IdToken.makeJwksCaches,
        provider: providerFor(vector),
        idToken: vector.token,
        nonce: NONCE,
        jwksTimeout: Duration.seconds(5),
        clockSkew: Duration.seconds(60),
        maxIdTokenAge: Option.none(),
      }),
    );
    const verdict = vector.policy?.oauth ?? vector.expected;
    if (verdict === "accept") {
      assert.isTrue(Result.isSuccess(outcome), `${vector.name} should verify`);
    } else {
      assert.isTrue(Result.isFailure(outcome), `${vector.name} should be refused`);
      if (Result.isFailure(outcome))
        assert.strictEqual(outcome.failure._tag, "OAuthCallbackFailed");
    }
  }).pipe(Effect.provide(fakeHttpClient({ "/jwks": vector.jwks })));

describe("JWS vectors through the OIDC id_token caller (plan 38)", () => {
  for (const vector of vectors) {
    const test = driftList.includes(vector.name) ? it.effect.fails : it.effect;
    test(vector.name, () => run(vector));
  }
});
