// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220
// (ticket 08). spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through
// BEH-EA-088.
//
// The full `admin` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@awthaq/passkey`'s own
// `AuthHttp.test.ts`.
import { AuthEvents, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { TestAuth } from "@awthaq/test";
import * as Admin from "../src/Admin.ts";
import * as AdminApi from "../src/AdminApi.ts";
import * as ImpersonationRecords from "../src/ImpersonationRecords.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, AuthEvents.layer).pipe(
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const buildAppLayer = (canImpersonate: Admin.AdminConfigShape["canImpersonate"]) =>
  Layer.mergeAll(
    AuthHttp.routes(AdminApi.AdminApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Admin.Admin.layer),
      Layer.provide(Admin.config({ canImpersonate })),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(AdminApi.AdminApi),
  ).pipe(
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(ImpersonationRecords.layerMemory.pipe(Layer.provide(NodeCrypto.layer))),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const ORIGIN = "http://localhost:3000";

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

const buildHandler = (canImpersonate: Admin.AdminConfigShape["canImpersonate"]) => {
  const AppLayer = buildAppLayer(canImpersonate);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

  /**
   * Issues a real session directly against the same running `Sessions`
   * instance the handler itself uses (shared via `memoMap`), formatted as
   * the `__Host-session` cookie header a browser would carry — the same
   * pattern `@awthaq/passkey`'s own `AuthHttp.test.ts` documents using.
   */
  const issueSessionCookieHeader = (userId: string): Promise<string> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const sessions = yield* Sessions.Sessions;
            const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
            return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
          }).pipe(Effect.provide(context));
        }),
      ),
    );

  return { handler, issueSessionCookieHeader };
};

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

