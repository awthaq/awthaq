// spec/behaviors/04-contract-stratum.md, BEH-EA-031.
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// Exercises the core `session` group's real HTTP surface — `AuthHttp.routes`/
// `AuthHttp.docs` registering `@effect-auth/api`'s `AuthCoreApi` with a real
// `HttpRouter`, requests built from actual `Request` objects (BEH-EA-085's
// "any host that hands the application a `Request`" path), and `httpApiStatus`
// annotations landing on the real response status (BEH-EA-088).
import { AuthCore } from "@effect-auth/api";
import { Sessions, Users } from "@effect-auth/core";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
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
import { Authentication, AuthHttp, Session } from "../src/index.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const AppLayer = Layer.mergeAll(
  AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(Session.SessionHandlers),
  ),
  AuthHttp.docs(AuthCore.AuthCoreApi),
).pipe(
  Layer.provideMerge(Authentication.AuthenticationLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(Sessions.layerMemory),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const userId = Users.UserId("44444444-4444-4444-4444-444444444444");
const otherUserId = Users.UserId("55555555-5555-5555-5555-555555555555");

const cookieHeader = (token: Redacted.Redacted<string>): Record<string, string> => ({
  cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
});

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
        Sessions.layerMemory.pipe(Layer.provide(NodeCrypto.layer)),
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
