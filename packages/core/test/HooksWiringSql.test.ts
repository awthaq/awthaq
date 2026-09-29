// AOMS-006/BCR-004/CSG-002/THS-002 (.issues/high, wayfinder ticket 03):
// proves `Users.layerSql`'s own `delete_` genuinely consults
// `Hooks.BeforeUserDelete` — see `HooksWiringMemory.test.ts`'s own header
// comment for why this is a separate file/module rather than a second
// case in that one.
import { Repositories } from "@awthaq/sql";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as HookPoint from "../src/HookPoint.ts";
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

const TestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provide(
    Hooks.BeforeUserDelete.tap((input) =>
      input.email === "keep@example.com"
        ? Effect.fail(new HookPoint.HookAbort({ code: "LEGAL_HOLD" }))
        : Effect.succeed(input),
    ).pipe(Layer.provideMerge(Hooks.BeforeUserDelete.layer)),
  ),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

describe("Users.layerSql delete hook (BEH-EA-095)", () => {
  it.effect("a veto tap can abort a delete outright, surfaced as HookAborted", () =>
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const created = yield* users.create({ email: "keep@example.com", name: "Keep" });

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
