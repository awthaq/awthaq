// spec/behaviors/04-contract-stratum.md, BEH-EA-031.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// Exercises the core `session` group's real HTTP surface — `AuthHttp.routes`/
// `AuthHttp.docs` registering `@awthaq/api`'s `AuthCoreApi` with a real
// `HttpRouter`, requests built from actual `Request` objects (BEH-EA-085's
// "any host that hands the application a `Request`" path), and `httpApiStatus`
// annotations landing on the real response status (BEH-EA-088).
import { Api, AuthCore } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  DataExport,
  Erasure,
  Hooks,
  AuthEvents,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { SqlTransaction, RateLimiter } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Cookies from "effect/unstable/http/Cookies";
import * as Etag from "effect/unstable/http/Etag";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Account from "../src/Account.ts";
import * as Authentication from "../src/Authentication.ts";
import * as AuthHttp from "../src/AuthHttp.ts";
import * as Csrf from "../src/Csrf.ts";
import { currentUser } from "../src/internal/CurrentUser.ts";
import { HandlerInvariantViolation } from "../src/internal/Defects.ts";
import * as Session from "../src/Session.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

// CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `SessionGroup`/
// `AccountGroup` now also carry `.middleware(Api.CsrfProtection)`, so this
// file's real HTTP requests need to play the double-submit role a real
// browser client would. Mirrors `packages/server/test/Csrf.test.ts`'s own
// `validCookieValue()`: an HMAC computed independently of `Csrf.ts`'s own
// implementation (Node's `node:crypto`), so a passing run exercises RFC
// 2104 compatibility, not just self-consistency with the code under test.
const CSRF_TEST_SECRET = "server-authhttp-test-csrf-secret";

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_TEST_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CSRF_TEST_COOKIE_VALUE: string = (() => {
  // CDS-006: `<iat>.<random>.<hmac(iat.random)>`. The router runs under `it.effect`'s TestClock, which starts at 0.
  const signed = `0.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`
    : `${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`;

/** Every request built in this file goes through this (or `cookieHeader` below), which folds it in — so an unsafe-method request always carries a valid double-submit pair, even one meant to exercise an *unauthenticated* 401 (otherwise it would hit `CsrfRejected`'s 403 first, since CSRF is declared last/outermost and runs before `Api.Authentication`). */
const csrfHeaders = (cookie?: string): Record<string, string> => ({
  cookie: withCsrfCookie(cookie),
  "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
});

const makeAppLayer = (
  sessionsLayer: typeof Sessions.layerMemory,
  limiterLayer: Layer.Layer<RateLimiter.RateLimiter> = RateLimiter.layerPermissive,
) =>
  Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.docs(AuthCore.AuthCoreApi),
  ).pipe(
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provide(CsrfProtectionLive),
    // CSG-001: `Account.deleteUser` runs core's `AccountErasure` and `Account.exportData` its `AccountExport` (CSG-005).
    Layer.provide(Layer.mergeAll(Erasure.layer, DataExport.layer)),
    // CSG-005: the export endpoint rate-limits per account.
    Layer.provide(limiterLayer),
    // CSG-001/DRS-002: `Account.deleteUser` now runs inside a
    // `SqlTransaction` — a no-op wrapper for this in-memory composition.
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provideMerge(sessionsLayer),
    Layer.provideMerge(Users.layerMemory),
    Layer.provideMerge(Accounts.layerMemory),
    Layer.provideMerge(Verification.layerMemory),
    // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerMemory),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = makeAppLayer(Sessions.layerMemory);

// TIR-003/ESS-005/GC-005: a `Sessions` whose `list` never contains the
// caller's own session — what the SQL layer's 200-row page cap used to do to
// a user with many historical sessions. Point queries must not depend on it.
const ListlessSessions: typeof Sessions.layerMemory = Layer.effect(
  Sessions.Sessions,
  Effect.gen(function* () {
    const real = yield* Sessions.Sessions;
    return { ...real, list: () => Effect.succeed([]) };
  }),
).pipe(Layer.provide(Sessions.layerMemory));

const ListlessAppLayer = makeAppLayer(ListlessSessions);

const userId = Users.UserId("44444444-4444-4444-4444-444444444444");
const otherUserId = Users.UserId("55555555-5555-5555-5555-555555555555");

const cookieHeader = (token: Redacted.Redacted<string>): Record<string, string> =>
  csrfHeaders(`${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`);

const jsonBody = (response: HttpServerResponse.HttpServerResponse): Effect.Effect<unknown> =>
  Effect.promise(() => HttpServerResponse.toWeb(response).json());

describe("AuthHttp + Session (real HTTP)", () => {
  it.effect("BEH-EA-031: current/list/signOut/revoke/revokeOthers, end to end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const a = yield* sessions.issue({ userId });
        const b = yield* sessions.issue({ userId });

        const send = (
          path: string,
          options?: { readonly method?: string; readonly token?: Redacted.Redacted<string> },
        ) =>
          router.asHttpEffect().pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`http://localhost${path}`, {
                  method: options?.method ?? "GET",
                  headers: options?.token ? cookieHeader(options.token) : {},
                }),
              ),
            ),
          );

        const current = yield* send("/session", { token: a.token });
        assert.strictEqual(current.status, 200);
        const currentBody = (yield* jsonBody(current)) as { id: string; current: boolean };
        assert.strictEqual(currentBody.id, a.session.id);
        assert.isTrue(currentBody.current);

        const list = yield* send("/session/list", { token: a.token });
        assert.strictEqual(list.status, 200);
        const listBody = (yield* jsonBody(list)) as ReadonlyArray<unknown>;
        assert.strictEqual(listBody.length, 2);

        const signedOut = yield* send("/session/sign-out", { method: "POST", token: a.token });
        assert.strictEqual(signedOut.status, 204);

        const afterSignOut = yield* send("/session", { token: a.token });
        assert.strictEqual(afterSignOut.status, 401);

        const bStillWorks = yield* send("/session", { token: b.token });
        assert.strictEqual(bStillWorks.status, 200);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect(
    "BEH-EA-086/ADR-EA-013: revoking a foreign session answers the same as an unknown id",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const router = yield* HttpRouter.HttpRouter;
          const mine = yield* sessions.issue({ userId });
          const foreign = yield* sessions.issue({ userId: otherUserId });

          const revoke = (targetId: string, token: Redacted.Redacted<string>) =>
            router.asHttpEffect().pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request("http://localhost/session/revoke", {
                    method: "POST",
                    headers: { ...cookieHeader(token), "content-type": "application/json" },
                    body: JSON.stringify({ id: targetId }),
                  }),
                ),
              ),
            );

          const revokeForeign = yield* revoke(foreign.session.id, mine.token);
          assert.strictEqual(revokeForeign.status, 404);
          const foreignBody = (yield* jsonBody(revokeForeign)) as { _tag: string };

          const revokeUnknown = yield* revoke("00000000-0000-0000-0000-000000000000", mine.token);
          assert.strictEqual(revokeUnknown.status, 404);
          const unknownBody = (yield* jsonBody(revokeUnknown)) as { _tag: string };

          assert.strictEqual(foreignBody._tag, unknownBody._tag);

          // `mine`'s own session is untouched by either failed attempt.
          const stillWorks = yield* router
            .asHttpEffect()
            .pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request("http://localhost/session", { headers: cookieHeader(mine.token) }),
                ),
              ),
            );
          assert.strictEqual(stillWorks.status, 200);
        }),
      ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("BEH-EA-031: revoking one's own other session succeeds and it stops working", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const current = yield* sessions.issue({ userId });
        const other = yield* sessions.issue({ userId });

        const revokeResponse = yield* router.asHttpEffect().pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/session/revoke", {
                method: "POST",
                headers: { ...cookieHeader(current.token), "content-type": "application/json" },
                body: JSON.stringify({ id: other.session.id }),
              }),
            ),
          ),
        );
        assert.strictEqual(revokeResponse.status, 204);

        const otherResponse = yield* router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/session", { headers: cookieHeader(other.token) }),
              ),
            ),
          );
        assert.strictEqual(otherResponse.status, 401);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("BEH-EA-054/031: revokeOthers revokes every other session but the current one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const a = yield* sessions.issue({ userId });
        const b = yield* sessions.issue({ userId });

        const send = (path: string, token: Redacted.Redacted<string>) =>
          router.asHttpEffect().pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`http://localhost${path}`, {
                  method: "POST",
                  headers: cookieHeader(token),
                }),
              ),
            ),
          );

        const revokeOthers = yield* send("/session/revoke-others", a.token);
        assert.strictEqual(revokeOthers.status, 204);

        const bResponse = yield* router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/session", { headers: cookieHeader(b.token) }),
              ),
            ),
          );
        assert.strictEqual(bResponse.status, 401);

        const aResponse = yield* router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/session", { headers: cookieHeader(a.token) }),
              ),
            ),
          );
        assert.strictEqual(aResponse.status, 200);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );
});

