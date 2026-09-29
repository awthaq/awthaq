// BCR-010/P20a: BEH-EA-258's scenarios (07-sessions.feature) — how a session was authenticated
// reaches the policy layer. The level derivation is the pure `Assurance` module's; the principal
// and subject attributes are what the running app's `PrincipalResolver` and the default
// `SubjectResolver` produce from a real session row.
import { Api } from "@awthaq/api";
import { Assurance, AuditLog, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Jwt, JwtConfig, KeyRing, RevocationStore, SigningKeyRecords } from "@awthaq/jwt";
import { SqlTransaction } from "@awthaq/ports";
import { SubjectResolver } from "@awthaq/qadi";
import { Authentication } from "@awthaq/server";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { inApp, World } from "./SessionWorld.ts";

/** `"none"` is how a Gherkin table spells "no method recorded". */
const methodsOf = (text: string): ReadonlyArray<Sessions.AuthMethod> =>
  text === "none" ? [] : text.split(",").filter(Sessions.isAuthMethod);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

const epochSeconds = (view: Sessions.SessionView) =>
  Math.floor(DateTime.toEpochMillis(view.authenticatedAt) / 1000);

/** A real `Jwt` service (the unit tests' composition), standing beside the sessions app: it only signs the principal it is handed. */
const JwtSigner = Jwt.Jwt.layer.pipe(
  Layer.provide(KeyRing.KeyRing.layer),
  Layer.provide(SigningKeyRecords.layerMemory),
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(
    Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  ),
  Layer.provideMerge(Sessions.layerMemory),
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(RevocationStore.layerMemory),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(JwtConfig.config({ issuer: "https://issuer.test" })),
);

export const sessionAssuranceSteps = defineSteps<World>(({ Given, When, Then }) => {
  When("the assurance of a session that recorded {string} is derived", function* (methods: string) {
    const { texts } = yield* World;
    yield* texts.set("methods", methods);
  });

  Then(
    "its level is {string} and its restricted-factor flag is {string}",
    function* (level: string, restricted: string) {
      const { texts } = yield* World;
      const derived = Assurance.assurance(methodsOf(yield* texts.get("methods")));
      assert.equal(derived.level, level);
      assert.equal(String(derived.restricted), restricted);
    },
  );

  Then("it satisfies {string} only when restricted factors are allowed", function* (level: string) {
    const { texts } = yield* World;
    const methods = methodsOf(yield* texts.get("methods"));
    // The level nominally reached, counting the restricted factor, is the one named ...
    assert.equal(Assurance.assurance(methods).level, level);
    // ... but a check that does not opt in ignores it, and one that does opt in accepts it.
    assert.equal(Assurance.satisfies(methods, "aal2"), false);
    assert.equal(Assurance.satisfies(methods, "aal2", { allowRestricted: true }), true);
  });

  /** Issues a real session for the named actor's user, recording `methods`, and remembers its view. */
  Given(
    "a session is issued for {string} that recorded {string}",
    function* (name: string, methods: string) {
      const { actors, views } = yield* World;
      const actor = yield* actors.get(name);
      const view = yield* inApp(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.findByEmail(actor.email);
          if (Option.isNone(user)) return yield* Effect.die(`no user ${actor.email}`);
          const issued = yield* sessions.issue({ userId: user.value.id, amr: methodsOf(methods) });
          return issued.session;
        }),
      );
      yield* views.set(name, view);
    },
  );

  When("the principal of that session is resolved", function* () {
    const { views, principals } = yield* World;
    const view = yield* views.get(yield* views.current);
    const principal = yield* inApp(
      Effect.flatMap(Authentication.PrincipalResolver, (resolver) => resolver.resolve(view)).pipe(
        Effect.provide(Authentication.PrincipalResolverLive),
      ),
    );
    assert.ok(principal instanceof Api.UserPrincipal);
    yield* principals.set("principal", principal);
  });

  // REQ-EA-1000: the same principal, signed by the JWT plugin.
  When("a principal token is minted for that session", function* () {
    const { views, principals, texts } = yield* World;
    const view = yield* views.get(yield* views.current);
    const principal = yield* inApp(
      Effect.flatMap(Authentication.PrincipalResolver, (resolver) => resolver.resolve(view)).pipe(
        Effect.provide(Authentication.PrincipalResolverLive),
      ),
    );
    assert.ok(principal instanceof Api.UserPrincipal);
    yield* principals.set("principal", principal);
    const claims = yield* Effect.gen(function* () {
      const jwt = yield* Jwt.Jwt;
      return yield* jwt.verify(yield* jwt.sign(principal));
    }).pipe(Effect.provide(JwtSigner));
    yield* texts.set("claims", JSON.stringify(claims));
  });

  Then(
    "the token carries {string} and {string} of that session",
    function* (amr: string, authTime: string) {
      const { views, texts } = yield* World;
      const view = yield* views.get(yield* views.current);
      const claims: Record<string, unknown> = JSON.parse(yield* texts.get("claims"));
      assert.deepEqual(claims[amr], ["pwd", "otp", "mfa"]);
      assert.equal(claims[authTime], epochSeconds(view));
    },
  );

  Then(
    "the principal carries the methods {string} and the session's authentication time in epoch seconds",
    function* (methods: string) {
      const { views, principals } = yield* World;
      const view = yield* views.get(yield* views.current);
      const principal = yield* principals.get("principal");
      assert.deepEqual(principal.amr, methodsOf(methods));
      assert.equal(principal.authenticatedAt, epochSeconds(view));
    },
  );

  Then(
    "the default subject holds the methods {string}, the authentication time, the level {string} and the restricted-factor flag {string}",
    function* (methods: string, level: string, restricted: string) {
      const { views, principals } = yield* World;
      const view = yield* views.get(yield* views.current);
      const principal = yield* principals.get("principal");
      const attributes = SubjectResolver.principalAttributes(principal);
      assert.deepEqual(field(attributes, "amr"), methodsOf(methods));
      assert.equal(field(attributes, "authenticatedAt"), epochSeconds(view));
      assert.equal(field(attributes, "aal"), level);
      assert.equal(String(field(attributes, "restrictedFactor")), restricted);
    },
  );
});
