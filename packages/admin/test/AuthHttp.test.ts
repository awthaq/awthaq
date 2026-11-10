// spec/behaviors/27-admin-impersonation.md, BEH-EA-209 through BEH-EA-220
// (ticket 08). spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through
// BEH-EA-088.
//
// The full `admin` group exercised over a real `HttpRouter`/
// `HttpRouter.toWebHandler` — real HTTP requests/responses, real status
// codes, a real session cookie — mirroring `@awthaq/passkey`'s own
// `AuthHttp.test.ts`.
import { Auth, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CookieAssertions, TestAuth, type UserAgent } from "@awthaq/test";
import * as Admin from "../src/Admin.ts";
import * as AdminApi from "../src/AdminApi.ts";

const buildAppLayer = (config: Partial<Admin.AdminConfigShape>) =>
  TestAuth.layer(Auth.make([Admin.Admin]), {
    services: Admin.config(config),
    openapiPath: "/openapi.json",
    docsPath: "/docs",
  });

const ORIGIN = "http://localhost:3000";

const allow = () => Effect.succeed(true);
const deny = () => Effect.succeed(false);

const buildHandler = Effect.fn(function* (
  configOrGate:
    Partial<Admin.AdminConfigShape> | Admin.AdminConfigShape["canImpersonate"],
) {
  const app = yield* TestAuth.serve(
    buildAppLayer(
      typeof configOrGate === "function"
        ? { canImpersonate: configOrGate }
        : configOrGate,
    ),
    { baseUrl: ORIGIN },
  );
  const { handler } = app;

  /**
   * Issues a real session directly against the same running `Sessions` instance the handler itself uses, and
   * renders the `Set-Cookie` the server would have answered for it (under the composition's cookie config).
   */
  const issueSession = (userId: string): Promise<string> =>
    app.run(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return yield* TestAuth.sessionSetCookie(issued);
      }),
    );

  /** A fresh browser (its own cookie store, a seeded CSRF cookie) holding the session `setCookie` renders. */
  const browserWith = async (setCookie: string) => {
    const browser = await app.agent();
    assert.strictEqual(browser.cookies.receive(setCookie)._tag, "Stored");
    return browser;
  };

  /** A browser signed in as `userId` (which need not be a `Users` row: the admin gate is the predicate). */
  const signInAs = async (userId: string) =>
    browserWith(await issueSession(userId));

  /**
   * IDS-003: `impersonate` now refuses a nonexistent target, so a target must be
   * a real `Users` row; resolves to its generated id.
   */
  const seedUser = (name: string): Promise<string> =>
    app.run(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: `${name}@example.com` },
          name,
        });
        return created.id;
      }),
    );

  return { handler, issueSession, browserWith, signInAs, seedUser };
});

type Browser = UserAgent.UserAgent;

/** A JSON POST from `browser`, which sends its own cookies and echoes its CSRF cookie. */
const post = (
  browser: Browser,
  path: string,
  body: unknown,
): Promise<Response> => browser.request("POST", path, { json: body });