// CSS-002: pre-response handlers only run under `HttpEffect.toHandled`, so
// these tests drive the router the way a real server does and read the
// cookies of the response actually written.
const sendHandled = (
  path: string,
  options: {
    readonly method: string;
    readonly token: Redacted.Redacted<string>;
    readonly body?: unknown;
  },
) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    let written: HttpServerResponse.HttpServerResponse | undefined;
    yield* HttpEffect.toHandled(router.asHttpEffect(), (_request, response) =>
      Effect.sync(() => {
        written = response;
      }),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://localhost${path}`, {
            method: options.method,
            headers: {
              ...cookieHeader(options.token),
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          }),
        ),
      ),
    );
    if (written === undefined) return yield* Effect.die("no response was written");
    return written;
  });

const assertSessionCookieExpired = (response: HttpServerResponse.HttpServerResponse) => {
  const cookie = Cookies.get(response.cookies, Sessions.SESSION_COOKIE_NAME);
  assert.isTrue(Option.isSome(cookie), "the session cookie must be expired on this response");
  if (Option.isNone(cookie)) return;
  assert.strictEqual(cookie.value.value, "");
  assert.strictEqual(cookie.value.options?.maxAge, 0);
  assert.strictEqual(cookie.value.options?.path, "/");
  assert.isTrue(cookie.value.options?.secure);
  assert.isTrue(cookie.value.options?.httpOnly);
  assert.strictEqual(cookie.value.options?.sameSite, "strict");
};

