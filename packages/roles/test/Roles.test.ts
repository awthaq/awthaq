// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-138 through BEH-EA-141.
import { Api } from "@awthaq/api";
import { Users } from "@awthaq/core";
import { SubjectResolver as QadiSubjectResolver } from "@awthaq/qadi";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { anonymous, permission, role } from "@qadi/core";
import * as Roles from "../src/Roles.ts";

const projectRead = permission("project", "read");
const projectDelete = permission("project", "delete");
const editor = role({ name: "editor", permissions: [projectRead] });
const owner = role({ name: "owner", permissions: [projectDelete], inherits: [editor] });

const TestLayer = Roles.Roles.layer.pipe(Layer.provide(Roles.config([editor, owner])));

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

  it.effect("an assigned role name absent from the configured catalog is silently ignored", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const resolver = yield* QadiSubjectResolver.SubjectResolver;
      const userId = Users.UserId("33333333-3333-3333-3333-333333333333");
      yield* roles.assign(userId, "does-not-exist-in-catalog");
      const subject = yield* resolver.resolve(userPrincipal(userId));
      assert.strictEqual(subject.roles.size, 0);
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
