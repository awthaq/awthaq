// BAM-006 (.issues/high): proves `Roles.Roles.layerSql` genuinely persists
// role assignments — assign/revoke/listRoleNames round-trip through a real
// SQLite database migrated via this plugin's own `Migrations.run`, not a
// hand-rolled fixture, the same `packages/jwt/test/RevocationStore.test.ts`
// precedent `BAM-002`'s own resolution established for admin/organization/
// passkey. `assign` is idempotent at the database layer too (the
// `UNIQUE(userId, role)` constraint this migration declares), mirroring
// `layerMemory`'s own "assigning an already-held role name is a no-op"
// contract — the one property `Roles.test.ts`'s in-memory suite cannot
// itself prove.
import { AuditLog, AuthEvents, DataExport, Erasure, Migrations, Slots, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { permission, role } from "@qadi/core";
import { Api } from "@awthaq/api";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import * as Roles from "../src/Roles.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const SqlLive = TestSql.layer("roles_RolesSql");

const Migrated = Layer.effectDiscard(Migrations.run(Roles.Roles.migrations)).pipe(
  Layer.provide(SqlLive),
);

const editor = role({ name: "editor", permissions: [permission("project", "read")] });
const owner = role({
  name: "owner",
  permissions: [permission("project", "delete")],
  inherits: [editor],
});

// `Roles` publishes `auth.roles.assigned/revoked` (RRM-005) and validates
// assignments against the catalog (RRM-003), so it needs `AuthEvents` and a catalog.
// MA-005: a plugin layer built outside `Auth.make` (which provides one itself) needs a `SlotsRegistry`.
const CoreLive = AuthEvents.layer.pipe(
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Slots.layer),
  // CSG-001/CSG-005: the plugin contributes its erasure and export to the composition's registries.
  Layer.provideMerge(Erasure.registryLayer),
  Layer.provideMerge(DataExport.registryLayer),
);

const TestLayer = Roles.Roles.layerSql.pipe(
  Layer.provide(Roles.config([editor, owner])),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const captured: Array<{ level: string; message: unknown }> = [];
const CaptureLogs = Logger.layer([
  Logger.make((options) => {
    captured.push({ level: options.logLevel, message: options.message });
  }),
]);

describe("Roles.Roles.layerSql", () => {
  it.effect("assign persists a role assignment, listRoleNames reads it back", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("11111111-1111-1111-1111-111111111111");
      yield* roles.assign(userId, "owner");
      const names = yield* roles.listRoleNames(userId);
      assert.deepStrictEqual(names, ["owner"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("assigning an already-held role name is a no-op, not a database error", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("22222222-2222-2222-2222-222222222222");
      yield* roles.assign(userId, "owner");
      yield* roles.assign(userId, "owner");
      const names = yield* roles.listRoleNames(userId);
      assert.deepStrictEqual(names, ["owner"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("revoke removes exactly the named role, not a different user's or role's row", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userA = Users.UserId("33333333-3333-3333-3333-333333333333");
      const userB = Users.UserId("44444444-4444-4444-4444-444444444444");
      yield* roles.assign(userA, "owner");
      yield* roles.assign(userA, "editor");
      yield* roles.assign(userB, "owner");
      yield* roles.revoke(userA, "owner");
      assert.deepStrictEqual(yield* roles.listRoleNames(userA), ["editor"]);
      assert.deepStrictEqual(yield* roles.listRoleNames(userB), ["owner"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // ECS-006: `awthaq seed admin` finds an existing administrator through `holders`.
  it.effect("holders lists exactly the users holding the role", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userA = Users.UserId("66666666-6666-6666-6666-666666666666");
      const userB = Users.UserId("77777777-7777-7777-7777-777777777777");
      yield* roles.assign(userA, "owner");
      yield* roles.assign(userB, "editor");
      assert.deepStrictEqual(yield* roles.holders("owner"), [userA]);
      assert.deepStrictEqual(yield* roles.holders("nobody"), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a user with no assigned roles lists empty", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("55555555-5555-5555-5555-555555555555");
      assert.deepStrictEqual(yield* roles.listRoleNames(userId), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  // RRM-003: drift after a catalog rename is observable, not silent.
  it.effect(
    "a stored name later removed from the catalog logs a warning at resolve and is listed",
    () =>
      Effect.gen(function* () {
        const roles = yield* Roles.Roles;
        const sql = yield* SqlClient.SqlClient;
        const resolver = yield* QadiSubjectResolver.SubjectResolver;
        const userId = Users.UserId("55555555-5555-5555-5555-555555555555");
        yield* roles.assign(userId, "owner");
        // A row written around the plugin (or left behind by a catalog rename).
        yield* sql`INSERT INTO role_assignments ("userId", role) VALUES (${userId}, ${"renamed-away"})`;

        captured.length = 0;
        const subject = yield* resolver.resolve(
          new Api.UserPrincipal({
            ref: new Api.PrincipalRef({ type: "user", id: userId }),
            sessionId: "s-1",
          }),
        );
        assert.includeMembers([...subject.roles].map(String), ["owner"]);
        const warned = captured.filter(
          (entry) =>
            entry.level === "Warn" &&
            JSON.stringify(entry.message).includes("awthaq.roles.unknownAssignedRole") &&
            JSON.stringify(entry.message).includes("renamed-away"),
        );
        assert.strictEqual(warned.length, 1);

        assert.deepStrictEqual(yield* roles.listUnknownAssignments, [
          { userId, roleName: "renamed-away" },
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(TestLayer, CaptureLogs))),
  );

  it.effect("assign of a name outside the catalog fails UnknownRole and writes no row", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("66666666-6666-6666-6666-666666666666");
      const failure = yield* roles.assign(userId, "typo-role").pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Roles/UnknownRole");
      assert.deepStrictEqual(yield* roles.listRoleNames(userId), []);
    }).pipe(Effect.provide(TestLayer)),
  );

  // RRM-005: only real state changes are audited.
  it.effect("assign/revoke publish only on a real change, recording the actor", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const auditLog = yield* AuditLog.AuditLog;
      const userId = Users.UserId("77777777-7777-7777-7777-777777777777");
      const actor = Users.UserId("88888888-8888-8888-8888-888888888888");
      yield* roles.assign(userId, "owner", { actorId: actor });
      yield* roles.assign(userId, "owner", { actorId: actor });
      yield* roles.revoke(userId, "editor");
      yield* roles.revoke(userId, "owner", { actorId: actor });
      const assigned = yield* auditLog.list({ eventTag: "auth.roles.assigned" });
      const revoked = yield* auditLog.list({ eventTag: "auth.roles.revoked" });
      assert.strictEqual(assigned.length, 1);
      assert.strictEqual(revoked.length, 1);
      assert.deepStrictEqual(assigned[0]?.actorUserId, Option.some(actor));
      assert.deepStrictEqual(revoked[0]?.actorUserId, Option.some(actor));
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
