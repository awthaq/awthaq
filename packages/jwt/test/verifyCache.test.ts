// ECF-002 / JJS-002 / KRS-010 / JJS-009 — the lite verifier's JWKS cache is
// single-flight, TTL'd, and only refetches (rate-limited) on an unknown kid.
// `fakeCountingHttpClient` records every outbound JWKS request. The full `Jwt`
// plugin is composed only to produce a really-signed token and a real JWKS
// document, exactly like `verify.test.ts`.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { AuditLog, AuthEvents, Sessions } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";
import * as Verify from "../src/verify.ts";

const ISSUER = "https://issuer.test";
const JWKS_URL = "https://issuer.test/jwt/jwks";

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const JwtLive = Jwt.Jwt.layer.pipe(
  Layer.provideMerge(KeyRing.KeyRing.layer),
  Layer.provideMerge(SigningKeyRecords.layerMemory),
  Layer.provideMerge(AuthenticationLive),
  Layer.provideMerge(Sessions.layerMemory),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(RevocationStore.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(JwtConfig.config({ issuer: ISSUER })),
);

const fakeCountingHttpClient = (served: Ref.Ref<unknown>, requests: Ref.Ref<number>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (n) => n + 1);
        yield* Effect.sleep(Duration.millis(5));
        const body = yield* Ref.get(served);
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    ),
  );

const verifierOptions = {
  jwksUrl: JWKS_URL,
  issuer: ISSUER,
  audience: ISSUER,
  algorithm: "EdDSA",
} as const;

describe("lite verifier JWKS caching (ECF-002)", () => {
  it.effect("N concurrent first verifications perform exactly one JWKS fetch", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" });
      const served = yield* Ref.make<unknown>(yield* jwt.jwks);
      const requests = yield* Ref.make(0);
      const verifier = yield* Verify.makeVerifier(verifierOptions).pipe(
        Effect.provide(fakeCountingHttpClient(served, requests)),
      );
      const fiber = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, () => verifier.verify(token)),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust(Duration.millis(10));
      yield* Fiber.join(fiber);
      assert.strictEqual(yield* Ref.get(requests), 1);
    }).pipe(Effect.provide(JwtLive)),
  );

  it.effect(
    "a burst of tokens with garbage kids within minRefetchInterval performs at most one refetch",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const good = yield* jwt.signJWT({ sub: "user-1" });
        const served = yield* Ref.make<unknown>(yield* jwt.jwks);
        const requests = yield* Ref.make(0);
        const verifier = yield* Verify.makeVerifier(verifierOptions).pipe(
          Effect.provide(fakeCountingHttpClient(served, requests)),
        );
        const warm = yield* Effect.forkChild(verifier.verify(good));
        yield* TestClock.adjust(Duration.millis(10));
        yield* Fiber.join(warm);
        const [, payload, signature] = good.split(".");
        const garbageHeader = Buffer.from(
          JSON.stringify({ alg: "EdDSA", kid: "no-such-kid", typ: "JWT" }),
        ).toString("base64url");
        const garbage = `${garbageHeader}.${payload}.${signature}`;
        const burst = yield* Effect.forkChild(
          Effect.all(
            Array.from({ length: 30 }, () => Effect.flip(verifier.verify(garbage))),
            { concurrency: "unbounded" },
          ),
        );
        yield* TestClock.adjust(Duration.millis(10));
        const failures = yield* Fiber.join(burst);
        assert.isTrue(failures.every((failure) => failure._tag === "JwtInvalidError"));
        // the cold fetch plus exactly one forced refetch
        assert.strictEqual(yield* Ref.get(requests), 2);
      }).pipe(Effect.provide(JwtLive)),
  );

  it.effect("a key removed from the JWKS stops verifying once cacheTtl elapses", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "user-1" });
      const served = yield* Ref.make<unknown>(yield* jwt.jwks);
      const requests = yield* Ref.make(0);
      const verifier = yield* Verify.makeVerifier({
        ...verifierOptions,
        cacheTtl: Duration.minutes(10),
        minRefetchInterval: Duration.seconds(30),
      }).pipe(Effect.provide(fakeCountingHttpClient(served, requests)));
      const first = yield* Effect.forkChild(verifier.verify(token));
      yield* TestClock.adjust(Duration.millis(10));
      yield* Fiber.join(first);
      // The issuer drops every key; within the TTL the cached copy still verifies.
      yield* Ref.set(served, { keys: [] });
      yield* TestClock.adjust(Duration.minutes(5));
      yield* verifier.verify(token);
      yield* TestClock.adjust(Duration.minutes(6));
      const after = yield* Effect.forkChild(Effect.flip(verifier.verify(token)));
      yield* TestClock.adjust(Duration.millis(20));
      const failure = yield* Fiber.join(after);
      assert.strictEqual(failure._tag, "JwtInvalidError");
    }).pipe(Effect.provide(JwtLive)),
  );
});
