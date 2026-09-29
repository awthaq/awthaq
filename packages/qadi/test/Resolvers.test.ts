// spec/behaviors/21-qadi-resolvers-obligations.md, BEH-EA-161, BEH-EA-165.
import { Api } from "@awthaq/api";
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Schema from "effect/Schema";
import { AttributeResolver, exists, hasAttribute, makeSubjectId, obligation } from "@qadi/core";
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
        scopes: [],
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
        scopes: [],
      });
      yield* Resolvers.ObligationHandlers.reauth([]).pipe(
        Effect.provideService(Api.CurrentPrincipal, principal),
      );
    }).pipe(Effect.provide(CoreLive)),
  );
});

// TS-001: an obligation shape the handler cannot interpret never silently passes.
describe("ObligationHandlers.reauth fails closed on a malformed obligation (TS-001)", () => {
  const apiKey = new Api.ApiKeyPrincipal({
    ref: new Api.PrincipalRef({ type: "apikey", id: "key-ts001" }),
    scopes: [],
  });
  const run = (duties: ReadonlyArray<ReturnType<typeof obligation>>) =>
    Resolvers.ObligationHandlers.reauth(duties).pipe(
      Effect.provideService(Api.CurrentPrincipal, apiKey),
    );

  it.effect("a reauth duty with attributes {} dies and never discharges", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(run([obligation(Resolvers.REAUTH_OBLIGATION_ID, {})]));
      assert.isTrue(exit._tag === "Failure" && exit.cause.reasons.some((r) => r._tag === "Die"));
    }).pipe(Effect.provide(CoreLive)),
  );

  it.effect("a non-numeric, negative or non-finite maxAgeSeconds dies", () =>
    Effect.gen(function* () {
      for (const maxAgeSeconds of ["300", -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
        const exit = yield* Effect.exit(
          run([obligation(Resolvers.REAUTH_OBLIGATION_ID, { maxAgeSeconds })]),
        );
        assert.isTrue(
          exit._tag === "Failure" && exit.cause.reasons.some((r) => r._tag === "Die"),
          `maxAgeSeconds ${String(maxAgeSeconds)}`,
        );
      }
    }).pipe(Effect.provide(CoreLive)),
  );

  it.effect("two reauth duties enforce the smaller maxAgeSeconds", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ email: "strict@example.com", name: "Strict" });
      const { session } = yield* sessions.issue({ userId: user.id });
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: user.id }),
        sessionId: session.id,
      });
      yield* TestClock.adjust(Duration.seconds(120));
      // 120s old: fine for 300, stale for 60 — the strictest duty wins, in either order.
      for (const duties of [
        [Resolvers.reauth(300), Resolvers.reauth(60)],
        [Resolvers.reauth(60), Resolvers.reauth(300)],
      ]) {
        const failure = yield* Resolvers.ObligationHandlers.reauth(duties).pipe(
          Effect.provideService(Api.CurrentPrincipal, principal),
          Effect.flip,
        );
        assert.strictEqual(failure._tag, "ReauthRequired");
        assert.strictEqual(failure.maxAgeSeconds, 60);
      }
    }).pipe(Effect.provide(CoreLive)),
  );

  it("the reauth(...) builder refuses to author a malformed obligation", () => {
    assert.throws(() => Resolvers.reauth(Number.NaN));
    assert.throws(() => Resolvers.reauth(-5));
    assert.throws(() => Resolvers.reauth(Number.POSITIVE_INFINITY));
    assert.strictEqual(Resolvers.reauth(0).attributes["maxAgeSeconds"], 0);
  });
});

// TS-002 (BEH-EA-161, REQ-EA-452/453): a store outage is a typed, attribute-naming
// AttributeResolveError — never `undefined`, never an uncaught defect.
describe("UserAttributes maps a Users outage to AttributeResolveError (TS-002)", () => {
  const DyingUsers = Layer.succeed(Users.Users, {
    create: () => Effect.die("create is not used"),
    findById: () => Effect.die(new Error("users store is down")),
    findByEmail: () => Effect.die("findByEmail is not used"),
    updateProfile: () => Effect.die("updateProfile is not used"),
    verifyEmail: () => Effect.die("verifyEmail is not used"),
    delete: () => Effect.die("delete is not used"),
    list: () => Effect.die("list is not used"),
  });

  it.effect("a Users outage fails AttributeResolveError naming the attribute", () =>
    Effect.gen(function* () {
      const attributeResolver = yield* AttributeResolver;
      const failure = yield* attributeResolver
        .resolve(makeSubjectId("user:u-1"), "emailVerified")
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AttributeResolveError");
      assert.strictEqual(failure.attribute, "emailVerified");
    }).pipe(Effect.provide(Resolvers.UserAttributes.pipe(Layer.provide(DyingUsers)))),
  );
});

