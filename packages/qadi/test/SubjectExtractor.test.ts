// spec/behaviors/20-qadi-bridge-path-b.md, BEH-EA-153.
// Most cases run over `TestAuth.layer`. The two session-rotation cases below stay hand-wired on purpose: a short-lived
// `SessionConfig` has to sit beneath the session stores, which `TestAuth.layer` builds with the default one (plan 08
// exemption).
import { Auth, AuditLog, AuthEvents, Hooks, Persistence, Sessions, Users } from "@awthaq/core";
import { Api } from "@awthaq/api";
import { Credentials } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { makeSubject } from "@qadi/core";
import { SubjectExtractor as QadiSubjectExtractor } from "@qadi/http";
import { SubjectResolver } from "../src/SubjectResolver.ts";
import * as SubjectExtractor from "../src/SubjectExtractor.ts";
import * as UserClaims from "../src/UserClaims.ts";
import { TestAuth } from "@awthaq/test";

// The extractor shares the composition's own `PrincipalResolver` (the same principal logic `Authentication` uses), so
// it is built over `TestAuth.layer` and the very `Users`/`Sessions` the test signs in against.
const TestLayer = TestAuth.layer(Auth.make([UserClaims.UserClaims]), {
  services: SubjectExtractor.SubjectExtractorLive,
});

// upstream-hardening-followups ticket 03: the same short touchEvery
// Sessions.test.ts's own rotation tests use, so a single TestClock.adjust
// crosses it.
const shortLivedConfig = Layer.succeed(Sessions.SessionConfig, {
  absolute: Duration.millis(1000),
  idle: Duration.millis(500),
  touchEvery: Duration.millis(100),
});

const ShortLivedCoreLive = Layer.mergeAll(
  Users.layer.pipe(Layer.provide(Persistence.memory)),
  Sessions.layer.pipe(Layer.provide(Persistence.memory)),
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, shortLivedConfig)),
);

const ShortLivedTestLayer = SubjectExtractor.SubjectExtractorLive.pipe(
  Layer.provide(Credentials.PrincipalResolverLive),
  Layer.provideMerge(ShortLivedCoreLive),
);

const unreachableSessions: Sessions.SessionsShape = {
  issue: () => Effect.die("not used in this test"),
  verify: () => Effect.die("not used in this test"),
  revoke: () => Effect.die("not used in this test"),
  revokeOwned: () => Effect.die("not used in this test"),
  revokeOthers: () => Effect.die("not used in this test"),
  revokeAll: () => Effect.die("not used in this test"),
  list: () => Effect.die("not used in this test"),
  findOwned: () => Effect.die("not used in this test"),
  isLive: () => Effect.die("not used in this test"),
  purgeExpired: () => Effect.die("not used in this test"),
  reauthenticate: () => Effect.die("not used in this test"),
  requireFresh: () => Effect.die("not used in this test"),
};

