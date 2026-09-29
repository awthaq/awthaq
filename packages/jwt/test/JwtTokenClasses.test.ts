// VB-005 / JJS-007 / JJS-003 — principal tokens (`typ: at+jwt`) and general-
// purpose tokens (`typ: JWT`) are separate classes, `signJWT` takes a per-call
// audience, `verifyJWT` does not demand a `sub`, and an algorithm switch keeps
// grace-period keys of the old algorithm verifying.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Jwt from "../src/Jwt.ts";
import * as JwtConfig from "../src/JwtConfig.ts";
import * as KeyRing from "../src/KeyRing.ts";
import * as RevocationStore from "../src/RevocationStore.ts";
import * as SigningKeyRecords from "../src/SigningKeyRecords.ts";

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const asCaller = (id: string, sessionId: string) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id }),
    sessionId,
  });

const buildLayer = (overrides?: Partial<JwtConfig.JwtConfigShape>) =>
  Jwt.Jwt.layer.pipe(
    Layer.provide(KeyRing.KeyRing.layer),
    Layer.provide(SigningKeyRecords.layerMemory),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(AuthenticationLive),
    Layer.provideMerge(Sessions.layerMemory),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(RevocationStore.layerMemory),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(JwtConfig.config({ issuer: "https://issuer.test", ...overrides })),
  );

const headerOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));

describe("token classes (VB-005)", () => {
  it.effect("sign(principal) produces header typ at+jwt", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.sign(asCaller("user-1", "session-1"));
      assert.strictEqual(headerOf(token).typ, "at+jwt");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("signJWT produces header typ JWT by default and honours options.typ", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      assert.strictEqual(headerOf(yield* jwt.signJWT({ sub: "a" })).typ, "JWT");
      assert.strictEqual(
        headerOf(yield* jwt.signJWT({ sub: "a" }, { typ: "custom+jwt" })).typ,
        "custom+jwt",
      );
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("signJWT({ sub, sid }) is rejected by verifyLive and verify (typ mismatch)", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const sessions = yield* Sessions.Sessions;
      const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });
      const forged = yield* jwt.signJWT({ sub: "user-1", sid: issued.session.id });
      const live = yield* jwt.verifyLive(forged).pipe(Effect.flip);
      assert.strictEqual(live.reason, "typ mismatch");
      const plain = yield* jwt.verify(forged).pipe(Effect.flip);
      assert.strictEqual(plain.reason, "typ mismatch");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("a principal token is not accepted by verifyJWT", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.sign(asCaller("user-1", "session-1"));
      const result = yield* jwt.verifyJWT(token).pipe(Effect.flip);
      assert.strictEqual(result.reason, "typ mismatch");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect(
    "signJWT(payload, { audience }) fails Jwt.verify at the origin but passes verifyJWT for that audience",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const token = yield* jwt.signJWT({ sub: "svc" }, { audience: "svc-a" });
        const atOrigin = yield* jwt.verifyJWT(token).pipe(Effect.flip);
        assert.strictEqual(atOrigin.reason, "iss/aud mismatch");
        const claims = yield* jwt.verifyJWT(token, { audience: "svc-a" });
        assert.strictEqual(claims["aud"], "svc-a");
      }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("signJWT accepts several audiences and rejects an empty list", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ sub: "svc" }, { audience: ["svc-a", "svc-b"] });
      yield* jwt.verifyJWT(token, { audience: "svc-b" });
      const empty = yield* jwt.signJWT({ sub: "svc" }, { audience: [] }).pipe(Effect.flip);
      assert.strictEqual(empty._tag, "JwtInvalidError");
    }).pipe(Effect.provide(buildLayer())),
  );
});

describe("subject requirement (JJS-007)", () => {
  it.effect("signJWT({ machine }) verifies via verifyJWT", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ machine: "etl-job" });
      const claims = yield* jwt.verifyJWT(token);
      assert.strictEqual(claims["machine"], "etl-job");
    }).pipe(Effect.provide(buildLayer())),
  );

  it.effect("Jwt.verify still rejects a principal token without sub", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.signJWT({ machine: "etl-job" }, { typ: "at+jwt" });
      const result = yield* jwt.verify(token).pipe(Effect.flip);
      assert.strictEqual(result.reason, "missing sub");
    }).pipe(Effect.provide(buildLayer())),
  );
});

// `Effect.provide` builds each layer in its own scope, so two KeyRings only
// share a store if the store *service* is built once and handed to both.
const sharedRecords = Effect.map(
  Effect.provide(SigningKeyRecords.SigningKeyRecords, SigningKeyRecords.layerMemory),
  (service) =>
    Layer.mergeAll(
      Layer.succeed(SigningKeyRecords.SigningKeyRecords, service),
      SqlTransaction.layerNoop,
    ),
);

describe("algorithm switch (JJS-003)", () => {
  it.effect(
    "switching JwtConfig.algorithm rotates on next access; the old key keeps verifying during grace",
    () =>
      Effect.gen(function* () {
        // One shared store, two KeyRings differing only in `JwtConfig.algorithm`.
        const records = yield* sharedRecords;
        const ringWith = (algorithm: JwtConfig.JwtConfigShape["algorithm"]) =>
          Layer.fresh(KeyRing.KeyRing.layer).pipe(
            Layer.provideMerge(records),
            Layer.provideMerge(JwtConfig.config({ issuer: "https://issuer.test", algorithm })),
            Layer.provideMerge(NodeCrypto.layer),
          );
        const before = yield* KeyRing.current.pipe(Effect.provide(ringWith("EdDSA")));
        assert.strictEqual(before.alg, "EdDSA");
        const after = yield* Effect.gen(function* () {
          const current = yield* KeyRing.current;
          const verifiable = yield* KeyRing.verifiable;
          return { current, verifiable };
        }).pipe(Effect.provide(ringWith("ES256")));
        assert.strictEqual(after.current.alg, "ES256");
        assert.notStrictEqual(after.current.kid, before.kid);
        assert.isTrue(
          after.verifiable.some((key) => key.kid === before.kid && key.alg === "EdDSA"),
        );
      }),
  );

  it.effect(
    "a token minted before an algorithm switch keeps verifying; new ones use the new algorithm",
    () =>
      Effect.gen(function* () {
        const records = yield* sharedRecords;
        const layerWith = (algorithm: JwtConfig.JwtConfigShape["algorithm"]) =>
          Jwt.Jwt.layer.pipe(
            Layer.provide(Layer.fresh(KeyRing.KeyRing.layer)),
            Layer.provide(records),
            Layer.provide(AuthenticationLive),
            Layer.provideMerge(Sessions.layerMemory),
            Layer.provideMerge(AuthEvents.layer),
            Layer.provideMerge(AuditLog.layerMemory),
            Layer.provideMerge(RevocationStore.layerMemory),
            Layer.provide(NodeCrypto.layer),
            Layer.provide(JwtConfig.config({ issuer: "https://issuer.test", algorithm })),
          );
        const oldToken = yield* Effect.gen(function* () {
          const jwt = yield* Jwt.Jwt;
          return yield* jwt.signJWT({ sub: "a" });
        }).pipe(Effect.provide(Layer.fresh(layerWith("EdDSA"))));
        yield* Effect.gen(function* () {
          const jwt = yield* Jwt.Jwt;
          const newToken = yield* jwt.signJWT({ sub: "b" });
          assert.strictEqual(headerOf(newToken).alg, "ES256");
          yield* jwt.verifyJWT(newToken);
          yield* jwt.verifyJWT(oldToken);
        }).pipe(Effect.provide(Layer.fresh(layerWith("ES256"))));
      }),
  );
});