describe("AuthHttp + Session: self-ending endpoints expire the cookie (CSS-002)", () => {
  it.effect("POST /session/sign-out expires __Host-session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* sendHandled("/session/sign-out", { method: "POST", token });
        assert.strictEqual(response.status, 204);
        assertSessionCookieExpired(response);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  // TIR-008: sign-out and account deletion are audited, not silent.
  it.effect("POST /session/sign-out records a signOut auth.session.revoked in AuditLog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const audit = yield* AuditLog.AuditLog;
        const { token, session } = yield* sessions.issue({ userId });
        yield* sendHandled("/session/sign-out", { method: "POST", token });
        const rows = yield* audit.list({ eventTag: "auth.session.revoked" });
        assert.strictEqual(rows.length, 1);
        const payload = rows[0]?.payload as { reason: string; sessionId: string; scope: string };
        assert.strictEqual(payload.reason, "signOut");
        assert.strictEqual(payload.sessionId, session.id);
        assert.strictEqual(payload.scope, "one");
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("POST /session/revoke-all expires __Host-session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* sendHandled("/session/revoke-all", { method: "POST", token });
        assert.strictEqual(response.status, 204);
        assertSessionCookieExpired(response);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("POST /session/revoke with the caller's own id expires the cookie", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token, session } = yield* sessions.issue({ userId });
        const response = yield* sendHandled("/session/revoke", {
          method: "POST",
          token,
          body: { id: session.id },
        });
        assert.strictEqual(response.status, 204);
        assertSessionCookieExpired(response);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("revoking a different session does NOT expire the caller's cookie", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const current = yield* sessions.issue({ userId });
        const other = yield* sessions.issue({ userId });
        const response = yield* sendHandled("/session/revoke", {
          method: "POST",
          token: current.token,
          body: { id: other.session.id },
        });
        assert.strictEqual(response.status, 204);
        assert.isTrue(Option.isNone(Cookies.get(response.cookies, Sessions.SESSION_COOKIE_NAME)));
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("DELETE /user expires __Host-session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "delete-me@example.com" },
          name: "Del",
        });
        const { token } = yield* sessions.issue({ userId: user.id });
        const response = yield* sendHandled("/user", { method: "DELETE", token });
        assert.strictEqual(response.status, 204);
        assertSessionCookieExpired(response);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );
});

// CSG-005: GDPR Art. 15/20 self-service export.
describe("GET /user/export (CSG-005)", () => {
  it.effect(
    "returns the caller's user, accounts (no secrets), sessions and activity as an attachment, and audits it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const sessions = yield* Sessions.Sessions;
          const audit = yield* AuditLog.AuditLog;
          const user = yield* users.create({ identity: { _tag: "Email", email: "export-me@example.com" }, name: "Exp" });
          const other = yield* users.create({ identity: { _tag: "Email", email: "not-me@example.com" }, name: "Other" });
          yield* accounts.link({ userId: user.id, providerId: "google", subject: "sub-exp" });
          yield* accounts.link({ userId: other.id, providerId: "google", subject: "sub-other" });
          const { token } = yield* sessions.issue({ userId: user.id });

          const response = yield* sendHandled("/user/export", { method: "GET", token });

          assert.strictEqual(response.status, 200);
          assert.strictEqual(
            response.headers["content-disposition"],
            'attachment; filename="account-export.json"',
          );
          assert.strictEqual(response.headers["cache-control"], "no-store");
          const body = (yield* jsonBody(response)) as {
            readonly user: {
              readonly id: string;
              readonly identity: {
                readonly _tag: string;
                readonly email?: string;
                readonly emailVerified?: boolean;
              };
            };
            readonly accounts: ReadonlyArray<{
              readonly providerId: string;
              readonly subject: string;
            }>;
            readonly sessions: ReadonlyArray<unknown>;
            readonly activity: ReadonlyArray<{ readonly event: string }>;
            readonly sections: Record<string, unknown>;
          };
          assert.strictEqual(body.user.id, user.id);
          assert.deepStrictEqual(body.user.identity, {
            _tag: "Email",
            email: "export-me@example.com",
            emailVerified: false,
          });
          assert.deepStrictEqual(
            body.accounts.map((account) => account.subject),
            ["sub-exp"],
          );
          assert.strictEqual(body.sessions.length, 1);
          assert.isTrue(body.activity.some((row) => row.event === "auth.session.issued"));
          assert.deepStrictEqual(body.sections, {});
          // never another person's data, never a secret
          const text = JSON.stringify(body);
          assert.notInclude(text, "not-me@example.com");
          assert.notInclude(text, "secretHash");
          assert.notInclude(text, Redacted.value(token));

          const exported = yield* audit.list({ eventTag: "auth.user.dataExported" });
          assert.strictEqual(exported.length, 1);
          assert.deepStrictEqual(exported[0]?.payload, {
            _tag: "auth.user.dataExported",
            userId: user.id,
            requestedBy: "self",
          });
        }),
      ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("answers 401 without a valid session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* sendHandled("/user/export", {
          method: "GET",
          token: Redacted.make("unknown.session"),
        });
        assert.strictEqual(response.status, 401);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("is rate limited per account: the sixth export in an hour answers 429", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ identity: { _tag: "Email", email: "hammer@example.com" }, name: "H" });
        const { token } = yield* sessions.issue({ userId: user.id });
        for (let i = 0; i < 5; i += 1) {
          const ok = yield* sendHandled("/user/export", { method: "GET", token });
          assert.strictEqual(ok.status, 200);
        }
        const limited = yield* sendHandled("/user/export", { method: "GET", token });
        assert.strictEqual(limited.status, 429);
      }),
    ).pipe(Effect.provide(makeAppLayer(Sessions.layerMemory, RateLimiter.layerMemory))),
  );
});

