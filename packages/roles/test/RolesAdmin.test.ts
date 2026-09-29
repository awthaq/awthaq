// YL-009: role administration over HTTP, protected by qadi's Path B. The first real
// `RequirePermission` consumer in the repo: nothing here checks a permission by hand — a
// subject without `roles:manage` is refused by the guard before the handler runs.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Sessions, Users } from "@awthaq/core";
import { AuthorizationAudit, SubjectExtractor } from "@awthaq/qadi";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { EvaluationServicesNone, permission, role } from "@qadi/core";
import { RequirePermissionLive } from "@qadi/http";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Roles from "../src/Roles.ts";
import * as RolesAdmin from "../src/RolesAdmin.ts";
import * as RolesAdminApi from "../src/RolesAdminApi.ts";

const ORIGIN = "http://localhost:3000";
const CSRF_SECRET = "roles-admin-test-csrf-secret";

const editor = role({ name: "editor", permissions: [permission("project", "read")] });
const support = role({ name: "platform:support", permissions: [RolesAdminApi.rolesRead] });
const admin = role({
  name: "platform:admin",
  permissions: [RolesAdminApi.rolesManage],
  inherits: [editor],
});

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CSRF_TOKEN = (() => {
  const token = randomBytes(32).toString("hex");
  return `${token}.${createHmac("sha256", CSRF_SECRET).update(token).digest("hex")}`;
})();

// Path B: the guard resolves the subject itself (the `Roles` resolver flattens the roles),
// so no `Api.Authentication` middleware is involved on this group.
const GuardLive = RequirePermissionLive.pipe(
  Layer.provide(EvaluationServicesNone),
  Layer.provide(SubjectExtractor.SubjectExtractorLive),
  Layer.provide(Authentication.PrincipalResolverLive),
);

const AppLayer = AuthHttp.routes(RolesAdminApi.RolesAdminApi).pipe(
  Layer.provide(RolesAdmin.RolesAdmin.layer),
  Layer.provide(GuardLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(Roles.Roles.layer),
  Layer.provide(Roles.config([editor, support, admin])),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(TestServices),
  Layer.provideMerge(HttpRouter.layer),
);

const memoMap = Layer.makeMemoMapUnsafe();
const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

const withServices = <A, E>(
  effect: Effect.Effect<A, E, Roles.Roles | Sessions.Sessions | AuditLog.AuditLog>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
        return yield* effect.pipe(Effect.provide(context));
      }),
    ),
  );

/** A signed-in user holding `roleNames`, as its session cookie header. */
const signIn = (userId: string, ...roleNames: ReadonlyArray<string>): Promise<string> =>
  withServices(
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      for (const name of roleNames) yield* roles.assign(Users.UserId(userId), name);
      const sessions = yield* Sessions.Sessions;
      const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
      return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
    }),
  );

const call = (method: string, path: string, cookie?: string, body?: unknown) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: [cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`].filter(Boolean).join("; "),
        [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const USER = "11111111-1111-4111-8111-111111111111";

describe("RolesAdmin (YL-009)", () => {
  it("an anonymous caller and a subject without the permission are refused (403)", async () => {
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

  it("roles:read may look but not change", async () => {
    const reader = await signIn("33333333-3333-4333-8333-333333333333", "platform:support");
    const catalog = await call("GET", "/roles/catalog", reader);
    assert.strictEqual(catalog.status, 200);
    const names = ((await catalog.json()) as ReadonlyArray<{ name: string }>).map((r) => r.name);
    assert.deepStrictEqual(names, ["editor", "platform:support", "platform:admin"]);
    assert.strictEqual((await call("GET", `/roles/users/${USER}`, reader)).status, 200);
    const refused = await call("DELETE", `/roles/users/${USER}/assignments/editor`, reader);
    assert.strictEqual(refused.status, 403);
  });

  it("roles:manage assigns and revokes, and the audit trail names the acting admin", async () => {
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

  it("a state-changing call without a CSRF token is rejected before any permission work", async () => {
    const cookie = await signIn("66666666-6666-4666-8666-666666666666", "platform:admin");
    const res = await handler(
      new Request(`${ORIGIN}/roles/users/${USER}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    assert.strictEqual(res.status, 403);
    const held = await withServices(
      Roles.Roles.use((roles) => roles.listRoleNames(Users.UserId(USER))),
    );
    assert.deepStrictEqual(held, []);
  });

  it.effect("every endpoint declares a permission requirement (composition-time audit)", () =>
    AuthorizationAudit.auditAuthorizationAnnotations(RolesAdminApi.RolesAdminApi),
  );
});
