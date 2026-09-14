// .scratch/jwt/issues/13-lite-verifier.md — the standalone lite verifier,
// deliberately NOT routed through `TestAuth`/plugin composition at all
// (the module under test, `../src/verify.ts`, cannot depend on any of
// that by design). The full `Jwt` plugin is composed only as this test
// file's own setup step, to produce a really-signed token and a real
// JWKS document for `verify.ts` to be handed as plain data/HTTP
// responses — mirroring `packages/oauth/test/OAuth.test.ts`'s own fake-
// `HttpClient` pattern for exercising fetch-based code without a network.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Sessions } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";
import * as Verify from "../src/verify.ts";

const ISSUER = "https://issuer.test";
const JWKS_URL = "https://issuer.test/jwt/jwks";

/**
 * `Jwt.layer` bundles the `jwt.token` mint endpoint's handlers (ticket
 * 10), which require `Api.Authentication` to discharge — even here, in a
 * test that never goes over HTTP and never invokes that middleware.
 * Mirrors `packages/jwt/test/Jwt.test.ts`'s own identical fix.
 */
const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// `provideMerge`, not `provide`, throughout: one test below
// (`KeyRing.rotateNow`) needs the exact same `KeyRing`/`SigningKeyRecords`/
// `JwtConfig`/`Crypto` instances `Jwt.layer` itself already uses, exposed
// alongside `Jwt` rather than hidden inside its own composition — a
// second, independently-built `KeyRing` would rotate a key `jwt.sign`
// never reads from. `Sessions` is exposed for the same reason `verifyLive`
// (unused by this file, but part of `Jwt.layer`'s own declared `R`) needs
// it — mirroring `packages/jwt/test/Jwt.test.ts`'s own identical fix.
const buildJwtLayer = () =>
  Jwt.Jwt.layer.pipe(
    Layer.provideMerge(KeyRing.KeyRing.layer),
    Layer.provideMerge(SigningKeyRecords.layerMemory),
    Layer.provideMerge(AuthenticationLive),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(JwtConfig.config({ issuer: ISSUER })),
  );

/** Serves whatever JWKS document `served` currently holds — lets a test simulate a server-side rotation between two fetches. */
const fakeJwksHttpClient = (served: Ref.Ref<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.map(Ref.get(served), (body) =>
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      ),
    ),
  );

describe("lite verifier (@awthaq/jwt/verify)", () => {
  it.effect("accepts a genuinely valid token", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" });
      const jwks = yield* jwt.jwks;

      const served = yield* Ref.make<unknown>(jwks);
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: ISSUER,
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const claims = yield* verifier.verify(token);
      assert.strictEqual(claims["sub"], "user-1");
    }).pipe(Effect.provide(buildJwtLayer())),
  );

  it.effect("rejects a tampered signature", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" });
      const jwks = yield* jwt.jwks;
      const segments = token.split(".");
      const tampered = `${segments[0]}.${segments[1]}.${segments[2]?.slice(0, -2)}aa`;

      const served = yield* Ref.make<unknown>(jwks);
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: ISSUER,
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const result = yield* verifier.verify(tampered).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildJwtLayer())),
  );

  it.effect("rejects a wrong issuer/audience", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" });
      const jwks = yield* jwt.jwks;

      const served = yield* Ref.make<unknown>(jwks);
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: "https://someone-else.test",
        audience: "https://someone-else.test",
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const result = yield* verifier.verify(token).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildJwtLayer())),
  );

  it.effect("rejects an expired token", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" }, { ttl: Duration.minutes(15) });
      const jwks = yield* jwt.jwks;
      yield* TestClock.adjust(Duration.minutes(16));

      const served = yield* Ref.make<unknown>(jwks);
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: ISSUER,
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const result = yield* verifier.verify(token).pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildJwtLayer())),
  );

  it.effect("rejects a malformed token", () =>
    Effect.gen(function* () {
      const served = yield* Ref.make<unknown>({ keys: [] });
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: ISSUER,
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const result = yield* verifier.verify("not-a-jwt").pipe(Effect.flip);
      assert.strictEqual(result._tag, "JwtInvalidError");
    }),
  );

  it.effect("refetches once on an unknown kid, then succeeds", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const tokenBeforeRotation = yield* jwt.signJWT({ sub: "user-1" });
      const jwksBeforeRotation = yield* jwt.jwks;

      yield* KeyRing.rotateNow;
      const tokenAfterRotation = yield* jwt.signJWT({ sub: "user-2" });
      const jwksAfterRotation = yield* jwt.jwks;

      // The verifier's very first fetch (triggered by verifying the
      // pre-rotation token) only ever sees the pre-rotation JWKS — proving
      // the refetch below is genuinely earned by an unknown `kid`, not
      // just always-current data.
      const served = yield* Ref.make<unknown>(jwksBeforeRotation);
      const verifier = yield* Verify.makeVerifier({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        audience: ISSUER,
        algorithm: "EdDSA",
      }).pipe(Effect.provide(fakeJwksHttpClient(served)));

      const firstClaims = yield* verifier.verify(tokenBeforeRotation);
      assert.strictEqual(firstClaims["sub"], "user-1");

      // Simulate the server having rotated in the meantime.
      yield* Ref.set(served, jwksAfterRotation);

      const secondClaims = yield* verifier.verify(tokenAfterRotation);
      assert.strictEqual(secondClaims["sub"], "user-2");
    }).pipe(Effect.provide(buildJwtLayer())),
  );
});