// EHA-009: the session was revoked between the middleware's verify and the
// handler's keyed read — a typed 401 with an expired cookie, not a 500.
const VanishingSessions: typeof Sessions.layerMemory = Layer.effect(
  Sessions.Sessions,
  Effect.gen(function* () {
    const real = yield* Sessions.Sessions;
    return { ...real, findOwned: () => Effect.succeed(Option.none()) };
  }),
).pipe(Layer.provide(Sessions.layerMemory));

describe("AuthHttp + Session: a concurrently revoked current session (EHA-009)", () => {
  it.effect("GET /session answers 401 Unauthenticated and expires the cookie", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* sendHandled("/session", { method: "GET", token });
        assert.strictEqual(response.status, 401);
        assertSessionCookieExpired(response);
      }),
    ).pipe(Effect.provide(makeAppLayer(VanishingSessions))),
  );
});

describe("server handler invariants (GC-003/GC-008)", () => {
  it.effect(
    "a non-User principal reaching a required-auth group dies with HandlerInvariantViolation",
    () =>
      Effect.gen(function* () {
        const exit = yield* currentUser.pipe(
          Effect.provideService(
            Api.CurrentPrincipal,
            new Api.ApiKeyPrincipal({ ref: new Api.PrincipalRef({ type: "apikey", id: "k1" }), scopes: [] }),
          ),
          Effect.exit,
        );
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.isTrue(Cause.hasDies(exit.cause));
        const defect = Cause.squash(exit.cause);
        assert.instanceOf(defect, HandlerInvariantViolation);
        if (defect instanceof HandlerInvariantViolation) {
          assert.strictEqual(defect.invariant, "NonUserPrincipal");
        }
      }),
  );
});

