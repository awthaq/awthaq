// spec/behaviors/06-domain-users-accounts.md, BEH-EA-041, BEH-EA-042.
//
// The same contract suite runs against both `Layer`s — `layerMemory` (a
// `Ref`) and `layerSql` (a real, in-memory SQLite database via
// `@effect/sql-sqlite-node`) — since `UsersShape` is the one thing callers
// depend on and both `Layer`s are meant to satisfy it identically.
import { Repositories } from "@effect-auth/sql";
import { NodeCrypto } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlClient } from "effect/unstable/sql";
import { Users } from "../src/index.ts";

const MemoryLayer = Users.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

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
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `;
    // BEH-EA-041: the uniqueness `layerSql`'s `create` relies on is this
    // real index, not an in-process check.
    yield* sql`CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`;
  }),
).pipe(Layer.provide(SqlLive));

const SqlTestLayer = Users.layerSql.pipe(
  Layer.provide(Repositories.UsersRepositoryLive),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (name: string, layer: Layer.Layer<Users.Users, unknown, never>): void => {
  describe(name, () => {
    it.effect("BEH-EA-041: email is lower-cased and case-insensitively unique", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({ email: "Ada@Example.com", name: "Ada" });
        assert.strictEqual(created.email, "ada@example.com");
        assert.strictEqual(created.emailVerified, false);

        const duplicate = yield* users
          .create({ email: "ADA@EXAMPLE.COM", name: "Ada 2" })
          .pipe(Effect.flip);
        assert.strictEqual(duplicate._tag, "EmailAlreadyExists");

        const found = yield* users.findByEmail("ada@example.com");
        assert.isTrue(Option.isSome(found));
      }).pipe(Effect.provide(layer)),
    );

    it.effect("BEH-EA-042: emailVerified only ever transitions false -> true, and stays true", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({ email: "bo@example.com", name: "Bo" });
        const verified = yield* users.verifyEmail(created.id);
        assert.strictEqual(verified.emailVerified, true);
        const verifiedAgain = yield* users.verifyEmail(created.id);
        assert.strictEqual(verifiedAgain.emailVerified, true);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("updateProfile only ever touches name, never emailVerified", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({ email: "cy@example.com", name: "Cy" });
        const updated = yield* users.updateProfile(created.id, { name: "Cy Renamed" });
        assert.strictEqual(updated.name, "Cy Renamed");
        assert.strictEqual(updated.emailVerified, false);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "findById/updateProfile/verifyEmail/delete all fail with UserNotFound for an unknown id",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const missing = Users.UserId("00000000-0000-0000-0000-000000000000");
          const notFound = yield* users.findById(missing).pipe(Effect.flip);
          assert.strictEqual(notFound._tag, "UserNotFound");
          const updateNotFound = yield* users
            .updateProfile(missing, { name: "nobody" })
            .pipe(Effect.flip);
          assert.strictEqual(updateNotFound._tag, "UserNotFound");
          const verifyNotFound = yield* users.verifyEmail(missing).pipe(Effect.flip);
          assert.strictEqual(verifyNotFound._tag, "UserNotFound");
          const deleteNotFound = yield* users.delete(missing).pipe(Effect.flip);
          assert.strictEqual(deleteNotFound._tag, "UserNotFound");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("findByEmail returns None for an unknown email", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const found = yield* users.findByEmail("nobody@example.com");
        assert.isTrue(Option.isNone(found));
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("Users (layerMemory)", MemoryLayer);
suite("Users (layerSql)", SqlTestLayer);