describe("SubjectExtractor (Path B adapter)", () => {
  it.effect("BEH-EA-153: no credential resolves to anonymous, not a failure", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/whatever"));
      const subject = yield* extractor.extract(request);
      assert.strictEqual(subject.id, "anonymous");
    }).pipe(Effect.provide(TestLayer)),
  );

  // Bug B (plan 11): Path B used to take the first PRESENT credential and never fall through.
  it.effect(
    "BEH-EA-153: a stale session cookie falls through to a valid bearer session, exactly as Authentication does",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "path-b-stale@example.com" },
          name: "Stale",
        });
        const { token } = yield* sessions.issue({ userId: user.id });
        const subject = yield* extractor.extract(
          HttpServerRequest.fromWeb(
            new Request("http://localhost/whatever", {
              headers: {
                cookie: `${Sessions.SESSION_COOKIE_NAME}=stale.cookie`,
                authorization: `Bearer ${Redacted.value(token)}`,
              },
            }),
          ),
        );
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "upstream-hardening-followups ticket 03: an endpoint combining Api.Authentication and " +
      "SubjectExtractorLive on one route survives a touchEvery-crossing request without a false anonymous/SessionNotFound",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const extractor = yield* QadiSubjectExtractor;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "both-bridges@example.com" },
          name: "Both",
        });
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
        const credentials = yield* Credentials.make;
        const presented = yield* Credentials.fromRequest(request);
        const resolved = yield* credentials.step(
          "cookie",
          presented,
          Credentials.userTier,
          Credentials.httpScope(request),
        );
        const principal = resolved.principal;
        assert.strictEqual(principal.ref.id, user.id);

        // Path B: SubjectExtractorLive, independently, on the SAME request
        // and the SAME (now-rotated-away) raw credential — before ticket
        // 03 this failed `SessionNotFound` internally and surfaced here as
        // a false `anonymous`, not the real user.
        const subject = yield* extractor.extract(request);
        assert.strictEqual(subject.id, `user:${user.id}`);
      }).pipe(
        Effect.provide(Layer.mergeAll(Credentials.PrincipalResolverLive, ShortLivedTestLayer)),
      ),
  );

  it.effect(
    "PIL-005: a Path-B-only route delivers the rotated secret on its response (Set-Cookie)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const users = yield* Users.Users;
          const extractor = yield* QadiSubjectExtractor;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "path-b-only@example.com" },
            name: "PathB",
          });
          const { token } = yield* sessions.issue({ userId: user.id });
          yield* TestClock.adjust(Duration.millis(200));

          const request = HttpServerRequest.fromWeb(
            new Request("http://localhost/whatever", {
              headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
            }),
          );
          // Pre-response handlers run when the request's response is written. Since effect 4.1
          // they live in the request state `toHandled` installs, so the extraction runs inside
          // the handled request, as it does behind a real router.
          let written: HttpServerResponse.HttpServerResponse | undefined;
          yield* HttpEffect.toHandled(
            Effect.gen(function* () {
              const subject = yield* extractor.extract(request);
              assert.strictEqual(subject.id, `user:${user.id}`);
              return HttpServerResponse.empty();
            }),
            (_request, response) =>
              Effect.sync(() => {
                written = response;
              }),
          ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
          const rotated =
            written === undefined
              ? Option.none()
              : Cookies.getValue(written.cookies, Sessions.SESSION_COOKIE_NAME);
          assert.isTrue(Option.isSome(rotated));
          if (Option.isNone(rotated)) return;
          assert.notStrictEqual(rotated.value, Redacted.value(token));
          yield* sessions.verify(Redacted.make(rotated.value));
        }),
      ).pipe(
        Effect.provide(Layer.mergeAll(Credentials.PrincipalResolverLive, ShortLivedTestLayer)),
      ),
  );

  // MA-004: an outage is the store being unreachable, never "no credential".
  it.effect("MA-004: a store outage is SubjectExtractionFailed, never anonymous", () =>
    Effect.gen(function* () {
      const extractor = yield* QadiSubjectExtractor;
      const failure = yield* extractor
        .extract(
          HttpServerRequest.fromWeb(
            new Request("http://localhost/whatever", {
              headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=some-id.some-secret` },
            }),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SubjectExtractionFailed");
    }).pipe(
      Effect.provide(
        SubjectExtractor.SubjectExtractorLive.pipe(
          Layer.provide(Credentials.PrincipalResolverLive),
          Layer.provide(
            Layer.succeed(Sessions.Sessions, {
              ...unreachableSessions,
              verify: () => Effect.fail(new Api.StoreUnavailable({ operation: "Sessions.verify" })),
            }),
          ),
          Layer.provide(
            Layer.succeed(SubjectResolver, {
              resolve: (principal) => Effect.succeed(makeSubject({ id: principal.ref.id })),
            }),
          ),
        ),
      ),
    ),
  );

  // APS-006: the impersonation rule is judged on the session, before the resolver (as on Path A), so a resolver
  // that drops `actingAs` still evaluates the impersonated user, never the admin behind it.
  it.effect(
    "APS-006: an impersonation session is judged on the session, not the resolved principal",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const extractor = yield* QadiSubjectExtractor;
        const issued = yield* sessions.issue({
          userId: Users.UserId("22222222-2222-2222-2222-222222222222"),
          actingAs: { type: "user", id: "11111111-1111-1111-1111-111111111111" },
        });
        const subject = yield* extractor.extract(
          HttpServerRequest.fromWeb(
            new Request("http://localhost/whatever", {
              headers: {
                cookie: `${Sessions.IMPERSONATION_COOKIE_NAME}=${Redacted.value(issued.token)}`,
              },
            }),
          ),
        );
        assert.strictEqual(subject.id, "user:22222222-2222-2222-2222-222222222222");
      }).pipe(
        Effect.provide(
          TestAuth.layer(Auth.make([UserClaims.UserClaims]), {
            principalResolver: Layer.succeed(Credentials.PrincipalResolver, {
              // A custom resolver that drops `actingAs` (the user principal carries none).
              resolve: (session) =>
                Effect.succeed(
                  new Api.UserPrincipal({
                    ref: new Api.PrincipalRef({ type: "user", id: session.userId }),
                    sessionId: session.id,
                  }),
                ),
            }),
            services: SubjectExtractor.SubjectExtractorLive,
          }),
        ),
      ),
  );

  // MAPS-001/OCM-002: Path B recognises exactly the credentials `Authentication` does.
  describe("contributed credential resolvers", () => {
    const service = (id: string) =>
      new Api.ServicePrincipal({
        ref: new Api.PrincipalRef({ type: "service", id }),
        scopes: [],
      });
    const contributions = Layer.mergeAll(
      Credentials.contribute("bearer", {
        id: "svc-jwt",
        claims: (raw) => raw.startsWith("svc."),
        resolve: () => Effect.succeed(service("from-bearer")),
      }),
      Credentials.contribute("apiKey", {
        id: "keys",
        claims: (raw) => raw.startsWith("ak_"),
        resolve: () => Effect.succeed(service("from-key")),
      }),
    );
    const WithResolvers = TestAuth.layer(Auth.make([UserClaims.UserClaims]), {
      services: Layer.mergeAll(SubjectExtractor.SubjectExtractorLive, contributions),
    });
    const extract = (headers: Record<string, string>) =>
      Effect.gen(function* () {
        const extractor = yield* QadiSubjectExtractor;
        return yield* extractor.extract(
          HttpServerRequest.fromWeb(new Request("http://localhost/whatever", { headers })),
        );
      });

    it.effect(
      "BEH-EA-153: a stale session cookie falls through to a claimed bearer credential",
      () =>
        Effect.gen(function* () {
          const subject = yield* extract({
            cookie: `${Sessions.SESSION_COOKIE_NAME}=stale.cookie`,
            authorization: "Bearer svc.x.y",
          });
          assert.strictEqual(subject.id, "service:from-bearer");
        }).pipe(Effect.provide(WithResolvers)),
    );

    it.effect(
      "BEH-EA-153/OCM-002: an x-api-key that does not resolve falls through to the bearer",
      () =>
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const users = yield* Users.Users;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "path-b-failing-key@example.com" },
            name: "Key",
          });
          const { token } = yield* sessions.issue({ userId: user.id });
          const subject = yield* extract({
            "x-api-key": "ak_bad.secret",
            authorization: `Bearer ${Redacted.value(token)}`,
          });
          assert.strictEqual(subject.id, `user:${user.id}`);
        }).pipe(
          Effect.provide(
            TestAuth.layer(Auth.make([UserClaims.UserClaims]), {
              services: Layer.mergeAll(
                SubjectExtractor.SubjectExtractorLive,
                Credentials.contribute("apiKey", {
                  id: "failing-keys",
                  claims: (raw) => raw.startsWith("ak_"),
                  resolve: () => Effect.fail(new Api.Unauthenticated()),
                }),
              ),
            }),
          ),
        ),
    );
  });
});
