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
import { Migrations, Users } from "@awthaq/core";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Roles from "../src/Roles.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(Migrations.run(Roles.Roles.migrations)).pipe(
  Layer.provide(SqlLive),
);

const TestLayer = Roles.Roles.layerSql.pipe(
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

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

  it.effect("a user with no assigned roles lists empty", () =>
    Effect.gen(function* () {
      const roles = yield* Roles.Roles;
      const userId = Users.UserId("55555555-5555-5555-5555-555555555555");
      assert.deepStrictEqual(yield* roles.listRoleNames(userId), []);
    }).pipe(Effect.provide(TestLayer)),
  );
});
