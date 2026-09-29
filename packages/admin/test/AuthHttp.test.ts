// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220
// (ticket 08). spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through
// BEH-EA-088.
//
// The full `admin` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@awthaq/passkey`'s own
// `AuthHttp.test.ts`.
import { Api } from "@awthaq/api";
import { AuditChain, Sessions, Users } from "@awthaq/core";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
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

// CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `admin` now also carries
// `.middleware(Api.CsrfProtection)`, so this file's real HTTP requests need
// to play the double-submit role a real browser client would — mirrors
// `packages/server/test/Csrf.test.ts`'s own `validCookieValue()`: an HMAC
// computed independently of `Csrf.ts`'s own implementation (Node's
// `node:crypto`), so a passing run exercises RFC 2104 compatibility, not
// just self-consistency with the code under test.
const CSRF_TEST_SECRET = "admin-authhttp-test-csrf-secret-padded-to-thirty-two-bytes";

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
  // CDS-006: `<iat>.<random>.<hmac(iat.random)>`. The handler under test runs on the real clock here (a web handler).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`
    : `${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`;

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Sessions.layerMemory, Users.layerMemory).pipe(
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// AR-003: the admin group sits behind `Api.AdminAuthentication`; the default just delegates.
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);

const buildAppLayer = (config: Partial<Admin.AdminConfigShape>) =>
  Layer.mergeAll(
    AuthHttp.routes(AdminApi.AdminApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Admin.Admin.layer),
      Layer.provide(Admin.config(config)),
      Layer.provide(AdminAuthenticationLive),
    ),
    AuthHttp.docs(AdminApi.AdminApi),
  ).pipe(
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      ImpersonationRecords.layerMemory.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer))),
      ),
    ),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const ORIGIN = "http://localhost:3000";

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

const buildHandler = (
  configOrGate: Partial<Admin.AdminConfigShape> | Admin.AdminConfigShape["canImpersonate"],
) => {
  const AppLayer = buildAppLayer(
    typeof configOrGate === "function" ? { canImpersonate: configOrGate } : configOrGate,
  );
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

  /**
   * IDS-003: `impersonate` now refuses a nonexistent target, so a target must be
   * a real `Users` row; resolves to its generated id.
   */
  const seedUser = (name: string): Promise<string> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* Effect.gen(function* () {
            const users = yield* Users.Users;
            const created = yield* users.create({
              identity: { _tag: "Email", email: `${name}@example.com` },
              name,
            });
            return created.id;
          }).pipe(Effect.provide(context));
        }),
      ),
    );

  return { handler, issueSessionCookieHeader, seedUser };
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
      headers: {
        "content-type": "application/json",
        ...headers,
        cookie: withCsrfCookie(headers?.["cookie"]),
        "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
      },
      body: JSON.stringify(body),
    }),
  );

const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

/**
 * APS-006: a real browser's cookie jar — one value per cookie name, every
 * `Set-Cookie` applied (an expired one deletes) — so the flow is tested with
 * browser semantics rather than by keeping the admin's raw cookie string aside.
 */
