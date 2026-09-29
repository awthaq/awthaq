// spec/behaviors/04-contract-stratum.md, BEH-EA-031.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// Exercises the core `session` group's real HTTP surface — `AuthHttp.routes`/
// `AuthHttp.docs` registering `@awthaq/api`'s `AuthCoreApi` with a real
// `HttpRouter`, requests built from actual `Request` objects (BEH-EA-085's
// "any host that hands the application a `Request`" path), and `httpApiStatus`
// annotations landing on the real response status (BEH-EA-088).
import { Api, AuthCore } from "@awthaq/api";
import { Accounts, AuditLog, Hooks, AuthEvents, Sessions, Users, Verification } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Account from "../src/Account.ts";
import * as Authentication from "../src/Authentication.ts";
import * as AuthHttp from "../src/AuthHttp.ts";
import * as Csrf from "../src/Csrf.ts";
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
  const token = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(token).digest("hex");
  return `${token}.${signature}`;
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

const AppLayer = Layer.mergeAll(
  AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Session.SessionHandlers),
    Layer.provide(Account.AccountHandlers),
  ),
  AuthHttp.docs(AuthCore.AuthCoreApi),
).pipe(
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provide(CsrfProtectionLive),
  // CSG-001/DRS-002: `Account.deleteUser` now runs inside a
  // `SqlTransaction` — a no-op wrapper for this in-memory composition.
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provideMerge(Sessions.layerMemory),
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
        const user = yield* users.create({ email: "ada@example.com", name: "Ada" });
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
    "DELETE /user deletes the caller's own account, its accounts, sessions, and verification tokens",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const sessions = yield* Sessions.Sessions;
          const verification = yield* Verification.Verification;
          const router = yield* HttpRouter.HttpRouter;
          const user = yield* users.create({ email: "bo@example.com", name: "Bo" });
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
          assert.strictEqual(verifyOutcome._tag, "TokenConsumed");

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
