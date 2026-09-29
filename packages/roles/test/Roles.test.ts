// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-138 through BEH-EA-141.
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, DataExport, Erasure, Slots, Users } from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { anonymous, permission, role } from "@qadi/core";
import * as Roles from "../src/Roles.ts";

const projectRead = permission("project", "read");
const projectDelete = permission("project", "delete");
const editor = role({ name: "editor", permissions: [projectRead] });
const owner = role({ name: "owner", permissions: [projectDelete], inherits: [editor] });

// `Roles` now publishes `auth.roles.assigned/revoked` (RRM-005), so it needs `AuthEvents`;
// `provideMerge` also exposes `AuditLog` so tests can read the durable record back.
// MA-005: a plugin layer built outside `Auth.make` (which provides one itself) needs a `SlotsRegistry`.
const CoreLive = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Slots.layer),
  // CSG-001: the plugin contributes its erasure to the composition's registry.
  Layer.provideMerge(Erasure.registryLayer),
  Layer.provideMerge(DataExport.registryLayer),
);

const layerFor = (catalog: ReadonlyArray<ReturnType<typeof role>>) =>
  Roles.Roles.layer.pipe(Layer.provide(Roles.config(catalog)), Layer.provideMerge(CoreLive));

const TestLayer = layerFor([editor, owner]);

const captured: Array<{ level: string; message: unknown }> = [];
const CaptureLogs = Logger.layer([
  Logger.make((options) => {
    captured.push({ level: options.logLevel, message: options.message });
  }),
]);

const userPrincipal = (id: string): Api.UserPrincipal =>
  new Api.UserPrincipal({ ref: new Api.PrincipalRef({ type: "user", id }), sessionId: "s-1" });

