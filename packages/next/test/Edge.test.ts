// spec/behaviors/24-nextjs-ssr.md, BEH-EA-188 (BO-006, D1 option C): the
// stateless edge tier verifies the opt-in session-mirror cookie with the lite
// verifier — no database, no `@awthaq/core`/`@awthaq/server` at the edge.
//
// The full `Jwt` plugin is composed only as this file's own setup step, to mint
// really-signed tokens and a real JWKS document; the code under test
// (`../src/edge.ts`) sees only plain cookie headers and an HTTP response.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Sessions } from "@awthaq/core";
import { Jwt, JwtConfig, KeyRing, RevocationStore, SigningKeyRecords } from "@awthaq/jwt";
import { makeVerifier } from "@awthaq/jwt/verify";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { afterEach, vi } from "vitest";
import { makeSessionVerifier, verifySessionJwt } from "../src/edge.ts";

const ISSUER = "https://issuer.test";
const JWKS_URL = "https://issuer.test/jwt/jwks";
const MIRROR = "__Host-session-jwt";

afterEach(() => vi.unstubAllGlobals());

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const JwtTestLayer = Jwt.Jwt.layer.pipe(
  Layer.provideMerge(KeyRing.KeyRing.layer),
  Layer.provideMerge(SigningKeyRecords.layerMemory),
  Layer.provideMerge(SqlTransaction.layerNoop),
  Layer.provideMerge(AuthenticationLive),
  Layer.provideMerge(Sessions.layerMemory),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(RevocationStore.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(JwtConfig.config({ issuer: ISSUER })),
);

const principal = new Api.UserPrincipal({
  ref: new Api.PrincipalRef({ type: "user", id: "user-1" }),
  sessionId: "session-1",
});

const jwksClient = (jwks: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(jwks), { status: 200 })),
      ),
    ),
  );

const requestWithCookie = (cookie: string | null) => ({
  headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? cookie : null) },
});

/** A verifier over the running plugin's real JWKS; the token minted for `session-1`. */
const setup = (ttl: Duration.Duration) =>
  Effect.gen(function* () {
    const jwt = yield* Jwt.Jwt;
    const token = yield* jwt.sign(principal, { ttl });
    const verifier = yield* makeVerifier({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ["EdDSA"],
    }).pipe(Effect.provide(jwksClient(yield* jwt.jwks)));
    return { token, verifier };
  });

describe("verifySessionJwt (BO-006)", () => {
  // `it.live`, not `it.effect`: the verifier runs on the real clock (it is a
  // plain-Promise edge helper), so tokens must be minted on it too.
  it.live("a valid mirror cookie yields the session's claims", () =>
    Effect.gen(function* () {
      const { token, verifier } = yield* setup(Duration.minutes(5));
      const claims = yield* Effect.promise(() =>
        verifySessionJwt(requestWithCookie(`theme=dark; ${MIRROR}=${token}`), verifier),
      );
      assert.strictEqual(claims?.["sub"], "user-1");
      assert.strictEqual(claims?.["sid"], "session-1");
    }).pipe(Effect.provide(JwtTestLayer)),
  );

  it.live("no cookie, another cookie, or a garbled one yields undefined", () =>
    Effect.gen(function* () {
      const { verifier } = yield* setup(Duration.minutes(5));
      for (const cookie of [null, "theme=dark", `${MIRROR}=not-a-jwt`, `${MIRROR}=%E0%A4%A`]) {
        const claims = yield* Effect.promise(() =>
          verifySessionJwt(requestWithCookie(cookie), verifier),
        );
        assert.isUndefined(claims);
      }
    }).pipe(Effect.provide(JwtTestLayer)),
  );

  it.live("a forged (tampered) mirror is rejected without any database", () =>
    Effect.gen(function* () {
      const { token, verifier } = yield* setup(Duration.minutes(5));
      const segments = token.split(".");
      const forged = `${segments[0]}.${segments[1]}.${segments[2]?.slice(0, -2)}aa`;
      const claims = yield* Effect.promise(() =>
        verifySessionJwt(requestWithCookie(`${MIRROR}=${forged}`), verifier),
      );
      assert.isUndefined(claims);
    }).pipe(Effect.provide(JwtTestLayer)),
  );

  it.live("an expired mirror is rejected", () =>
    Effect.gen(function* () {
      // Real time: the promise-returning helper under test runs on the real
      // clock, so a token has to actually age out.
      const { token, verifier } = yield* setup(Duration.seconds(1));
      yield* Effect.sleep(Duration.millis(2100));
      const claims = yield* Effect.promise(() =>
        verifySessionJwt(requestWithCookie(`${MIRROR}=${token}`), verifier),
      );
      assert.isUndefined(claims);
    }).pipe(Effect.provide(JwtTestLayer)),
  );

  it.live("a custom cookie name is honoured", () =>
    Effect.gen(function* () {
      const { token, verifier } = yield* setup(Duration.minutes(5));
      const claims = yield* Effect.promise(() =>
        verifySessionJwt(requestWithCookie(`__Host-edge=${token}`), verifier, {
          cookieName: "__Host-edge",
        }),
      );
      assert.strictEqual(claims?.["sub"], "user-1");
    }).pipe(Effect.provide(JwtTestLayer)),
  );

  it.live("makeSessionVerifier fetches the JWKS with fetch", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.sign(principal, { ttl: Duration.minutes(5) });
      const jwks = yield* jwt.jwks;
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } }),
      );
      const verifier = yield* Effect.promise(() =>
        makeSessionVerifier({
          jwksUrl: JWKS_URL,
          issuer: ISSUER,
          audience: ISSUER,
          algorithms: ["EdDSA"],
        }),
      );
      const claims = yield* Effect.promise(() =>
        verifySessionJwt(requestWithCookie(`${MIRROR}=${token}`), verifier),
      );
      assert.strictEqual(claims?.["sub"], "user-1");
    }).pipe(Effect.provide(JwtTestLayer)),
  );
});
