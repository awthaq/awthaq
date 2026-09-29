// AAPS-005: the SQL twin of `UserAttributesHookMemory.test.ts` — see its header
// for why each backend is its own file.
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

// FAMS-002: the real core migrations (not a hand-copied `CREATE TABLE`), so the
// suite tracks every column and index `layerSql` depends on.
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const seen: Array<{ readonly userId: string; readonly attributes: ReadonlyArray<string> }> = [];

const TestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provide(
    Hooks.AfterUserAttributesChanged.tap((input) =>
      Effect.sync(() => {
        seen.push(input);
      }),
    ).pipe(Layer.provideMerge(Hooks.HooksLive)),
  ),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("Users.layerSql attribute-change hook (AAPS-005)", () => {
  it.effect("updateProfile announces name; verifyEmail announces emailVerified once", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const user = yield* users.create({
        identity: { _tag: "Email", email: "hook-sql@example.com" },
        name: "Hook",
      });
      assert.deepStrictEqual(seen, []);

      yield* users.updateProfile(user.id, { name: "Renamed" });
      assert.deepStrictEqual(seen, [{ userId: user.id, attributes: ["name"] }]);

      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
      assert.deepStrictEqual(seen[1], { userId: user.id, attributes: ["emailVerified"] });

      yield* users.verifyEmail(user.id);
      assert.strictEqual(seen.length, 2);
    }).pipe(Effect.provide(TestLayer)),
  );
});