describe("AuthHttp + Session: point queries never go through list (TIR-003/GC-005)", () => {
  it.effect("GET /session answers 200 even when the caller's session is absent from list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const { token, session } = yield* sessions.issue({ userId });
        const response = yield* router
          .asHttpEffect()
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/session", { headers: cookieHeader(token) }),
              ),
            ),
          );
        assert.strictEqual(response.status, 200);
        const body = (yield* jsonBody(response)) as { id: string; current: boolean };
        assert.strictEqual(body.id, session.id);
        assert.isTrue(body.current);
      }),
    ).pipe(Effect.provide(ListlessAppLayer)),
  );

  it.effect("POST /session/revoke revokes an owned session even when list omits it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const current = yield* sessions.issue({ userId });
        const other = yield* sessions.issue({ userId });
        const response = yield* router.asHttpEffect().pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/session/revoke", {
                method: "POST",
                headers: { ...cookieHeader(current.token), "content-type": "application/json" },
                body: JSON.stringify({ id: other.session.id }),
              }),
            ),
          ),
        );
        assert.strictEqual(response.status, 204);
        const failure = yield* sessions.verify(other.token).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "Sessions/NotFound");
      }),
    ).pipe(Effect.provide(ListlessAppLayer)),
  );
});

describe("AuthHttp + Session: bearer clients (MNA-008, decision 24 §2)", () => {
  it.effect("POST /session/sign-out with only a bearer token (no CSRF pair) answers 204", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* router.asHttpEffect().pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/session/sign-out", {
                method: "POST",
                headers: { authorization: `Bearer ${Redacted.value(token)}` },
              }),
            ),
          ),
        );
        assert.strictEqual(response.status, 204);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect("a cookie-authenticated POST without the CSRF pair is still rejected 403", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const { token } = yield* sessions.issue({ userId });
        const response = yield* router.asHttpEffect().pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/session/sign-out", {
                method: "POST",
                headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
              }),
            ),
          ),
        );
        assert.strictEqual(response.status, 403);
      }),
    ).pipe(Effect.provide(AppLayer)),
  );
});

