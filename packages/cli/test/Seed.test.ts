// BEH-EA-206 (RRM-011, ECS-006, ECS-005): `seed admin` through the real domain services over a
// real SQLite database. Each CLI invocation builds the application Layer afresh, so the suite
// builds it twice per scenario against one shared client, the way two runs share a database.
import { AuditLog } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Output from "../src/Output.ts";
import * as Seed from "../src/Seed.ts";
import { configOf, passwordAndRoles } from "./support/TestApp.ts";
import { migrate, sqlApp, sqlAppWithoutRoles } from "./support/SqlApp.ts";

const Sql = SqliteClient.layer({ filename: ":memory:" });

const input = (over: Partial<Seed.SeedInput> = {}): Seed.SeedInput => ({
  email: "ops@acme.com",
  name: "Ops",
  role: "admin",
  force: false,
  password: Option.none(),
  ...over,
});

const seed = (input_: Seed.SeedInput, app: Layer.Layer<never, unknown>) =>
  Effect.gen(function* () {
    const { layer } = yield* Output.capture(false);
    return yield* Effect.exit(
      Seed.seedAdmin(configOf(passwordAndRoles, { app }), input_).pipe(Effect.provide(layer)),
    );
  });

const exitCode = <A, E>(exit: Exit.Exit<A, E>) => {
  if (!Exit.isFailure(exit)) return 0;
  const error = Exit.findErrorOption(exit);
  return error._tag === "Some" ? Runtime.getErrorExitCode(error.value) : -1;
};

/** The durable audit rows, read back through the same `AuditLog` the application publishes into. */
const auditTags = (app: ReturnType<typeof sqlApp>) =>
  AuditLog.AuditLog.use((log) => log.list()).pipe(
    Effect.map((records) => records.map((record) => record.eventTag)),
    Effect.provide(app),
  );

const withApp = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    return yield* use(sql);
  }).pipe(Effect.provide(Sql));

describe("seed admin", () => {
  it.effect("creates a verified administrator through Users and Roles and audits the grant", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        const exit = yield* seed(input(), app);
        assert.isTrue(Exit.isSuccess(exit));
        const rows = yield* sql<{ readonly email: string; readonly emailVerified: number }>`SELECT email, emailVerified FROM users`;
        assert.deepStrictEqual(rows, [{ email: "ops@acme.com", emailVerified: 1 }]);
        const held = yield* sql<{ readonly role: string }>`SELECT role FROM role_assignments`;
        assert.deepStrictEqual(held, [{ role: "admin" }]);
        const tags = yield* auditTags(app);
        assert.include(tags, "auth.admin.seeded");
        assert.include(tags, "auth.roles.assigned");
      }),
    ),
  );

  it.effect("refuses (exit 6) when an administrator exists, and audits the refusal", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        yield* seed(input(), app);
        const refused = yield* seed(input({ email: "second@acme.com", name: "Second" }), app);
        assert.strictEqual(exitCode(refused), 6);
        const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
        assert.strictEqual(users[0]?.n, 1);
        assert.include(yield* auditTags(app), "auth.admin.seedRefused");
      }),
    ),
  );

  it.effect("--force grants a second administrator and records forced=true", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        yield* seed(input(), app);
        const forced = yield* seed(input({ email: "second@acme.com", name: "Second", force: true }), app);
        assert.isTrue(Exit.isSuccess(forced));
        const holders = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM role_assignments WHERE role = 'admin'`;
        assert.strictEqual(holders[0]?.n, 2);
        const records = yield* AuditLog.AuditLog.use((log) => log.list({ eventTag: "auth.admin.seeded" })).pipe(
          Effect.provide(app),
        );
        const payloads = records.map((record) => JSON.stringify(record.payload));
        assert.isTrue(payloads.some((payload) => payload.includes('"forced":true')));
      }),
    ),
  );

  it.effect("promotes an existing account instead of creating a second one", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        yield* seed(input({ role: "editor" }), app);
        const promoted = yield* seed(input(), app);
        assert.isTrue(Exit.isSuccess(promoted));
        const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
        assert.strictEqual(users[0]?.n, 1);
        const held = yield* sql<{ readonly role: string }>`SELECT role FROM role_assignments ORDER BY role`;
        assert.deepStrictEqual(held, [{ role: "admin" }, { role: "editor" }]);
      }),
    ),
  );

  it.effect("fails RolesNotInstalled (exit 9) without the Roles plugin, writing nothing", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const exit = yield* seed(input(), sqlAppWithoutRoles(sql));
        assert.strictEqual(exitCode(exit), 9);
        const users = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM users`;
        assert.strictEqual(users[0]?.n, 0);
      }),
    ),
  );

  it.effect("rejects a role outside the catalog as a usage error", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const exit = yield* seed(input({ role: "superuser" }), sqlApp(sql));
        assert.strictEqual(exitCode(exit), 2);
      }),
    ),
  );

  it.effect("stores a hashed password credential, never the plaintext, and rejects a short one", () =>
    withApp((sql) =>
      Effect.gen(function* () {
        const app = sqlApp(sql);
        const short = yield* seed(input({ password: Option.some(Redacted.make("short")) }), app);
        assert.strictEqual(exitCode(short), 2);
        const ok = yield* seed(
          input({ password: Option.some(Redacted.make("a-long-enough-password")) }),
          app,
        );
        assert.isTrue(Exit.isSuccess(ok));
        const rows = yield* sql<{ readonly passwordHash: string | null }>`SELECT passwordHash FROM accounts WHERE providerId = 'password'`;
        assert.strictEqual(rows.length, 1);
        const hash = rows[0]?.passwordHash ?? "";
        assert.notInclude(hash, "a-long-enough-password");
        const verified = yield* PasswordHasher.PasswordHasher.use((hasher) =>
          hasher.verify(Redacted.make("a-long-enough-password"), PasswordHasher.PhcHash(hash)),
        ).pipe(Effect.provide(app));
        assert.isTrue(verified);
      }),
    ),
  );

  it.effect("fails ApplicationUnavailable (exit 9) when the module exports no application Layer", () =>
    Effect.gen(function* () {
      const { layer } = yield* Output.capture(false);
      const exit = yield* Effect.exit(
        Seed.seedAdmin(configOf(passwordAndRoles), input()).pipe(Effect.provide(layer)),
      );
      assert.strictEqual(exitCode(exit), 9);
    }),
  );
});