describe("AuthHttp + Admin (real HTTP)", () => {
  it.effect(
    "BEH-EA-213: a full impersonate call answers 200 with a session cookie for the target",
    () =>
      Effect.gen(function* () {
        const { handler, issueSessionCookieHeader } = buildHandler(allow);
        const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

        const response = yield* Effect.promise(() =>
          post(handler, "/admin/impersonate/target-1", { reason: "reproducing a bug" }, { cookie }),
        );
        assert.strictEqual(response.status, 200);
        assert.match(cookieFrom(response), /^__Host-session=/);
      }),
  );

  it.effect("BEH-EA-212/218: a denied gate answers 403", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler(deny);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

      const response = yield* Effect.promise(() =>
        post(handler, "/admin/impersonate/target-1", { reason: "reproducing a bug" }, { cookie }),
      );
      assert.strictEqual(response.status, 403);
    }),
  );

  it.effect("BEH-EA-213: an empty reason answers 400", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

      const response = yield* Effect.promise(() =>
        post(handler, "/admin/impersonate/target-1", { reason: "   " }, { cookie }),
      );
      assert.strictEqual(response.status, 400);
    }),
  );

  it.effect("BEH-EA-214: self-impersonation answers 400", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

      const response = yield* Effect.promise(() =>
        post(handler, "/admin/impersonate/admin-1", { reason: "test" }, { cookie }),
      );
      assert.strictEqual(response.status, 400);
    }),
  );

  it.effect("BEH-EA-214: nested impersonation answers 409", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

      const first = yield* Effect.promise(() =>
        post(handler, "/admin/impersonate/target-1", { reason: "first" }, { cookie }),
      );
      const impersonatingCookie = cookieFrom(first);

      const nested = yield* Effect.promise(() =>
        post(
          handler,
          "/admin/impersonate/target-2",
          { reason: "nested" },
          { cookie: impersonatingCookie },
        ),
      );
      assert.strictEqual(nested.status, 409);
    }),
  );

  it.effect(
    "BEH-EA-216/217: stopImpersonating and forceStop both answer 204; forceStop answers 404 once ended",
    () =>
      Effect.gen(function* () {
        const { handler, issueSessionCookieHeader } = buildHandler(allow);
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

        const started = yield* Effect.promise(() =>
          post(handler, "/admin/impersonate/target-1", { reason: "test" }, { cookie: adminCookie }),
        );
        const impersonatingCookie = cookieFrom(started);

        const stopped = yield* Effect.promise(() =>
          post(handler, "/admin/stop-impersonating", {}, { cookie: impersonatingCookie }),
        );
        assert.strictEqual(stopped.status, 204);

        const startedAgain = yield* Effect.promise(() =>
          post(
            handler,
            "/admin/impersonate/target-1",
            { reason: "test2" },
            { cookie: adminCookie },
          ),
        );
        const sessionId = cookieFrom(startedAgain).split("=")[1]?.split(".")[0];

        const forced = yield* Effect.promise(() =>
          post(handler, `/admin/force-stop/${sessionId}`, {}, { cookie: adminCookie }),
        );
        assert.strictEqual(forced.status, 204);

        const forcedAgain = yield* Effect.promise(() =>
          post(handler, `/admin/force-stop/${sessionId}`, {}, { cookie: adminCookie }),
        );
        assert.strictEqual(forcedAgain.status, 404);

        const unknown = yield* Effect.promise(() =>
          post(handler, "/admin/force-stop/does-not-exist", {}, { cookie: adminCookie }),
        );
        assert.strictEqual(unknown.status, 404);
      }),
  );

  it.effect(
    "BEH-EA-219: list answers the audit rows over real HTTP, unfiltered and with ?active=true",
    () =>
      Effect.gen(function* () {
        const { handler, issueSessionCookieHeader } = buildHandler(allow);
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));

        const started = yield* Effect.promise(() =>
          post(handler, "/admin/impersonate/target-1", { reason: "test" }, { cookie: adminCookie }),
        );
        const impersonatingCookie = cookieFrom(started);
        yield* Effect.promise(() =>
          post(handler, "/admin/stop-impersonating", {}, { cookie: impersonatingCookie }),
        );
        yield* Effect.promise(() =>
          post(
            handler,
            "/admin/impersonate/target-1",
            { reason: "test2" },
            { cookie: adminCookie },
          ),
        );

        const all = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin`, { headers: { cookie: adminCookie } })),
        );
        assert.strictEqual(all.status, 200);
        const allRows = (yield* Effect.promise(() => all.json())) as ReadonlyArray<unknown>;
        assert.strictEqual(allRows.length, 2);

        const active = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin?active=true`, { headers: { cookie: adminCookie } })),
        );
        assert.strictEqual(active.status, 200);
        const activeRows = (yield* Effect.promise(() => active.json())) as ReadonlyArray<unknown>;
        assert.strictEqual(activeRows.length, 1);
      }),
  );

  it.effect(
    "BEH-EA-084: serves generated OpenAPI JSON and Scalar docs including the admin group",
    () =>
      Effect.gen(function* () {
        const { handler } = buildHandler(allow);
        const openapi = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/openapi.json`)));
        assert.strictEqual(openapi.status, 200);
        const spec = (yield* Effect.promise(() => openapi.json())) as {
          paths: Record<string, unknown>;
        };
        assert.isTrue("/admin/impersonate/{userId}" in spec.paths);
        const docs = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/docs`)));
        assert.strictEqual(docs.status, 200);
      }),
  );
});

/**
 * BEH-EA-198/199: `runPluginContractTests` against the real `Admin` plugin —
 * manifest legality, group ids, the `admin_impersonation` table prefix, and
 * migration determinism. Mirrors `packages/test/test/runPluginContractTests.test.ts`'s
 * own use of `@awthaq/password`, adapted onto real `describe`/`it`/`assert`
 * instead of a recording framework, since this suite only needs the checks to
 * pass, not to inspect their pass/fail messages.
 */
const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => {
    throw new Error(message);
  },
};

TestAuth.runPluginContractTests(vitestFramework, () => Admin.Admin, { options: [{}] });
