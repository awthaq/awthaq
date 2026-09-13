// Shipping-gap map (.scratch/shipping-gaps), ticket 15.
//
// The real, `@effect/sql-pg`-backed counterpart to `Repositories.test.ts`'s
// SQLite suite — same `Models`/`Repositories`, same `CoreMigrations.coreMigrations`
// migrator, a real Postgres database instead of an in-memory SQLite one. Skips
// (not fails) without `EFFECT_AUTH_POSTGRES_URL` set — CI provisions a real
// Postgres service and sets it; a local run without one just proves nothing,
// rather than reporting a false failure for an environment gap.
import { PgClient } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { CoreMigrations, Models, Repositories } from "../src/index.ts";

const postgresUrl = process.env["EFFECT_AUTH_POSTGRES_URL"];

describe.skipIf(postgresUrl === undefined)("Repositories (real Postgres)", () => {
  const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });

  // Forward-only migrator with no down migration (ticket 00's own
  // finding) — each run starts from a schema this test drops and
  // recreates itself, mirroring the same DROP/CREATE-per-run pattern
  // this map's spec flagged as upstream's own (imperfect, but simplest)
  // answer to the identical problem.
  const Migrated = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS verification_reservations`;
      yield* sql`DROP TABLE IF EXISTS verification_tokens`;
      yield* sql`DROP TABLE IF EXISTS sessions`;
      yield* sql`DROP TABLE IF EXISTS accounts`;
      yield* sql`DROP TABLE IF EXISTS users`;
      yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`;
      yield* Migrator.make({})({ loader: CoreMigrations.coreMigrations });
    }),
  ).pipe(Layer.provide(SqlLive));

  const RepositoriesLive = Layer.mergeAll(
    Repositories.UsersRepositoryLive,
    Repositories.AccountsRepositoryLive,
    Repositories.SessionsRepositoryLive,
    Repositories.VerificationRepositoryLive,
    Repositories.VerificationReservationsRepositoryLive,
  ).pipe(Layer.provideMerge(SqlLive), Layer.provideMerge(Migrated));

  it.effect("migrates and round-trips a User through the real repository", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const created = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "pg@example.com", name: "PG" }),
      );
      assert.isString(created.id);
      assert.strictEqual(created.emailVerified, false);
      const found = yield* users.findById(created.id);
      assert.strictEqual(found.email, "pg@example.com");
    }).pipe(Effect.provide(RepositoriesLive)),
  );

  it.effect("enforces the (providerId, subject, issuer) unique constraint", () =>
    Effect.gen(function* () {
      const users = yield* Repositories.UsersRepository;
      const accounts = yield* Repositories.AccountsRepository;
      const user = yield* users.insert(
        yield* Models.User.insert.makeEffect({ email: "dupe@example.com", name: "Dupe" }),
      );
      const insert = yield* Models.Account.insert.makeEffect({
        userId: user.id,
        providerId: "password",
        subject: user.id,
        issuer: "",
        passwordHash: null,
        accessToken: null,
        refreshToken: null,
      });
      yield* accounts.insert(insert);
      const failure = yield* accounts.insert(insert).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "SqlError");
    }).pipe(Effect.provide(RepositoriesLive)),
  );
});
