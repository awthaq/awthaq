// AAPS-005: the SQL twin of `UserAttributesHookMemory.test.ts` — see its header
// for why each backend is its own file.
import { Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Hooks from "../src/Hooks.ts";
import * as Users from "../src/Users.ts";

const SqlLive = SqliteClient.layer({ filename: ":memory:" });

const Migrated = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        emailVerified INTEGER NOT NULL,
        name TEXT NOT NULL,
        metadata TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `;
    yield* sql`CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`;
  }),
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
      const user = yield* users.create({ email: "hook-sql@example.com", name: "Hook" });
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