describe("AuthHttp + Account (real HTTP) — shipping-gaps/09/10", () => {
  it.effect("PATCH /user updates the caller's own name; requires authentication", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const router = yield* HttpRouter.HttpRouter;
        const user = yield* users.create({
          identity: { _tag: "Email", email: "ada@example.com" },
          name: "Ada",
        });
        const issued = yield* sessions.issue({ userId: user.id });

        const patch = (token?: Redacted.Redacted<string>) =>
          router.asHttpEffect().pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/user", {
                  method: "PATCH",
                  headers: {
                    ...(token ? cookieHeader(token) : csrfHeaders()),
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ name: "Ada Lovelace" }),
                }),
              ),
            ),
          );

        const unauthenticated = yield* patch();
        assert.strictEqual(unauthenticated.status, 401);

        const response = yield* patch(issued.token);
        assert.strictEqual(response.status, 200);
        const body = (yield* jsonBody(response)) as { name: string };
        assert.strictEqual(body.name, "Ada Lovelace");

        const stored = yield* users.findById(user.id);
        assert.strictEqual(stored.name, "Ada Lovelace");
      }),
    ).pipe(Effect.provide(AppLayer)),
  );

  it.effect(
    "BAM-009/FAMS-002: PATCH /user sets the avatar (http(s) only) and the DTO carries the identity union",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const router = yield* HttpRouter.HttpRouter;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "img@example.com" },
            name: "Img",
          });
          const issued = yield* sessions.issue({ userId: user.id });

          const patch = (body: unknown) =>
            router.asHttpEffect().pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request("http://localhost/user", {
                    method: "PATCH",
                    headers: { ...cookieHeader(issued.token), "content-type": "application/json" },
                    body: JSON.stringify(body),
                  }),
                ),
              ),
            );

          const ok = yield* patch({ name: "Img", image: "https://cdn.example.com/me.png" });
          assert.strictEqual(ok.status, 200);
          const body = (yield* jsonBody(ok)) as {
            identity: { _tag: string; email?: string; emailVerified?: boolean };
            image: string | null;
          };
          assert.deepStrictEqual(body.identity, {
            _tag: "Email",
            email: "img@example.com",
            emailVerified: false,
          });
          assert.strictEqual(body.image, "https://cdn.example.com/me.png");

          // A `javascript:` URL is a payload error, never stored.
          // (This raw router has no `HttpApiSchemaError` -> 400 mapping; the point is the
          // payload never reaches `Users.updateProfile`.)
          const rejected = yield* patch({ name: "Img", image: "javascript:alert(1)" }).pipe(
            Effect.exit,
          );
          assert.strictEqual(rejected._tag, "Failure");
          assert.deepStrictEqual(
            (yield* users.findById(user.id)).image,
            Option.some("https://cdn.example.com/me.png"),
          );

          // Omitted leaves it; null clears it.
          assert.strictEqual((yield* patch({ name: "Img 2" })).status, 200);
          assert.isTrue(Option.isSome((yield* users.findById(user.id)).image));
          assert.strictEqual((yield* patch({ name: "Img 2", image: null })).status, 200);
          assert.isTrue(Option.isNone((yield* users.findById(user.id)).image));
        }),
      ).pipe(Effect.provide(AppLayer)),
  );

  it.effect(
    "DELETE /user deletes the caller's own account, its accounts, sessions, and verification tokens",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const sessions = yield* Sessions.Sessions;
          const verification = yield* Verification.Verification;
          const router = yield* HttpRouter.HttpRouter;
          const user = yield* users.create({
            identity: { _tag: "Email", email: "bo@example.com" },
            name: "Bo",
          });
          yield* accounts.link({
            userId: user.id,
            providerId: "password",
            subject: user.id,
          });
          const issued = yield* sessions.issue({ userId: user.id });
          // BCR-003 (.issues/high): a still-live token naming this same
          // user (e.g. a not-yet-consumed reset-password mail) must not
          // outlive the account it recovers.
          const verifyIdentifier = `verify-email:${user.id}`;
          const { value: verifyValue } = yield* verification.issue({
            identifier: verifyIdentifier,
            ttl: Duration.minutes(10),
            userId: user.id,
          });

          const del = router.asHttpEffect().pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("http://localhost/user", {
                  method: "DELETE",
                  headers: cookieHeader(issued.token),
                }),
              ),
            ),
          );
          const response = yield* del;
          assert.strictEqual(response.status, 204);

          // SCP-006: exactly one `auth.user.deleted`, after the commit, with no email.
          const audit = yield* AuditLog.AuditLog;
          const deleted = yield* audit.list({ eventTag: "auth.user.deleted" });
          assert.strictEqual(deleted.length, 1);
          assert.deepStrictEqual(deleted[0]?.payload, {
            _tag: "auth.user.deleted",
            userId: user.id,
            deletedBy: "self",
          });

          // CSG-001/ESA-005: every other audit row that named the user (the session issued
          // above) was pseudonymized in the same transaction — only the erasure receipt
          // above still carries the id.
          const stillNaming = yield* audit.list({ actorUserId: user.id });
          assert.deepStrictEqual(
            stillNaming.map((row) => row.payload._tag),
            ["auth.user.deleted"],
          );
          const issuedRows = yield* audit.list({ eventTag: "auth.session.issued" });
          assert.strictEqual(issuedRows.length, 1);
          assert.isFalse(JSON.stringify(issuedRows).includes(user.id));

          const stillHasUser = yield* Effect.exit(users.findById(user.id));
          assert.isTrue(stillHasUser._tag === "Failure");

          const remainingAccounts = yield* accounts.listByUser(user.id);
          assert.strictEqual(remainingAccounts.length, 0);

          // The real, correct value now fails — proof the row is gone, not
          // merely a coincidental rejection (BEH-EA-059's uniform response
          // would otherwise hide the difference).
          const verifyOutcome = yield* verification
            .consume(verifyIdentifier, verifyValue)
            .pipe(Effect.flip);
          assert.strictEqual(verifyOutcome._tag, "Verification/TokenConsumed");

          const sessionCheck = yield* router
            .asHttpEffect()
            .pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request("http://localhost/session", { headers: cookieHeader(issued.token) }),
                ),
              ),
            );
          assert.strictEqual(sessionCheck.status, 401);
        }),
      ).pipe(Effect.provide(AppLayer)),
  );
});

