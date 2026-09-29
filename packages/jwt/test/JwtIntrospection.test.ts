// TIR-007 (+SCP-007): `introspectComposed` — what `POST /jwt/introspect`
// calls — applies the session-liveness check whenever `Sessions` was composed
// alongside `Jwt` at build time, and is plain `introspect` otherwise.
// JR-005: an impersonation session's JWT carries an RFC 8693 `act.sub`.
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

const SessionsLive = Sessions.layerMemory.pipe(
  Layer.provide(AuthEvents.layer),
  Layer.provide(AuditLog.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const jwtBase = Jwt.Jwt.layer.pipe(
  Layer.provide(KeyRing.KeyRing.layer),
  Layer.provide(SigningKeyRecords.layerMemory),
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(RevocationStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(JwtConfig.config({ issuer: "https://issuer.test" })),
);

// `Sessions` is visible to `Jwt` (it is merged into the layer `Jwt` is built from).
const WithSessions = jwtBase.pipe(
  Layer.provide(AuthenticationLive),
  Layer.provideMerge(SessionsLive),
);

// `Sessions` exists (the mint endpoint's authentication needs one), but only
// inside `AuthenticationLive`'s own scope: `Jwt` itself cannot see it.
const WithoutSessions = jwtBase.pipe(
  Layer.provide(AuthenticationLive.pipe(Layer.provide(SessionsLive))),
);

const caller = (userId: string, sessionId: string, actingAs?: { type: string; id: string }) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: userId }),
    sessionId,
    ...(actingAs === undefined ? {} : { actingAs: new Api.PrincipalRef(actingAs) }),
  });

describe("Jwt.introspectComposed (TIR-007)", () => {
  it.effect(
    "reports active:false once the minting session is revoked, when Sessions is composed",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId("user-1") });
        const token = yield* jwt.sign(caller("user-1", issued.session.id));
        assert.isTrue((yield* jwt.introspectComposed(token)).active);
        yield* sessions.revoke(issued.session.id, "admin");
        assert.isFalse((yield* jwt.introspectComposed(token)).active);
        // bare introspect (denylist only) and verify keep the documented lag until exp
        assert.isTrue((yield* jwt.introspect(token)).active);
        yield* jwt.verify(token);
      }).pipe(Effect.provide(WithSessions)),
  );

  it.effect("still works (denylist only) in a composition without Sessions", () =>
    Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      const token = yield* jwt.sign(caller("user-1", "session-that-jwt-cannot-check"));
      const result = yield* jwt.introspectComposed(token);
      assert.isTrue(result.active);
    }).pipe(Effect.provide(WithoutSessions)),
  );
});

describe("act claim (JR-005)", () => {
  it.effect(
    "an impersonation session's minted JWT carries act.sub = the admin's id, non-impersonation tokens no act",
    () =>
      Effect.gen(function* () {
        const jwt = yield* Jwt.Jwt;
        const impersonated = yield* jwt.sign(
          caller("target-user", "session-1", { type: "user", id: "admin-1" }),
        );
        const claims = yield* jwt.verify(impersonated);
        assert.deepStrictEqual(claims["act"], { sub: "admin-1", awthaq_actor_type: "user" });
        assert.strictEqual(claims["sub"], "target-user");
        const plain = yield* jwt.verify(yield* jwt.sign(caller("target-user", "session-2")));
        assert.isUndefined(plain["act"]);
      }).pipe(Effect.provide(WithSessions)),
  );
});
