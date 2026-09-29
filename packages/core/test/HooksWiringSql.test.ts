// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high, wayfinder ticket 03):
// proves `Users.layerSql`'s own `delete_` genuinely consults
// `Hooks.BeforeUserDelete` — see `HooksWiringMemory.test.ts`'s own header
// comment for why this is a separate file/module rather than a second
// case in that one.
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as HookPoint from "../src/HookPoint.ts";
import * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// FAMS-002: the real core migrations (not a hand-copied `CREATE TABLE`), so the
// suite tracks every column and index `layerSql` depends on.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const TestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provide(Hooks.BeforeUserDelete.layer),
  Layer.provide(
    Hooks.BeforeUserDelete.tap((input) =>
      input.email === "keep@example.com"
        ? Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }))
        : Effect.succeed(input),
    ),
  ),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("Users.layerSql delete hook (BEH-EA-095)", () => {
  it.effect("a veto tap can abort a delete outright, surfaced as HookAborted", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* users.create({
        identity: { _tag: "Email", email: "keep@example.com" },
        name: "Keep",
      });

      const aborted = yield* users.delete(created.id).pipe(
        Effect.flip,
        Effect.flatMap((error) =>
          error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
        ),
      );
      assert.strictEqual(aborted.point, "auth.user.beforeDelete");
      assert.strictEqual(aborted.code, "LEGAL_HOLD");

      const still = yield* users.findById(created.id);
      assert.strictEqual(still.id, created.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});