describe("AuthHttp (BEH-EA-085's toWebHandler serving path)", () => {
  it.effect("BEH-EA-088: an unauthenticated request maps Unauthenticated to 401", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);
      const response = yield* Effect.promise(() =>
        handler(new Request("http://localhost/session")),
      );
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("BEH-EA-084: serves generated OpenAPI JSON and Scalar docs from the same api", () =>
    Effect.gen(function* () {
      const { handler } = HttpRouter.toWebHandler(AppLayer);

      const openapi = yield* Effect.promise(() =>
        handler(new Request("http://localhost/openapi.json")),
      );
      assert.strictEqual(openapi.status, 200);
      const spec = (yield* Effect.promise(() => openapi.json())) as { paths?: unknown };
      assert.isDefined(spec.paths);

      const docs = yield* Effect.promise(() => handler(new Request("http://localhost/docs")));
      assert.strictEqual(docs.status, 200);
    }),
  );
});

describe("AuthHttp (BEH-EA-087's ManagedRuntime escape hatch)", () => {
  it.effect("serves an imperative, non-Effect-native call against the same Layer", () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(
        Sessions.layerMemory.pipe(
          Layer.provide(NodeCrypto.layer),
          Layer.provide(AuthEvents.layer),
          Layer.provide(AuditLog.layerMemory),
        ),
      );
      const { session } = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            return yield* sessions.issue({ userId });
          }),
        ),
      );
      assert.strictEqual(session.userId, userId);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );
});

describe("AuthHttp.layerRedactedHeaders (MAPS-008)", () => {
  it.effect("redacts the rotated-token header and x-jwt-token alongside Effect's defaults", () =>
    Effect.gen(function* () {
      const names = yield* Headers.CurrentRedactedNames;
      const redacted = Headers.redact(
        Headers.fromInput({
          [Api.ROTATED_TOKEN_HEADER]: "rotated-secret",
          "x-jwt-token": "jwt-secret",
          authorization: "Bearer secret",
          "x-request-id": "not-secret",
        }),
        names,
      );
      assert.isTrue(Redacted.isRedacted(redacted[Api.ROTATED_TOKEN_HEADER]));
      assert.isTrue(Redacted.isRedacted(redacted["x-jwt-token"]));
      assert.isTrue(Redacted.isRedacted(redacted["authorization"]));
      assert.strictEqual(redacted["x-request-id"], "not-secret");
    }).pipe(Effect.provide(AuthHttp.layerRedactedHeaders)),
  );

  it.effect("without the layer the rotated token would be logged verbatim", () =>
    Effect.gen(function* () {
      const names = yield* Headers.CurrentRedactedNames;
      const redacted = Headers.redact(
        Headers.fromInput({ [Api.ROTATED_TOKEN_HEADER]: "rotated-secret" }),
        names,
      );
      assert.strictEqual(redacted[Api.ROTATED_TOKEN_HEADER], "rotated-secret");
    }),
  );
});