describe("AuthHttp + Admin (real HTTP)", () => {
  // Plan 26 Q5 (ADR-EA-047): `Sessions.issue` reads the request context, so the impersonation session records the
  // administrator's own request (it recorded nothing before, in any composition).
  it.effect(
    "an impersonation session records the administrator's address and user agent",
    () =>
      Effect.gen(function* () {
        const app = yield* TestAuth.serve(
          TestAuth.layer(Auth.make([Admin.Admin]), {
            services: Admin.config({ canImpersonate: allow }),
            clientAddress: "198.51.100.77",
          }),
          { baseUrl: ORIGIN },
        );
        const target = yield* Effect.promise(() =>
          app.run(
            Effect.flatMap(Effect.service(Users.Users), (users) =>
              users.create({
                identity: { _tag: "Email", email: "t@example.com" },
                name: "T",
              }),
            ),
          ),
        );
        const admin = yield* Effect.promise(() =>
          app.signIn("admin@example.com"),
        );
        const response = yield* Effect.promise(() =>
          admin.request("POST", `/admin/impersonate/${target.id}`, {
            json: { reason: "support ticket" },
            headers: { "user-agent": "admin-console/1" },
          }),
        );
        assert.strictEqual(response.status, 200);
        const token = admin.cookies.get("__Host-impersonation")?.value ?? "";
        const verified = yield* Effect.promise(() =>
          app.run(
            Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
              sessions.verify(Redacted.make(token)),
            ),
          ),
        );
        assert.deepStrictEqual(
          verified.session.ipAddress,
          Option.some("198.51.100.77"),
        );
        assert.deepStrictEqual(
          verified.session.userAgent,
          Option.some("admin-console/1"),
        );
      }),
  );

  it.effect(
    "BEH-EA-213: a full impersonate call answers 200 with a session cookie for the target",
    () =>
      Effect.gen(function* () {
        const { signInAs, seedUser } = yield* buildHandler(allow);
        const admin = yield* Effect.promise(() => signInAs("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const response = yield* Effect.promise(() =>
          post(admin, `/admin/impersonate/${targetId}`, {
            reason: "reproducing a bug",
          }),
        );
        assert.strictEqual(response.status, 200);
        CookieAssertions.findSetCookie(response, "__Host-impersonation");
        assert.isDefined(admin.cookies.get("__Host-impersonation"));
      }),
  );

  it.effect("BEH-EA-212/218: a denied gate answers 403", () =>
    Effect.gen(function* () {
      const { signInAs, seedUser } = yield* buildHandler(deny);
      const admin = yield* Effect.promise(() => signInAs("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const response = yield* Effect.promise(() =>
        post(admin, `/admin/impersonate/${targetId}`, {
          reason: "reproducing a bug",
        }),
      );
      assert.strictEqual(response.status, 403);
    }),
  );

  it.effect("BEH-EA-213: an empty reason answers 400", () =>
    Effect.gen(function* () {
      const { signInAs, seedUser } = yield* buildHandler(allow);
      const admin = yield* Effect.promise(() => signInAs("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const response = yield* Effect.promise(() =>
        post(admin, `/admin/impersonate/${targetId}`, { reason: "   " }),
      );
      assert.strictEqual(response.status, 400);
    }),
  );

  it.effect("BEH-EA-214: self-impersonation answers 400", () =>
    Effect.gen(function* () {
      const { signInAs } = yield* buildHandler(allow);
      const admin = yield* Effect.promise(() => signInAs("admin-1"));

      const response = yield* Effect.promise(() =>
        post(admin, "/admin/impersonate/admin-1", { reason: "test" }),
      );
      assert.strictEqual(response.status, 400);
    }),
  );

  it.effect("BEH-EA-214: nested impersonation answers 409", () =>
    Effect.gen(function* () {
      const { signInAs, seedUser } = yield* buildHandler(allow);
      const admin = yield* Effect.promise(() => signInAs("admin-1"));
      const targetId = yield* Effect.promise(() => seedUser("target-1"));

      const first = yield* Effect.promise(() =>
        post(admin, `/admin/impersonate/${targetId}`, { reason: "first" }),
      );
      assert.strictEqual(first.status, 200);
      // The browser now presents the impersonation cookie, which shadows the admin's own session.

      const nested = yield* Effect.promise(() =>
        post(admin, "/admin/impersonate/target-2", { reason: "nested" }),
      );
      assert.strictEqual(nested.status, 409);
    }),
  );

  it.effect(
    "BEH-EA-216/217: stopImpersonating and forceStop both answer 204; forceStop answers 404 once ended",
    () =>
      Effect.gen(function* () {
        const { issueSession, browserWith, seedUser } =
          yield* buildHandler(allow);
        // One admin session in two browsers: `operator` impersonates (and so presents the impersonation
        // cookie afterwards), `admin` stays the admin's own console.
        const adminSession = yield* Effect.promise(() =>
          issueSession("admin-1"),
        );
        const admin = yield* Effect.promise(() => browserWith(adminSession));
        const operator = yield* Effect.promise(() => browserWith(adminSession));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const started = yield* Effect.promise(() =>
          post(operator, `/admin/impersonate/${targetId}`, { reason: "test" }),
        );
        assert.strictEqual(started.status, 200);

        const stopped = yield* Effect.promise(() =>
          post(operator, "/admin/stop-impersonating", {}),
        );
        assert.strictEqual(stopped.status, 204);

        const startedAgain = yield* Effect.promise(() =>
          post(operator, `/admin/impersonate/${targetId}`, { reason: "test2" }),
        );
        assert.strictEqual(startedAgain.status, 200);
        const sessionId = operator.cookies
          .get("__Host-impersonation")
          ?.value.split(".")[0];

        const forced = yield* Effect.promise(() =>
          post(admin, `/admin/force-stop/${sessionId}`, {}),
        );
        assert.strictEqual(forced.status, 204);

        const forcedAgain = yield* Effect.promise(() =>
          post(admin, `/admin/force-stop/${sessionId}`, {}),
        );
        assert.strictEqual(forcedAgain.status, 404);

        const unknown = yield* Effect.promise(() =>
          post(admin, "/admin/force-stop/does-not-exist", {}),
        );
        assert.strictEqual(unknown.status, 404);
      }),
  );

  it.effect(
    "BEH-EA-219: list answers the audit rows over real HTTP, unfiltered and with ?active=true",
    () =>
      Effect.gen(function* () {
        const { issueSession, browserWith, seedUser } =
          yield* buildHandler(allow);
        const adminSession = yield* Effect.promise(() =>
          issueSession("admin-1"),
        );
        const admin = yield* Effect.promise(() => browserWith(adminSession));
        const operator = yield* Effect.promise(() => browserWith(adminSession));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));

        const started = yield* Effect.promise(() =>
          post(operator, `/admin/impersonate/${targetId}`, { reason: "test" }),
        );
        assert.strictEqual(started.status, 200);
        yield* Effect.promise(() =>
          post(operator, "/admin/stop-impersonating", {}),
        );
        yield* Effect.promise(() =>
          post(operator, `/admin/impersonate/${targetId}`, { reason: "test2" }),
        );

        const all = yield* Effect.promise(() => admin.request("GET", `/admin`));
        assert.strictEqual(all.status, 200);
        const allPage = Schema.decodeUnknownSync(AdminApi.ImpersonationPageDto)(
          yield* Effect.promise(() => all.json()),
        );
        assert.strictEqual(allPage.items.length, 2);
        assert.isNull(allPage.nextCursor);

        const active = yield* Effect.promise(() =>
          admin.request("GET", `/admin?active=true`),
        );
        assert.strictEqual(active.status, 200);
        const activePage = Schema.decodeUnknownSync(
          AdminApi.ImpersonationPageDto,
        )(yield* Effect.promise(() => active.json()));
        assert.strictEqual(activePage.items.length, 1);

        // ESS-006: keyset paging on the wire — newest first, opaque cursor, bounded limit.
        const get = (query: string) =>
          Effect.promise(() => admin.request("GET", `/admin${query}`));
        const first = yield* get("?limit=1");
        assert.strictEqual(first.status, 200);
        const firstPage = Schema.decodeUnknownSync(
          AdminApi.ImpersonationPageDto,
        )(yield* Effect.promise(() => first.json()));
        assert.strictEqual(firstPage.items.length, 1);
        assert.isNotNull(firstPage.nextCursor);
        const second = yield* get(
          `?limit=1&cursor=${Schema.encodeSync(AdminApi.CursorSchema)(firstPage.nextCursor)}`,
        );
        assert.strictEqual(second.status, 200);
        const secondPage = Schema.decodeUnknownSync(
          AdminApi.ImpersonationPageDto,
        )(yield* Effect.promise(() => second.json()));
        assert.strictEqual(secondPage.items.length, 1);
        assert.isNull(secondPage.nextCursor);
        // Two distinct episodes, no repeat and no gap (the order between them is the
        // database's `startedAt DESC, id DESC`; both may share a millisecond here).
        assert.deepStrictEqual(
          [...firstPage.items, ...secondPage.items]
            .map((row) => row.reason)
            .sort(),
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
        const { signInAs, seedUser } = yield* buildHandler({
          canImpersonate: allow,
          canManageEpisode: ({ admin }) => {
            callers.push(admin.id);
            return Effect.succeed(true);
          },
        });
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        const admin = yield* Effect.promise(() => signInAs("admin-1"));

        const started = yield* Effect.promise(() =>
          post(admin, `/admin/impersonate/${targetId}`, { reason: "test" }),
        );
        assert.strictEqual(started.status, 200);
        // The impersonation token is a separate cookie; the admin's own is untouched.
        CookieAssertions.findSetCookie(started, "__Host-impersonation");
        assert.isDefined(admin.cookies.get("__Host-impersonation"));
        assert.isDefined(admin.cookies.get("__Host-session"));

        const asTarget = yield* Effect.promise(() =>
          admin.request("GET", "/admin"),
        );
        assert.strictEqual(asTarget.status, 200);
        assert.strictEqual(callers.at(-1), targetId);

        const stopped = yield* Effect.promise(() =>
          post(admin, "/admin/stop-impersonating", {}),
        );
        assert.strictEqual(stopped.status, 204);
        assert.isUndefined(admin.cookies.get("__Host-impersonation"));

        const asAdmin = yield* Effect.promise(() =>
          admin.request("GET", "/admin"),
        );
        assert.strictEqual(asAdmin.status, 200);
        assert.strictEqual(callers.at(-1), "admin-1");
      }),
  );

  it.effect(
    "EP-009: GET /admin/config is denied without the gate and lists redacted configuration with it",
    () =>
      Effect.gen(function* () {
        const denied = yield* buildHandler({});
        const deniedAdmin = yield* Effect.promise(() =>
          denied.signInAs("admin-1"),
        );
        const forbidden = yield* Effect.promise(() =>
          deniedAdmin.request("GET", `/admin/config`),
        );
        assert.strictEqual(forbidden.status, 403);

        const allowed = yield* buildHandler({
          canManageUsers: () => Effect.succeed(true),
        });
        const admin = yield* Effect.promise(() => allowed.signInAs("admin-1"));
        const response = yield* Effect.promise(() =>
          admin.request("GET", `/admin/config`),
        );
        assert.strictEqual(response.status, 200);
        const body = Schema.decodeUnknownSync(
          Schema.Array(AdminApi.ConfigItemDto),
        )(yield* Effect.promise(() => response.json()));
        assert.isTrue(
          body.some((item) => item.key === "awthaq/core/SessionConfig"),
        );
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
        const denied = yield* buildHandler({});
        const deniedAdmin = yield* Effect.promise(() =>
          denied.signInAs("admin-1"),
        );
        const forbidden = yield* Effect.promise(() =>
          deniedAdmin.request("GET", `/admin/users`),
        );
        assert.strictEqual(forbidden.status, 403);

        const { signInAs, seedUser } = yield* buildHandler({
          canManageUsers: () => Effect.succeed(true),
        });
        const admin = yield* Effect.promise(() => signInAs("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        yield* Effect.promise(() => seedUser("target-2"));
        const send = (method: string, path: string, body?: unknown) =>
          Effect.promise(() =>
            admin.request(
              method,
              path,
              body === undefined ? {} : { json: body },
            ),
          );

        // Keyset paging on the wire.
        const page1 = yield* send("GET", "/admin/users?limit=1");
        assert.strictEqual(page1.status, 200);
        const body1 = Schema.decodeUnknownSync(AdminApi.UserPageDto)(
          yield* Effect.promise(() => page1.json()),
        );
        assert.strictEqual(body1.items.length, 1);
        assert.isNotNull(body1.nextCursor);
        const page2 = yield* send(
          "GET",
          `/admin/users?limit=1&cursor=${Schema.encodeSync(AdminApi.UserCursorSchema)(body1.nextCursor)}`,
        );
        const body2 = Schema.decodeUnknownSync(AdminApi.UserPageDto)(
          yield* Effect.promise(() => page2.json()),
        );
        assert.strictEqual(body2.items.length, 1);
        assert.notStrictEqual(body2.items[0]?.id, body1.items[0]?.id);
        assert.strictEqual(
          (yield* send("GET", "/admin/users?limit=0")).status,
          400,
        );
        assert.strictEqual(
          (yield* send("GET", "/admin/users?cursor=garbage")).status,
          400,
        );

        // Read, patch, 404.
        const got = yield* send("GET", `/admin/users/${targetId}`);
        assert.strictEqual(got.status, 200);
        const patched = yield* send("PATCH", `/admin/users/${targetId}`, {
          name: "Renamed",
        });
        assert.strictEqual(patched.status, 200);
        assert.strictEqual(
          Schema.decodeUnknownSync(AdminApi.UserDto)(
            yield* Effect.promise(() => patched.json()),
          ).name,
          "Renamed",
        );
        assert.strictEqual(
          (yield* send("PATCH", `/admin/users/${targetId}`, { name: "  " }))
            .status,
          400,
        );
        assert.strictEqual(
          (yield* send("GET", "/admin/users/ghost")).status,
          404,
        );

        // Sessions: the target has none until issued; revoke of an unknown one is a 404.
        const sessionsList = yield* send(
          "GET",
          `/admin/users/${targetId}/sessions`,
        );
        assert.strictEqual(sessionsList.status, 200);
        assert.deepStrictEqual(
          yield* Effect.promise(() => sessionsList.json()),
          [],
        );
        assert.strictEqual(
          (yield* send("DELETE", `/admin/users/${targetId}/sessions/none`))
            .status,
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
        const manageOnly = yield* buildHandler({ canManageUsers: allow });
        const manageOnlyAdmin = yield* Effect.promise(() =>
          manageOnly.signInAs("admin-1"),
        );
        const someone = yield* Effect.promise(() =>
          manageOnly.seedUser("someone"),
        );
        const refused = yield* Effect.promise(() =>
          post(manageOnlyAdmin, `/admin/users/${someone}/ban`, {}),
        );
        assert.strictEqual(refused.status, 403);

        const { signInAs, seedUser } = yield* buildHandler({
          canManageUsers: allow,
          canBanUsers: allow,
        });
        const admin = yield* Effect.promise(() => signInAs("admin-1"));
        const targetId = yield* Effect.promise(() => seedUser("target-1"));
        const targetUser = yield* Effect.promise(() => signInAs(targetId));
        const asTarget = () =>
          Effect.promise(() => targetUser.request("GET", `/admin/users`));
        assert.strictEqual((yield* asTarget()).status, 200);

        // A malformed expiry is refused before anything happens.
        const badUntil = yield* Effect.promise(() =>
          post(admin, `/admin/users/${targetId}/ban`, { until: "tomorrow" }),
        );
        assert.strictEqual(badUntil.status, 400);
        assert.strictEqual((yield* asTarget()).status, 200);

        const banned = yield* Effect.promise(() =>
          post(admin, `/admin/users/${targetId}/ban`, {
            reason: "abuse",
            until: "2999-01-01T00:00:00.000Z",
          }),
        );
        assert.strictEqual(banned.status, 200);
        const bannedBody = Schema.decodeUnknownSync(AdminApi.UserDto)(
          yield* Effect.promise(() => banned.json()),
        );
        assert.strictEqual(bannedBody.status, "suspended");
        assert.strictEqual(bannedBody.statusReason, "abuse");
        assert.strictEqual(
          bannedBody.suspendedUntil,
          "2999-01-01T00:00:00.000Z",
        );
        assert.strictEqual(bannedBody.identity._tag, "Email");
        // Every session of the target ended with the ban.
        assert.strictEqual((yield* asTarget()).status, 401);

        // The admin still resolves the banned user and reactivates them.
        const stillThere = yield* Effect.promise(() =>
          admin.request("GET", `/admin/users/${targetId}`),
        );
        assert.strictEqual(stillThere.status, 200);
        const unbanned = yield* Effect.promise(() =>
          post(admin, `/admin/users/${targetId}/unban`, {}),
        );
        assert.strictEqual(unbanned.status, 200);
        assert.strictEqual(
          Schema.decodeUnknownSync(AdminApi.UserDto)(
            yield* Effect.promise(() => unbanned.json()),
          ).status,
          "active",
        );

        // An administrator cannot ban themselves; an unknown id is a 404 past the gate.
        const self = yield* Effect.promise(() =>
          post(admin, "/admin/users/admin-1/ban", {}),
        );
        assert.strictEqual(self.status, 400);
        const ghost = yield* Effect.promise(() =>
          post(admin, "/admin/users/ghost/ban", {}),
        );
        assert.strictEqual(ghost.status, 404);
      }),
  );

  it.effect(
    "IDS-003: an unknown target answers 404 for a gate-passing admin, 403 otherwise",
    () =>
      Effect.gen(function* () {
        const allowed = yield* buildHandler(allow);
        const admin = yield* Effect.promise(() => allowed.signInAs("admin-1"));
        const missing = yield* Effect.promise(() =>
          post(admin, "/admin/impersonate/does-not-exist", { reason: "x" }),
        );
        assert.strictEqual(missing.status, 404);

        const denied = yield* buildHandler(deny);
        const deniedAdmin = yield* Effect.promise(() =>
          denied.signInAs("admin-1"),
        );
        const oracle = yield* Effect.promise(() =>
          post(deniedAdmin, "/admin/impersonate/does-not-exist", {
            reason: "x",
          }),
        );
        assert.strictEqual(oracle.status, 403);
      }),
  );

  // The router itself caps a path param's length (RouteNotFound past ~100 chars), so
  // the schema's 255 bound is defence in depth; the observable contract is "refused,
  // never processed".
  it.effect("IDS-003/APS-009: an over-long path id is refused with a 4xx", () =>
    Effect.gen(function* () {
      const { signInAs } = yield* buildHandler(allow);
      const admin = yield* Effect.promise(() => signInAs("admin-1"));
      const response = yield* Effect.promise(() =>
        post(admin, `/admin/impersonate/${"x".repeat(256)}`, { reason: "x" }),
      );
      assert.isTrue(response.status === 400 || response.status === 404);
    }),
  );

  it.effect(
    "BEH-EA-084: serves generated OpenAPI JSON and Scalar docs including the admin group",
    () =>
      Effect.gen(function* () {
        const { handler } = yield* buildHandler(allow);
        const openapi = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/openapi.json`)),
        );
        assert.strictEqual(openapi.status, 200);
        const spec = Schema.decodeUnknownSync(
          Schema.Struct({
            paths: Schema.Record(Schema.String, Schema.Unknown),
          }),
        )(yield* Effect.promise(() => openapi.json()));
        assert.isTrue("/admin/impersonate/{userId}" in spec.paths);
        const docs = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/docs`)),
        );
        assert.strictEqual(docs.status, 200);
      }),
  );
});