const makeJar = () => {
  const cookies = new Map<string, string>();
  return {
    /** Adds a raw `name=value` pair (a `Cookie`-header style entry). */
    set: (pair: string) => {
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    },
    has: (name: string) => cookies.has(name),
    apply: (response: Response) => {
      for (const line of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = line.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired =
          value === "" || attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
        if (expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
  };
};

describe("AuthHttp + Admin (real HTTP)", () => {
  it.effect(
    "BEH-EA-213: a full impersonate call answers 200 with a session cookie for the target",
    () =>
      Effect.gen(function* () {
        const { handler, issueSessionCookieHeader, seedUser } = buildHandler(allow);
        const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const response = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
            { reason: "reproducing a bug" },
            { cookie },
          ),
        );
        assert.strictEqual(response.status, 200);
        assert.match(cookieFrom(response), /^__Host-impersonation=/);
      }),
  );

  it.effect("BEH-EA-212/218: a denied gate answers 403", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader, seedUser } = buildHandler(deny);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const response = yield* Effect.promise(() =>
        post(
          handler,
          `/admin/impersonate/${targetId}`,
          { reason: "reproducing a bug" },
          { cookie },
        ),
      );
      assert.strictEqual(response.status, 403);
    }),
  );

  it.effect("BEH-EA-213: an empty reason answers 400", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader, seedUser } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const response = yield* Effect.promise(() =>
        post(handler, `/admin/impersonate/${targetId}`, { reason: "   " }, { cookie }),
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
      const { handler, issueSessionCookieHeader, seedUser } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const first = yield* Effect.promise(() =>
        post(handler, `/admin/impersonate/${targetId}`, { reason: "first" }, { cookie }),
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
        const { handler, issueSessionCookieHeader, seedUser } = buildHandler(allow);
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const started = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
            { reason: "test" },
            { cookie: adminCookie },
          ),
        );
        const impersonatingCookie = cookieFrom(started);

        const stopped = yield* Effect.promise(() =>
          post(handler, "/admin/stop-impersonating", {}, { cookie: impersonatingCookie }),
        );
        assert.strictEqual(stopped.status, 204);

        const startedAgain = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
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
        const { handler, issueSessionCookieHeader, seedUser } = buildHandler(allow);
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const started = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
            { reason: "test" },
            { cookie: adminCookie },
          ),
        );
        const impersonatingCookie = cookieFrom(started);
        yield* Effect.promise(() =>
          post(handler, "/admin/stop-impersonating", {}, { cookie: impersonatingCookie }),
        );
        yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
            { reason: "test2" },
            { cookie: adminCookie },
          ),
        );

        const all = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin`, { headers: { cookie: adminCookie } })),
        );
        assert.strictEqual(all.status, 200);
        type Page = { items: ReadonlyArray<{ reason: string }>; nextCursor: string | null };
        const allPage = (yield* Effect.promise(() => all.json())) as Page;
        assert.strictEqual(allPage.items.length, 2);
        assert.isNull(allPage.nextCursor);

        const active = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin?active=true`, { headers: { cookie: adminCookie } })),
        );
        assert.strictEqual(active.status, 200);
        const activePage = (yield* Effect.promise(() => active.json())) as Page;
        assert.strictEqual(activePage.items.length, 1);

        // ESS-006: keyset paging on the wire — newest first, opaque cursor, bounded limit.
        const get = (query: string) =>
          Effect.promise(() =>
            handler(new Request(`${ORIGIN}/admin${query}`, { headers: { cookie: adminCookie } })),
          );
        const first = yield* get("?limit=1");
        assert.strictEqual(first.status, 200);
        const firstPage = (yield* Effect.promise(() => first.json())) as Page;
        assert.strictEqual(firstPage.items.length, 1);
        assert.isString(firstPage.nextCursor);
        const second = yield* get(`?limit=1&cursor=${firstPage.nextCursor}`);
        assert.strictEqual(second.status, 200);
        const secondPage = (yield* Effect.promise(() => second.json())) as Page;
        assert.strictEqual(secondPage.items.length, 1);
        assert.isNull(secondPage.nextCursor);
        // Two distinct episodes, no repeat and no gap (the order between them is the
        // database's `startedAt DESC, id DESC`; both may share a millisecond here).
        assert.deepStrictEqual(
          [...firstPage.items, ...secondPage.items].map((row) => row.reason).sort(),
          ["test", "test2"],
        );

        assert.strictEqual((yield* get("?limit=0")).status, 400);
        assert.strictEqual((yield* get("?limit=201")).status, 400);
        assert.strictEqual((yield* get("?cursor=not-a-cursor")).status, 400);
      }),
  );

  it.effect(
    "BEH-EA-213/216 (APS-006): a browser cookie jar returns to the admin session after stopImpersonating",
    () =>
      Effect.gen(function* () {
        // `canManageEpisode` is the one place a request's resolved caller is observable
        // over this API — `list` evaluates it once per row as the authenticated caller.
        const callers: Array<string> = [];
        const { handler, issueSessionCookieHeader, seedUser } = buildHandler({
          canImpersonate: allow,
          canManageEpisode: ({ admin }) => {
            callers.push(admin.id);
            return Effect.succeed(true);
          },
        });
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        const jar = makeJar();
        jar.set(yield* Effect.promise(() => issueSessionCookieHeader("admin-1")));

        const started = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/impersonate/${targetId}`,
            { reason: "test" },
            { cookie: jar.header() },
          ),
        );
        assert.strictEqual(started.status, 200);
        jar.apply(started);
        // The impersonation token is a separate cookie; the admin's own is untouched.
        assert.match(started.headers.get("set-cookie") ?? "", /^__Host-impersonation=/);
        assert.isTrue(jar.has("__Host-session"));

        const asTarget = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin`, { headers: { cookie: jar.header() } })),
        );
        assert.strictEqual(asTarget.status, 200);
        assert.strictEqual(callers.at(-1), targetId);

        const stopped = yield* Effect.promise(() =>
          post(handler, "/admin/stop-impersonating", {}, { cookie: jar.header() }),
        );
        assert.strictEqual(stopped.status, 204);
        jar.apply(stopped);
        assert.isFalse(jar.has("__Host-impersonation"));

        const asAdmin = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/admin`, { headers: { cookie: jar.header() } })),
        );
        assert.strictEqual(asAdmin.status, 200);
        assert.strictEqual(callers.at(-1), "admin-1");
      }),
  );

  it.effect(
    "EP-009: GET /admin/config is denied without the gate and lists redacted configuration with it",
    () =>
      Effect.gen(function* () {
        const denied = buildHandler({});
        const deniedCookie = yield* Effect.promise(() =>
          denied.issueSessionCookieHeader("admin-1"),
        );
        const forbidden = yield* Effect.promise(() =>
          denied.handler(
            new Request(`${ORIGIN}/admin/config`, { headers: { cookie: deniedCookie } }),
          ),
        );
        assert.strictEqual(forbidden.status, 403);

        const allowed = buildHandler({ canManageUsers: () => Effect.succeed(true) });
        const cookie = yield* Effect.promise(() => allowed.issueSessionCookieHeader("admin-1"));
        const response = yield* Effect.promise(() =>
          allowed.handler(new Request(`${ORIGIN}/admin/config`, { headers: { cookie } })),
        );
        assert.strictEqual(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{
          key: string;
          entries: ReadonlyArray<{ path: string; value: string; sensitive: boolean }>;
        }>;
        assert.isTrue(body.some((item) => item.key === "awthaq/core/SessionConfig"));
        // Whatever the descriptors list, a sensitive leaf is only ever `<redacted>`.
        for (const item of body) {
          for (const entry of item.entries) {
            if (entry.sensitive) assert.strictEqual(entry.value, "<redacted>");
          }
        }
      }),
  );

  it.effect(
    "BAM-005: user and session administration over real HTTP — gated, paged, patched, revoked",
    () =>
      Effect.gen(function* () {
        const denied = buildHandler({});
        const deniedCookie = yield* Effect.promise(() =>
          denied.issueSessionCookieHeader("admin-1"),
        );
        const forbidden = yield* Effect.promise(() =>
          denied.handler(
            new Request(`${ORIGIN}/admin/users`, { headers: { cookie: deniedCookie } }),
          ),
        );
        assert.strictEqual(forbidden.status, 403);

        const { handler, issueSessionCookieHeader, seedUser } = buildHandler({
          canManageUsers: () => Effect.succeed(true),
        });
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        yield* Effect.promise(() => seedUser("target-2"));
        const send = (method: string, path: string, body?: unknown) =>
          Effect.promise(() =>
            handler(
              new Request(`${ORIGIN}${path}`, {
                method,
                headers: {
                  cookie: withCsrfCookie(adminCookie),
                  "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            ),
          );

        // Keyset paging on the wire.
        const page1 = yield* send("GET", "/admin/users?limit=1");
        assert.strictEqual(page1.status, 200);
        const body1 = (yield* Effect.promise(() => page1.json())) as {
          items: ReadonlyArray<{ id: string }>;
          nextCursor: string | null;
        };
        assert.strictEqual(body1.items.length, 1);
        assert.isString(body1.nextCursor);
        const page2 = yield* send("GET", `/admin/users?limit=1&cursor=${body1.nextCursor}`);
        const body2 = (yield* Effect.promise(() => page2.json())) as {
          items: ReadonlyArray<{ id: string }>;
          nextCursor: string | null;
        };
        assert.strictEqual(body2.items.length, 1);
        assert.notStrictEqual(body2.items[0]?.id, body1.items[0]?.id);
        assert.strictEqual((yield* send("GET", "/admin/users?limit=0")).status, 400);
        assert.strictEqual((yield* send("GET", "/admin/users?cursor=garbage")).status, 400);

        // Read, patch, 404.
        const got = yield* send("GET", `/admin/users/${targetId}`);
        assert.strictEqual(got.status, 200);
        const patched = yield* send("PATCH", `/admin/users/${targetId}`, { name: "Renamed" });
        assert.strictEqual(patched.status, 200);
        assert.strictEqual(
          ((yield* Effect.promise(() => patched.json())) as { name: string }).name,
          "Renamed",
        );
        assert.strictEqual(
          (yield* send("PATCH", `/admin/users/${targetId}`, { name: "  " })).status,
          400,
        );
        assert.strictEqual((yield* send("GET", "/admin/users/ghost")).status, 404);

        // Sessions: the target has none until issued; revoke of an unknown one is a 404.
        const sessionsList = yield* send("GET", `/admin/users/${targetId}/sessions`);
        assert.strictEqual(sessionsList.status, 200);
        assert.deepStrictEqual(yield* Effect.promise(() => sessionsList.json()), []);
        assert.strictEqual(
          (yield* send("DELETE", `/admin/users/${targetId}/sessions/none`)).status,
          404,
        );
        assert.strictEqual(
          (yield* send("DELETE", `/admin/users/${targetId}/sessions`)).status,
          204,
        );
      }),
  );

  it.effect(
    "BAM-005/SCP-001: ban and unban over real HTTP — own predicate, the banned user's session dies, unban restores",
    () =>
      Effect.gen(function* () {
        // `canManageUsers` alone does not grant banning.
        const manageOnly = buildHandler({ canManageUsers: allow });
        const manageOnlyCookie = yield* Effect.promise(() =>
          manageOnly.issueSessionCookieHeader("admin-1"),
        );
        const someone = yield* Effect.promise(() => manageOnly.seedUser("someone"));
        const refused = yield* Effect.promise(() =>
          post(manageOnly.handler, `/admin/users/${someone}/ban`, {}, { cookie: manageOnlyCookie }),
        );
        assert.strictEqual(refused.status, 403);

        const { handler, issueSessionCookieHeader, seedUser } = buildHandler({
          canManageUsers: allow,
          canBanUsers: allow,
        });
        const adminCookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        const targetCookie = yield* Effect.promise(() => issueSessionCookieHeader(targetId));
        const asTarget = () =>
          Effect.promise(() =>
            handler(new Request(`${ORIGIN}/admin/users`, { headers: { cookie: targetCookie } })),
          );
        assert.strictEqual((yield* asTarget()).status, 200);

        // A malformed expiry is refused before anything happens.
        const badUntil = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/users/${targetId}/ban`,
            { until: "tomorrow" },
            { cookie: adminCookie },
          ),
        );
        assert.strictEqual(badUntil.status, 400);
        assert.strictEqual((yield* asTarget()).status, 200);

        const banned = yield* Effect.promise(() =>
          post(
            handler,
            `/admin/users/${targetId}/ban`,
            { reason: "abuse", until: "2999-01-01T00:00:00.000Z" },
            { cookie: adminCookie },
          ),
        );
        assert.strictEqual(banned.status, 200);
        const bannedBody = (yield* Effect.promise(() => banned.json())) as {
          status: string;
          statusReason: string | null;
          suspendedUntil: string | null;
          identity: { _tag: string };
        };
        assert.strictEqual(bannedBody.status, "suspended");
        assert.strictEqual(bannedBody.statusReason, "abuse");
        assert.strictEqual(bannedBody.suspendedUntil, "2999-01-01T00:00:00.000Z");
        assert.strictEqual(bannedBody.identity._tag, "Email");
        // Every session of the target ended with the ban.
        assert.strictEqual((yield* asTarget()).status, 401);

        // The admin still resolves the banned user and reactivates them.
        const stillThere = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/admin/users/${targetId}`, { headers: { cookie: adminCookie } }),
          ),
        );
        assert.strictEqual(stillThere.status, 200);
        const unbanned = yield* Effect.promise(() =>
          post(handler, `/admin/users/${targetId}/unban`, {}, { cookie: adminCookie }),
        );
        assert.strictEqual(unbanned.status, 200);
        assert.strictEqual(
          ((yield* Effect.promise(() => unbanned.json())) as { status: string }).status,
          "active",
        );

        // An administrator cannot ban themselves; an unknown id is a 404 past the gate.
        const self = yield* Effect.promise(() =>
          post(handler, "/admin/users/admin-1/ban", {}, { cookie: adminCookie }),
        );
        assert.strictEqual(self.status, 400);
        const ghost = yield* Effect.promise(() =>
          post(handler, "/admin/users/ghost/ban", {}, { cookie: adminCookie }),
        );
        assert.strictEqual(ghost.status, 404);
      }),
  );

  it.effect("IDS-003: an unknown target answers 404 for a gate-passing admin, 403 otherwise", () =>
    Effect.gen(function* () {
      const allowed = buildHandler(allow);
      const adminCookie = yield* Effect.promise(() => allowed.issueSessionCookieHeader("admin-1"));
      const missing = yield* Effect.promise(() =>
        post(
          allowed.handler,
          "/admin/impersonate/does-not-exist",
          { reason: "x" },
          { cookie: adminCookie },
        ),
      );
      assert.strictEqual(missing.status, 404);

      const denied = buildHandler(deny);
      const deniedCookie = yield* Effect.promise(() => denied.issueSessionCookieHeader("admin-1"));
      const oracle = yield* Effect.promise(() =>
        post(
          denied.handler,
          "/admin/impersonate/does-not-exist",
          { reason: "x" },
          { cookie: deniedCookie },
        ),
      );
      assert.strictEqual(oracle.status, 403);
    }),
  );

  // The router itself caps a path param's length (RouteNotFound past ~100 chars), so
  // the schema's 255 bound is defence in depth; the observable contract is "refused,
  // never processed".
  it.effect("IDS-003/APS-009: an over-long path id is refused with a 4xx", () =>
    Effect.gen(function* () {
      const { handler, issueSessionCookieHeader } = buildHandler(allow);
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("admin-1"));
      const response = yield* Effect.promise(() =>
        post(handler, `/admin/impersonate/${"x".repeat(256)}`, { reason: "x" }, { cookie }),
      );
      assert.isTrue(response.status === 400 || response.status === 404);
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