// AAPS-004: N attribute reads of one user cost one lookup per request, and a
// new request re-reads (no cross-request staleness).
describe("UserAttributes memoizes the user record per request (AAPS-004)", () => {
  const counter = { lookups: 0 };
  const CountingUsers = Layer.effect(
    Users.Users,
    Effect.gen(function* () {
      const inner = yield* Users.Users;
      return {
        ...inner,
        findById: (id: Users.UserId) => {
          counter.lookups += 1;
          return inner.findById(id);
        },
      };
    }),
  ).pipe(Layer.provide(CoreLive));

  const CountingAttributes = Resolvers.UserAttributes.pipe(
    Layer.provideMerge(CountingUsers),
    Layer.provideMerge(CoreLive),
  );

  const requestOf = (path: string) =>
    HttpServerRequest.fromWeb(new Request(`http://localhost/${path}`));

  it.effect("one Users.findById per request for many attribute reads; a new request re-reads", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "memo@example.com", name: "Memo" });
      const subjectId = makeSubjectId(`user:${user.id}`);
      counter.lookups = 0;

      const readAll = Effect.all(
        [
          attributeResolver.resolve(subjectId, "email"),
          attributeResolver.resolve(subjectId, "emailVerified"),
          attributeResolver.resolve(subjectId, "name"),
        ],
        { concurrency: "unbounded" },
      );

      const first = requestOf("one");
      yield* readAll.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, first));
      yield* readAll.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, first));
      assert.strictEqual(counter.lookups, 1);

      // A different request never sees the first one's record.
      yield* users.verifyEmail(user.id);
      const [, emailVerified] = yield* readAll.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, requestOf("two")),
      );
      assert.strictEqual(counter.lookups, 2);
      assert.strictEqual(emailVerified, true);
    }).pipe(Effect.provide(CountingAttributes)),
  );

  it.effect("outside any HTTP request there is no memo (every read looks up)", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "nomemo@example.com", name: "NoMemo" });
      const subjectId = makeSubjectId(`user:${user.id}`);
      counter.lookups = 0;
      yield* attributeResolver.resolve(subjectId, "email");
      yield* attributeResolver.resolve(subjectId, "name");
      assert.strictEqual(counter.lookups, 2);
    }).pipe(Effect.provide(CountingAttributes)),
  );
});

// AAPS-003: the attribute names UserAttributes answers are typed, so a policy
// author's typo fails to compile instead of silently reading "no value".
describe("typed user attribute names (AAPS-003)", () => {
  it("userAttr accepts exactly the declared names and returns them unchanged", () => {
    assert.strictEqual(Resolvers.userAttr("email"), "email");
    assert.strictEqual(Resolvers.userAttr("emailVerified"), "emailVerified");
    // The typed name feeds qadi's own `hasAttribute` unchanged.
    assert.strictEqual(hasAttribute(Resolvers.userAttr("name"), exists())._tag, "HasAttribute");
    // @ts-expect-error a misspelled attribute is a compile error, not a silent miss
    assert.strictEqual(Resolvers.userAttr("emailVerifed"), "emailVerifed");
  });

  it("the declared schemas decode what the resolver returns, and reject other shapes", () => {
    assert.strictEqual(
      Schema.decodeUnknownSync(Resolvers.UserAttributeSchemas.email)("a@b.c"),
      "a@b.c",
    );
    assert.strictEqual(
      Schema.decodeUnknownSync(Resolvers.UserAttributeSchemas.emailVerified)(true),
      true,
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(Resolvers.UserAttributeSchemas.emailVerified)("yes"),
    );
    assert.deepStrictEqual([...Resolvers.UserAttributeNames].sort(), [
      "email",
      "emailVerified",
      "name",
    ]);
  });

  it.effect("every declared name resolves to a value its own schema decodes", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const attributeResolver = yield* AttributeResolver;
      const user = yield* users.create({ email: "typed@example.com", name: "Typed" });
      const subjectId = makeSubjectId(`user:${user.id}`);
      for (const name of Resolvers.UserAttributeNames) {
        const value = yield* attributeResolver.resolve(subjectId, name);
        Schema.decodeUnknownSync(Resolvers.UserAttributeSchemas[name])(value);
      }
    }).pipe(Effect.provide(AttributesLayer)),
  );
});
