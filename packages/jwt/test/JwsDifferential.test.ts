// plan 38: the same vectors through both callers; a name in driftList is known drift,
// removed by the ticket that fixes it. This runner: the lite verifier (`Verify.makeVerifier`).
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import {
  AUDIENCE,
  ISSUER,
  JWKS_URL,
  NOW_MS,
  vectors,
  type Vector,
} from "../../ports/test/jwsVectors.ts";
import * as Verify from "../src/verify.ts";

const jwksClient = (vector: Vector) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(vector.jwks), { status: 200 }),
        ),
      ),
    ),
  );

const run = (vector: Vector) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const verifier = yield* Verify.makeVerifier({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: vector.algorithms,
      expectedTyp: "JWT",
      clockSkew: "60 seconds",
    });
    const outcome = yield* Effect.result(verifier.verify(vector.token));
    const verdict = vector.policy?.jwt ?? vector.expected;
    if (verdict === "accept") {
      assert.isTrue(Result.isSuccess(outcome), `${vector.name} should verify`);
    } else {
      assert.isTrue(Result.isFailure(outcome), `${vector.name} should be refused`);
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "JwtInvalidError");
    }
  }).pipe(Effect.provide(jwksClient(vector)));

describe("JWS vectors through the lite verifier (plan 38)", () => {
  for (const vector of vectors) {
    it.effect(vector.name, () => run(vector));
  }
});
