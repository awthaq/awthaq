// spec/behaviors/21-qadi-resolvers-obligations.md, BEH-EA-161, BEH-EA-165.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { AttributeResolver, makeSubjectId } from "@qadi/core";
import * as Resolvers from "../src/Resolvers.ts";

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AttributesLayer = Resolvers.UserAttributes.pipe(Layer.provideMerge(CoreLive));

describe("UserAttributes (BEH-EA-161)", () => {
  it.effect("resolves email/emailVerified/name for a real user: subject", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "attrs@example.com", name: "Attrs" });
      const subjectId = makeSubjectId(`user:${user.id}`);

      const email = yield* attributeResolver.resolve(subjectId, "email");
      const emailVerified = yield* attributeResolver.resolve(subjectId, "emailVerified");
      const name = yield* attributeResolver.resolve(subjectId, "name");

      assert.strictEqual(email, "attrs@example.com");
      assert.strictEqual(emailVerified, false);
      assert.strictEqual(name, "Attrs");
    }).pipe(Effect.provide(AttributesLayer)),
  );

  it.effect("an unrecognized attribute name resolves to undefined, not an error", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "attrs2@example.com", name: "Attrs2" });
      const value = yield* attributeResolver.resolve(makeSubjectId(`user:${user.id}`), "plan");
      assert.isUndefined(value);
    }).pipe(Effect.provide(AttributesLayer)),
  );

  it.effect("a non-`user:` subject resolves to undefined — not this resolver's concern", () =>
    Effect.gen(function* () {
      const attributeResolver = yield* AttributeResolver;
      const value = yield* attributeResolver.resolve(makeSubjectId("apikey:key-1"), "email");
      assert.isUndefined(value);
    }).pipe(Effect.provide(AttributesLayer)),
  );

  it.effect("a deleted user's subject resolves to undefined, not a failure", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "gone@example.com", name: "Gone" });
      yield* users.delete(user.id);
      const value = yield* attributeResolver.resolve(makeSubjectId(`user:${user.id}`), "email");
      assert.isUndefined(value);
    }).pipe(Effect.provide(AttributesLayer)),
  );
});

describe("ObligationHandlers.reauth (BEH-EA-165)", () => {
  it.effect("a session authenticated within maxAgeSeconds discharges cleanly", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ email: "fresh@example.com", name: "Fresh" });
      const { session } = yield* sessions.issue({ userId: user.id });
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: user.id }),
        sessionId: session.id,
      });

      yield* Resolvers.ObligationHandlers.reauth([Resolvers.reauth(300)]).pipe(
        Effect.provideService(Api.CurrentPrincipal, principal),
      );
    }).pipe(Effect.provide(CoreLive)),
  );

  it.effect("a session older than maxAgeSeconds fails with ReauthRequired", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ email: "stale@example.com", name: "Stale" });
      const { session } = yield* sessions.issue({ userId: user.id });
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: user.id }),
        sessionId: session.id,
      });

      yield* TestClock.adjust(Duration.seconds(301));

      const failure = yield* Resolvers.ObligationHandlers.reauth([Resolvers.reauth(300)]).pipe(
        Effect.provideService(Api.CurrentPrincipal, principal),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "ReauthRequired");
      assert.strictEqual(failure.maxAgeSeconds, 300);
    }).pipe(Effect.provide(CoreLive)),
  );

  // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
  // (AAPS-001): before this fix, the handler compared `createdAt` — which
  // rotation/idle-refresh never advance — so a session minted long ago had
  // no way to discharge this obligation short of a full sign-out/sign-in,
  // even immediately after a real, fresh credential re-proof. This is the
  // scenario that regressed: `createdAt` is old, but `authenticatedAt` was
  // just refreshed.
  it.effect(
    "a session reauthenticated recently discharges even though it was minted long ago",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ email: "reauthed@example.com", name: "Reauthed" });
        const { session } = yield* sessions.issue({ userId: user.id });
        const principal = new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: user.id }),
          sessionId: session.id,
        });

        yield* TestClock.adjust(Duration.seconds(301));
        yield* sessions.reauthenticate(session.id);

        yield* Resolvers.ObligationHandlers.reauth([Resolvers.reauth(300)]).pipe(
          Effect.provideService(Api.CurrentPrincipal, principal),
        );
      }).pipe(Effect.provide(CoreLive)),
  );

  it.effect("an ApiKey principal (no session at all) fails with ReauthRequired", () =>
    Effect.gen(function* () {
      const principal = new Api.ApiKeyPrincipal({
        ref: new Api.PrincipalRef({ type: "apikey", id: "key-1" }),
      });
      const failure = yield* Resolvers.ObligationHandlers.reauth([Resolvers.reauth(300)]).pipe(
        Effect.provideService(Api.CurrentPrincipal, principal),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "ReauthRequired");
    }).pipe(Effect.provide(CoreLive)),
  );

  it.effect("no reauth obligation among the given obligations is a no-op", () =>
    Effect.gen(function* () {
      const principal = new Api.ApiKeyPrincipal({
        ref: new Api.PrincipalRef({ type: "apikey", id: "key-2" }),
      });
      yield* Resolvers.ObligationHandlers.reauth([]).pipe(
        Effect.provideService(Api.CurrentPrincipal, principal),
      );
    }).pipe(Effect.provide(CoreLive)),
  );
});
