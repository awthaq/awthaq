// YL-009: role administration over HTTP, protected by qadi's Path B. The first real
// `RequirePermission` consumer in the repo: nothing here checks a permission by hand — a
// subject without `roles:manage` is refused by the guard before the handler runs.
import { Auth, AuditLog, Sessions, Users } from "@awthaq/core";
import { AuthorizationAudit, SubjectExtractor } from "@awthaq/qadi";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import { EvaluationServicesNone, permission, role } from "@qadi/core";
import { guardApi, PermissionRegistryLive } from "@qadi/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Roles from "../src/Roles.ts";
import * as RolesAdmin from "../src/RolesAdmin.ts";
import * as RolesAdminApi from "../src/RolesAdminApi.ts";

const ORIGIN = "http://localhost:3000";

const editor = role({ name: "editor", permissions: [permission("project", "read")] });
const support = role({ name: "platform:support", permissions: [RolesAdminApi.rolesRead] });
const admin = role({
  name: "platform:admin",
  permissions: [RolesAdminApi.rolesManage],
  inherits: [editor],
});

// Path B: the guard resolves the subject itself (the `Roles` resolver flattens the roles), so no
// `Api.Authentication` middleware is involved on this group. `SubjectExtractorLive` captures the `SubjectResolver`
// slot `Roles.layer` overrides when it is built, so the guard is built over `Roles.layer`: the same layer object the
// `Roles` plugin of the composition uses, which the memo map builds once.
const RolesConfig = Roles.config([editor, support, admin]);

const GuardLive = guardApi(RolesAdminApi.RolesAdminApi).pipe(
  Layer.provide(PermissionRegistryLive),
  Layer.provide(EvaluationServicesNone),
  Layer.provide(SubjectExtractor.SubjectExtractorLive),
  Layer.provideMerge(Roles.Roles.layer),
  Layer.provide(RolesConfig),
);

const appLayer = TestAuth.layer(Auth.make([Roles.Roles, RolesAdmin.RolesAdmin]), {
  services: Layer.merge(GuardLive, RolesConfig),
});

const serveApp = () => TestAuth.serve(appLayer, { baseUrl: ORIGIN });

const harnessOf = (app: Effect.Success<ReturnType<typeof serveApp>>) => {
  const withServices = app.run;

  /** A browser signed in as `userId` holding `roleNames` (an agent holding the session's `Set-Cookie`). */
  const signIn = async (userId: string, ...roleNames: ReadonlyArray<string>) => {
    const setCookie = await withServices(
      Effect.gen(function* () {
        const roles = yield* Roles.Roles;
        for (const name of roleNames) yield* roles.assign(Users.UserId(userId), name);
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return yield* TestAuth.sessionSetCookie(issued);
      }),
    );
    const browser = await app.agent();
    browser.cookies.receive(setCookie);
    return browser;
  };

  const call = (
    method: string,
    path: string,
    as?: Awaited<ReturnType<typeof signIn>>,
    body?: unknown,
  ) => (as ?? app).request(method, path, body === undefined ? {} : { json: body });

  return { withServices, signIn, call };
};

/** One app per test (plan 34 M3): released when `use` settles. */
const withHarness = <T>(use: (harness: ReturnType<typeof harnessOf>) => Promise<T>) =>
  TestAuth.withApp(appLayer, { baseUrl: ORIGIN }, (app) => use(harnessOf(app)));

const USER = "11111111-1111-4111-8111-111111111111";

describe("RolesAdmin (YL-009)", () => {
  it("an anonymous caller and a subject without the permission are refused (403)", async () => {
    await withHarness(async ({ call, signIn, withServices }) => {
      assert.strictEqual((await call("GET", "/roles/catalog")).status, 403);
      const plain = await signIn("22222222-2222-4222-8222-222222222222", "editor");
      assert.strictEqual((await call("GET", "/roles/catalog", plain)).status, 403);
      const denied = await call("POST", `/roles/users/${USER}/assignments`, plain, {
        role: "editor",
      });
      assert.strictEqual(denied.status, 403);
      const held = await withServices(
        Roles.Roles.use((roles) => roles.listRoleNames(Users.UserId(USER))),
      );
      assert.deepStrictEqual(held, []);
    });
  });

  it("roles:read may look but not change", async () => {
    await withHarness(async ({ call, signIn }) => {
      const reader = await signIn("33333333-3333-4333-8333-333333333333", "platform:support");
      const catalog = await call("GET", "/roles/catalog", reader);
      assert.strictEqual(catalog.status, 200);
      const names = ((await catalog.json()) as ReadonlyArray<{ name: string }>).map((r) => r.name);
      assert.deepStrictEqual(names, ["editor", "platform:support", "platform:admin"]);
      assert.strictEqual((await call("GET", `/roles/users/${USER}`, reader)).status, 200);
      const refused = await call("DELETE", `/roles/users/${USER}/assignments/editor`, reader);
      assert.strictEqual(refused.status, 403);
    });
  });

  it("roles:manage assigns and revokes, and the audit trail names the acting admin", async () => {
    await withHarness(async ({ call, signIn, withServices }) => {
      const adminId = "44444444-4444-4444-8444-444444444444";
      const cookie = await signIn(adminId, "platform:admin");
      const target = "55555555-5555-4555-8555-555555555555";

      const assigned = await call("POST", `/roles/users/${target}/assignments`, cookie, {
        role: "editor",
      });
      assert.strictEqual(assigned.status, 200);
      assert.deepStrictEqual(await assigned.json(), { userId: target, roles: ["editor"] });

      const unknown = await call("POST", `/roles/users/${target}/assignments`, cookie, {
        role: "not-a-role",
      });
      assert.strictEqual(unknown.status, 422);
      assert.strictEqual(((await unknown.json()) as { _tag: string })._tag, "UnknownRole");

      const revoked = await call("DELETE", `/roles/users/${target}/assignments/editor`, cookie);
      assert.strictEqual(revoked.status, 204);
      const after = await call("GET", `/roles/users/${target}`, cookie);
      assert.deepStrictEqual(await after.json(), { userId: target, roles: [] });

      const trail = await withServices(
        AuditLog.AuditLog.use((log) =>
          Effect.gen(function* () {
            const assignedRows = yield* log.list({ eventTag: "auth.roles.assigned" });
            const revokedRows = yield* log.list({ eventTag: "auth.roles.revoked" });
            return [...assignedRows, ...revokedRows].filter((row) =>
              JSON.stringify(row.payload).includes(target),
            );
          }),
        ),
      );
      assert.strictEqual(trail.length, 2);
      for (const row of trail) {
        assert.deepStrictEqual(row.actorUserId, Option.some(Users.UserId(adminId)));
      }
    });
  });

  it("a state-changing call without a CSRF token is rejected before any permission work", async () => {
    await withHarness(async ({ signIn, withServices }) => {
      const admin = await signIn("66666666-6666-4666-8666-666666666666", "platform:admin");
      // The browser's cookies travel; the CSRF header is blanked (a forged request).
      const res = await admin.request("POST", `/roles/users/${USER}/assignments`, {
        json: { role: "editor" },
        headers: { "x-csrf-token": "" },
      });
      assert.strictEqual(res.status, 403);
      const held = await withServices(
        Roles.Roles.use((roles) => roles.listRoleNames(Users.UserId(USER))),
      );
      assert.deepStrictEqual(held, []);
    });
  });

  it.effect("every endpoint declares a permission requirement (composition-time audit)", () =>
    AuthorizationAudit.auditAuthorizationAnnotations(RolesAdminApi.RolesAdminApi),
  );
});