describe("Roles (SubjectResolver override)", () => {
  it.effect("BEH-EA-139: assigned roles flatten through inheritance into roles/permissions", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const userId = Users.UserId("11111111-1111-1111-1111-111111111111");
      yield* roles.assign(userId, "owner");

      const subject = yield* resolver.resolve(userPrincipal(userId));
      const roleNames = [...subject.roles].map(String);
      const permissionKeys = [...subject.permissions].map(String);

      assert.includeMembers(roleNames, ["owner", "editor"]);
      assert.includeMembers(permissionKeys, ["project:delete", "project:read"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ECS-006: holders lists exactly the users holding the role", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userA = Users.UserId("88888888-8888-8888-8888-888888888888");
      const userB = Users.UserId("99999999-9999-9999-9999-999999999999");
      yield* roles.assign(userA, "owner");
      yield* roles.assign(userB, "editor");
      assert.deepStrictEqual(yield* roles.holders("owner"), [userA]);
      assert.deepStrictEqual(yield* roles.holders("nobody"), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-137: a user with no assigned roles still resolves id-only", () =>
    Effect.gen(function* () {
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const userId = Users.UserId("22222222-2222-2222-2222-222222222222");
      const subject = yield* resolver.resolve(userPrincipal(userId));
      assert.strictEqual(subject.id, `user:${userId}`);
      assert.strictEqual(subject.roles.size, 0);
      assert.strictEqual(subject.permissions.size, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // AAPS-006 (BEH-EA-255): the Roles override keeps the session-trust attributes the default resolver attaches.
  it.effect("the Roles resolver preserves amr, authenticatedAt and aal on the subject", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const userId = Users.UserId("44444444-4444-4444-4444-444444444444");
      yield* roles.assign(userId, "owner");
      const subject = yield* resolver.resolve(
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: userId }),
          sessionId: "s-1",
          amr: ["hwk", "user"],
          authenticatedAt: 1_700_000_000,
        }),
      );
      assert.deepStrictEqual(subject.attributes["amr"], ["hwk", "user"]);
      assert.strictEqual(subject.attributes["authenticatedAt"], 1_700_000_000);
      assert.strictEqual(subject.attributes["aal"], "aal3");
    }).pipe(Effect.provide(TestLayer)),
  );

  // RRM-003 (+YL-005, TS-008): a typo'd or stale role name is loud at assign time.
  it.effect("assign of a name outside the catalog fails UnknownRole and stores nothing", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("33333333-3333-3333-3333-333333333333");
      const failure = yield* roles.assign(userId, "does-not-exist-in-catalog").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Roles/UnknownRole");
      assert.strictEqual(failure.roleName, "does-not-exist-in-catalog");
      assert.deepStrictEqual(yield* roles.listRoleNames(userId), []);
      assert.deepStrictEqual(yield* roles.listUnknownAssignments, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("revoke removes a role's permissions from subsequent resolutions", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const userId = Users.UserId("44444444-4444-4444-4444-444444444444");
      yield* roles.assign(userId, "owner");
      yield* roles.revoke(userId, "owner");
      const subject = yield* resolver.resolve(userPrincipal(userId));
      assert.strictEqual(subject.roles.size, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-143: installing Roles does not change how AnonymousPrincipal resolves", () =>
    Effect.gen(function* () {
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const subject = yield* resolver.resolve(Api.anonymousPrincipal);
      assert.deepStrictEqual(subject, anonymous);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("BEH-EA-142: installing Roles does not change how actingAs is carried", () =>
    Effect.gen(function* () {
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "55555555-5555-5555-5555-555555555555" }),
        sessionId: "s-2",
        actingAs: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
      });
      const subject = yield* resolver.resolve(principal);
      assert.deepStrictEqual(subject.attributes["actingAs"], { type: "user", id: "admin-1" });
    }).pipe(Effect.provide(TestLayer)),
  );
});

// RRM-004: a duplicate catalog name can never silently win.
describe("Roles catalog validation (RRM-004, RRM-010)", () => {
  it.effect("Roles.layer with two catalog entries named editor fails to build, naming editor", () =>
    Effect.gen(function* () {
      const other = role({ name: "editor", permissions: [projectDelete] });
      const exit = yield* Effect.exit(Layer.build(layerFor([editor, other])).pipe(Effect.scoped));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "editor");
    }),
  );

  it.effect("building Roles.layer without any catalog logs awthaq.roles.emptyCatalog", () =>
    Effect.gen(function* () {
      captured.length = 0;
      yield* Layer.build(layerFor([])).pipe(Effect.scoped);
      const warned = captured.filter(
        (entry) =>
          entry.level === "Warn" &&
          JSON.stringify(entry.message).includes("awthaq.roles.emptyCatalog"),
      );
      assert.strictEqual(warned.length, 1);
    }).pipe(Effect.provide(CaptureLogs)),
  );

  it.effect("a configured catalog does not log the empty-catalog warning", () =>
    Effect.gen(function* () {
      captured.length = 0;
      yield* Layer.build(TestLayer).pipe(Effect.scoped);
      assert.strictEqual(
        captured.filter((entry) => JSON.stringify(entry.message).includes("emptyCatalog")).length,
        0,
      );
    }).pipe(Effect.provide(CaptureLogs)),
  );
});

// RRM-005 (+PCS-003): every real global role change is durably audited with its actor.
describe("Roles audit events (RRM-005)", () => {
  it.effect("assign publishes auth.roles.assigned once; re-assign publishes nothing", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const auditLog = yield* AuditLog.AuditLog;
      const userId = Users.UserId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      const actor = Users.UserId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
      yield* roles.assign(userId, "owner", { actorId: actor });
      yield* roles.assign(userId, "owner", { actorId: actor });
      const recorded = yield* auditLog.list({ eventTag: "auth.roles.assigned" });
      assert.strictEqual(recorded.length, 1);
      assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some(actor));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("revoke publishes auth.roles.revoked for a held role, nothing for an unheld one", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const auditLog = yield* AuditLog.AuditLog;
      const userId = Users.UserId("cccccccc-cccc-cccc-cccc-cccccccccccc");
      yield* roles.revoke(userId, "owner");
      assert.strictEqual((yield* auditLog.list({ eventTag: "auth.roles.revoked" })).length, 0);
      yield* roles.assign(userId, "owner");
      yield* roles.revoke(userId, "owner");
      const recorded = yield* auditLog.list({ eventTag: "auth.roles.revoked" });
      assert.strictEqual(recorded.length, 1);
      // No actor supplied: the service is a trusted primitive, the audit row is actorless.
      assert.deepStrictEqual(recorded[0]?.actorUserId, Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );

  // CSG-001: the plugin's own erasure contribution is registered by its layer.
  it.effect("registers a `roles` erasure that revokes every role the user holds", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const registry = yield* Erasure.ErasureRegistry;
      const erased = Users.UserId("dddddddd-dddd-dddd-dddd-dddddddddddd");
      const kept = Users.UserId("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
      yield* roles.assign(erased, "owner");
      yield* roles.assign(erased, "editor");
      yield* roles.assign(kept, "editor");

      const contributions = yield* registry.contributions;
      assert.deepStrictEqual(
        contributions.map((c) => c.id),
        ["roles"],
      );
      for (const c of contributions) yield* c.erase({ userId: erased, email: "erase@example.com" });

      assert.deepStrictEqual(yield* roles.listRoleNames(erased), []);
      assert.deepStrictEqual(yield* roles.listRoleNames(kept), ["editor"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // CSG-005: the plugin's section of the data-subject export.
  it.effect("registers a `roles` export listing the user's role names", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const registry = yield* DataExport.DataExportRegistry;
      const mine = Users.UserId("f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1");
      const other = Users.UserId("f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2");
      yield* roles.assign(mine, "owner");
      yield* roles.assign(other, "editor");
      const contributions = yield* registry.contributions;
      const roleSection = contributions.find((c) => c.id === "roles");
      assert.isDefined(roleSection);
      assert.deepStrictEqual(
        yield* roleSection!.collect({ userId: mine, email: "m@example.com" }),
        { roles: ["owner"] },
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
