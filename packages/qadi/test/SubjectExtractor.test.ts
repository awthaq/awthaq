// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153.
import { AuditLog, Hooks, AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { SubjectExtractor as QadiSubjectExtractor } from "@qadi/http";
import * as SubjectExtractor from "../src/SubjectExtractor.ts";

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const TestLayer = SubjectExtractor.SubjectExtractorLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
);

// upstream-hardening-followups ticket 03: the same short touchEvery
// Sessions.test.ts's own rotation tests use, so a single TestClock.adjust
// crosses it.
const shortLivedConfig = Layer.succeed(Sessions.SessionConfig, {
  absolute: Duration.millis(1000),
  idle: Duration.millis(500),
  touchEvery: Duration.millis(100),
});

const ShortLivedCoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig)),
);

const ShortLivedTestLayer = SubjectExtractor.SubjectExtractorLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(ShortLivedCoreLive),
);

describe("SubjectExtractor (Path B adapter)", () => {
  it.effect("BEH-EA-153: no credential resolves to anonymous, not a failure", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/whatever"));
      const subject = yield* extractor.extract(request);
      assert.strictEqual(subject.id, "anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-153: a valid session cookie resolves the real user, via the same logic Authentication uses",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({ email: "path-b@example.com", name: "Path B" });
        const { token } = yield* sessions.issue({ userId: user.id });
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/whatever", {
            headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
          }),
        );
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "BEH-EA-153: a bearer credential is accepted too, cookie taking priority when both are present",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({ email: "path-b-bearer@example.com", name: "Path B" });
        const { token } = yield* sessions.issue({ userId: user.id });
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/whatever", {
            headers: { authorization: `Bearer ${Redacted.value(token)}` },
          }),
        );
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "APS-006: an __Host-impersonation cookie shadows __Host-session and resolves the impersonated user; an ordinary session planted there is ignored",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const admin = yield* users.create({ email: "aps006-admin@example.com", name: "Admin" });
        const target = yield* users.create({ email: "aps006-target@example.com", name: "Target" });
        const own = yield* sessions.issue({ userId: admin.id });
        const impersonation = yield* sessions.issue({
          userId: target.id,
          actingAs: { type: "user", id: admin.id },
        });
        const extract = (cookie: string) =>
          extractor.extract(
            HttpServerRequest.fromWeb(
              new Request("http://localhost/whatever", { headers: { cookie } }),
            ),
          );

        const shadowed = yield* extract(
          `${Sessions.IMPERSONATION_COOKIE_NAME}=${Redacted.value(impersonation.token)}; ${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(own.token)}`,
        );
        assert.strictEqual(shadowed.id, `user:${target.id}`);

        const planted = yield* extract(
          `${Sessions.IMPERSONATION_COOKIE_NAME}=${Redacted.value(own.token)}; ${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(own.token)}`,
        );
        assert.strictEqual(planted.id, `user:${admin.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-153: an unknown session resolves to anonymous, never a failure", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/whatever", {
          headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=does-not-exist.secret` },
        }),
      );
      const subject = yield* extractor.extract(request);
      assert.strictEqual(subject.id, "anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening-followups ticket 03: an endpoint combining Api.Authentication and " +
      "SubjectExtractorLive on one route survives a touchEvery-crossing request without a false anonymous/SessionNotFound",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const resolver = yield* Authentication.PrincipalResolver;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({ email: "both-bridges@example.com", name: "Both" });
        const { token } = yield* sessions.issue({ userId: user.id });

        // Past touchEvery — the next verify rotates the session secret.
        yield* TestClock.adjust(Duration.millis(200));

        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/whatever", {
            headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
          }),
        );

        // Path A: Api.Authentication's own resolution, against the raw
        // (pre-rotation) credential — this is the call that actually
        // rotates the secret, exactly as it would inside AuthenticationLive.
        const principal = yield* Authentication.resolvePrincipal(sessions, resolver, token).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
        assert.strictEqual(principal.ref.id, user.id);

        // Path B: SubjectExtractorLive, independently, on the SAME request
        // and the SAME (now-rotated-away) raw credential — before ticket
        // 03 this failed `SessionNotFound` internally and surfaced here as
        // a false `anonymous`, not the real user.
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(
        Effect.provide(Layer.mergeAll(Authentication.PrincipalResolverLive, ShortLivedTestLayer)),
      ),
  );
});
